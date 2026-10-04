/**
 * The one-expectation-per-test-block gate: an AST-based check that
 * every `it`/`test` callback contains at most one `expect(...)` chain,
 * so a failing block names one behavior. Violations print as one
 * grep-compatible locator per block plus a once-per-invocation
 * WHY/FIX prescription; exit 0 clean, 1 violations, 2 the checker
 * itself failed (bad invocation, syntax error) — so CI and the
 * implementing agent can tell "fix the tests" from "fix the gate".
 *
 * Parser note: this gate parses with @babel/parser's TypeScript
 * plugin instead of the TypeScript compiler API it was specced for —
 * typescript@7 (the repo's dependency) no longer ships the classic
 * `createSourceFile` JS API, and its LSP-backed Program is a spawned
 * server, disproportionate for a syntax check. @babel/parser was
 * already in the dependency tree, so no package is added; the
 * counting semantics are the specced ones.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { type ParserOptions, parse } from "@babel/parser";
import type {
  ArrowFunctionExpression,
  CallExpression,
  ClassMethod,
  ClassPrivateMethod,
  FunctionDeclaration,
  FunctionExpression,
  Node,
  ObjectMethod,
} from "@babel/types";
import { terminalColors as colors, errorMessage } from "../cli/colors.ts";
import { refuseDirectExecution } from "../cli/is-main.ts";
import { repoRoot } from "../cli/shared.ts";
import { parseArgs } from "../cli/shell.ts";

/** One violating test block: where the split happens and what moves. */
export interface TestBlockViolation {
  /** Display path the block sits in (cwd-relative, grep-compatible). */
  readonly file: string;
  /** The block's start line (1-based) — the split happens there. */
  readonly line: number;
  /** The block's callee head: `it` or `test`. */
  readonly kind: string;
  /** The block's title — the first string-literal argument. */
  readonly title: string;
  /** How many expectations the block holds (always > 1 here). */
  readonly expectCount: number;
  /** Every expect's line — what gets redistributed by the split. */
  readonly expectLines: readonly number[];
}

/** The whole-tree verdict of one scan. */
export interface CheckReport {
  /** Violating blocks, sorted by file then line. */
  readonly violations: readonly TestBlockViolation[];
  /** `*.test.ts` files scanned (e2e skipped). */
  readonly files: number;
  /** Test blocks counted across those files. */
  readonly blocks: number;
}

/** One test block's lexical expectation count, before the >1 filter. */
export interface BlockExpectations {
  readonly line: number;
  readonly kind: string;
  readonly title: string;
  readonly expectLines: readonly number[];
}

/** Callee heads that open a test block; `describe` is transparent. */
const TEST_IDENTIFIERS = new Set(["it", "test"]);

/** Value-space function shapes: their bodies are out of scope for the
 *  enclosing block's count (helpers, nested blocks — counted on their
 *  own). Locally-defined helper functions are out of scope for v1. */
const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
  "ObjectMethod",
  "ClassMethod",
  "ClassPrivateMethod",
  "StaticBlock",
]);

/** The function shapes that can carry a test callback's body (a
 *  StaticBlock never can, though it still bounds the count walk). */
type FunctionShape =
  | ArrowFunctionExpression
  | FunctionDeclaration
  | FunctionExpression
  | ObjectMethod
  | ClassMethod
  | ClassPrivateMethod;

const PARSER_OPTIONS: ParserOptions = {
  sourceType: "module",
  plugins: ["typescript"],
  attachComment: false,
};

/** The once-per-invocation prescription: the rule and its why, the
 *  split procedure, the every-assertion-survives guard, and the
 *  re-run loop. Telegraphic; the wording budget's ceiling. */
const PRESCRIPTION = `
WHY  1 expect/test = 1 behavior; failure names the bug. Titles+asserts
     state outcomes ("rejects malformed invoice"), never mechanics —
     impl-only check = smell: flag it, don't encode it.
FIX  split each flagged block: one \`it\` per expect, outcome-titled; sibling
     its / nested describes / beforeEach as needed; keep EVERY assert (no
     coverage drop); re-run until clean.`;

/** The identifier a callee chain roots at, undefined otherwise —
 *  `it.each<T>(...)`, `it.each\`table\`(...)`, plain `it(...)`. */
function headName(node: Node | undefined | null): string | undefined {
  if (node === undefined || node === null) {
    return undefined;
  }

  if (node.type === "Identifier") {
    return node.name;
  }

  if (node.type === "MemberExpression") {
    return headName(node.object);
  }

  if (node.type === "TaggedTemplateExpression") {
    return headName(node.tag);
  }

  if (node.type === "CallExpression") {
    return headName(node.callee);
  }

  return undefined;
}

/** Whether the node is a CallExpression calling `it`/`test` (any
 *  `.each`/`.skip`/`.only` shape included). */
function isTestCall(node: Node): node is CallExpression {
  return (
    node.type === "CallExpression" &&
    TEST_IDENTIFIERS.has(headName(node.callee) ?? "")
  );
}

/** Whether the node opens an `expect(...)` chain: the callee is the
 *  bare identifier or one property off it (`expect.soft`). The chain
 *  counts once — later links' callees root at a call, not at the
 *  identifier, so they read as false here. */
function isExpectCall(node: Node): boolean {
  if (node.type !== "CallExpression") {
    return false;
  }

  const { callee } = node;

  return (
    (callee.type === "Identifier" && callee.name === "expect") ||
    (callee.type === "MemberExpression" &&
      callee.object.type === "Identifier" &&
      callee.object.name === "expect")
  );
}

/** Whether the node's subtree is a helper scope the enclosing block
 *  does not count. */
function isFunctionShape(node: Node): boolean {
  return FUNCTION_TYPES.has(node.type);
}

/** Whether a value is an AST node (a plain object with a type tag). */
function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string"
  );
}

/** The node's structural children, arrays flattened. */
function* childrenOf(node: Node): Generator<Node> {
  for (const value of Object.values(node)) {
    if (isNode(value)) {
      yield value;
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (isNode(item)) {
          yield item;
        }
      }
    }
  }
}

/** Expect lines lexically inside one callback body: function bodies
 *  (helpers, nested blocks) are crossed but not counted, and the
 *  walk stops at a counted expect (its arguments are helper scope). */
function collectExpectLines(
  node: Node,
  insideFunction: boolean,
  lines: number[],
): void {
  if (!insideFunction && isExpectCall(node)) {
    lines.push(node.loc?.start.line ?? 0);

    return;
  }

  const nested = insideFunction || isFunctionShape(node);

  for (const child of childrenOf(node)) {
    collectExpectLines(child, nested, lines);
  }
}

/** Every `it`/`test` call in the tree — nested blocks included; each
 *  is counted separately against its own callback. */
function collectTestCalls(node: Node, calls: CallExpression[]): void {
  if (isTestCall(node)) {
    calls.push(node);
  }

  for (const child of childrenOf(node)) {
    collectTestCalls(child, calls);
  }
}

/** The block's callback: the last function-shaped argument, undefined
 *  when the block has no body (`it.todo`, an imported test function). */
function callbackOf(call: CallExpression): Node | undefined {
  for (let index = call.arguments.length - 1; index >= 0; index--) {
    const argument = call.arguments[index];

    if (argument !== undefined && isFunctionShape(argument)) {
      return argument;
    }
  }

  return undefined;
}

/** The block's title: the first argument when it is a static string. */
function titleOf(call: CallExpression): string {
  const first = call.arguments[0];

  if (first?.type === "StringLiteral") {
    return first.value;
  }

  if (
    first?.type === "TemplateLiteral" &&
    first.expressions.length === 0 &&
    first.quasis[0] !== undefined
  ) {
    return first.quasis[0].value.cooked ?? "<dynamic>";
  }

  return "<dynamic>";
}

/** Parse one test file's source and count every block's expectations. */
export function analyzeSource(text: string): BlockExpectations[] {
  const ast = parse(text, PARSER_OPTIONS);
  const calls: CallExpression[] = [];

  collectTestCalls(ast, calls);

  return calls.map((call) => {
    const lines: number[] = [];
    const callback = callbackOf(call);

    if (callback !== undefined) {
      collectExpectLines((callback as FunctionShape).body, false, lines);
    }

    return {
      line: call.loc?.start.line ?? 0,
      kind: headName(call.callee) ?? "it",
      title: titleOf(call),
      expectLines: lines,
    };
  });
}

/** `*.test.ts` files under `root`, sorted, e2e trees skipped entirely
 *  (the e2e exemption is a ruling, not a count rule). */
async function listTestFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name === "e2e" && entry.isDirectory()) {
      continue;
    }

    const path = join(root, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listTestFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(path);
    }
  }

  return files.sort();
}

/** Scan one directory: every unit-test file parsed, every block
 *  counted; a file that does not parse fails the whole scan (the
 *  checker, not the tests, is broken). */
export async function checkTree(testsDir: string): Promise<CheckReport> {
  const files = await listTestFiles(testsDir);
  const violations: TestBlockViolation[] = [];
  let blocks = 0;

  for (const path of files) {
    const display = relative(process.cwd(), path);
    const source = await readFile(path, "utf8");
    let analyzed: BlockExpectations[];

    try {
      analyzed = analyzeSource(source);
    } catch (error) {
      throw new Error(`${display}: ${errorMessage(error)}`);
    }

    blocks += analyzed.length;

    for (const block of analyzed) {
      if (block.expectLines.length > 1) {
        violations.push({
          file: display,
          line: block.line,
          kind: block.kind,
          title: block.title,
          expectCount: block.expectLines.length,
          expectLines: block.expectLines,
        });
      }
    }
  }

  violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  return { violations, files: files.length, blocks };
}

/** One grep-compatible locator line per violating block. */
export function renderViolation(violation: TestBlockViolation): string {
  return `VIOLATION ${violation.file}:${violation.line} ${violation.kind} "${violation.title}": ${violation.expectCount} expects (${violation.expectLines.join(",")}); standard 1`;
}

/** Help text: every switch, argument, default, and exit code. */
const HELP = `Usage: check-one-expect-per-test [-h | --help] [<tests-dir>]

Enforce the testing standard "one expectation per test block": every
\`it\`/\`test\` callback holds at most one \`expect(...)\` chain, so a
failing block names one behavior. An expect(...).toBe(...) chain
counts once; \`it.each\`/\`test.each\` bodies are counted per generated
case; expects inside locally-defined helper functions are out of
scope; nested test callbacks are counted separately from their
parent; \`describe\` nesting is transparent.

  <tests-dir>   Directory scanned recursively for *.test.ts files.
                Default: the repo's tests/.
  -h, --help    Print this help and exit; no side effects.

tests/e2e/ is skipped entirely: multi-assertion end-state checks are
legitimate in long user journeys — the rule binds unit tests only.

Writes nothing. Prints one \`VIOLATION <file>:<line> ...\` locator per
violating block and the WHY/FIX prescription once, then exits 1.
A clean scan prints one ok line and exits 0. Exit 2 means the checker
itself failed (bad invocation, syntax error) — "fix the gate", not
"fix the tests". NO_COLOR disables color.`;

/** The check's outcome: exit-clean, fix-the-tests, or fix-the-gate. */
export type Verdict = 0 | 1 | 2;

/** Run the check against `testsDir` and print the verdict: 0 clean,
 *  1 violations, 2 the checker itself failed. */
export async function runCheck(testsDir: string): Promise<Verdict> {
  try {
    const report = await checkTree(testsDir);

    if (report.violations.length === 0) {
      console.log(
        colors().green(
          `ok: ${report.blocks} test blocks across ${report.files} files, 1 expectation per block`,
        ),
      );

      return 0;
    }

    for (const violation of report.violations) {
      console.log(renderViolation(violation));
    }

    console.log(PRESCRIPTION.trimStart());

    return 1;
  } catch (error) {
    console.error(
      colors().red(`check-one-expect-per-test: ${errorMessage(error)}`),
    );

    return 2;
  }
}

/** check-one-expect-per-test entry point:
 *  `check-one-expect-per-test [-h | --help] [<tests-dir>]`. */
export async function main(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const parsed = parseArgs(args, {
    positionals: {
      max: 1,
      error: (argument) => `unexpected argument: ${argument}`,
    },
  });

  if (parsed.error !== undefined) {
    console.error(colors().red(`check-one-expect-per-test: ${parsed.error}`));

    process.exitCode = 2;

    return;
  }

  process.exitCode = await runCheck(
    parsed.positional[0] ?? join(repoRoot, "tests"),
  );
}

/* v8 ignore next: covered only under direct `node src/quality/...` runs */
refuseDirectExecution(import.meta.url, "check-one-expect-per-test", "dev");
