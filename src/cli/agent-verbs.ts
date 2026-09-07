/**
 * The read verbs (issue #76, split from k-wiki.ts by the
 * dispatcher, issue #337): query, status, list, read, health —
 * served on both doors. The dispatcher has already classified the
 * door and resolved the checkout; this runner parses the verb's
 * argv, resolves the instance (the explicit -w/--wiki flag beats
 * the binding's wiki key, decision 12), and runs the verb. No verb
 * here can write to the wiki.
 */

import { join } from "node:path";
import { checkRaw, printHealthReport } from "../health/check-raw.ts";
import { runQueryCli } from "../query/query-shell.ts";
import {
  resolveWikiInstance,
  type WikiInstance,
  wikiArgError,
} from "../sync/instance.ts";
import {
  filteredLines,
  groupedLines,
  groupPages,
  isPageType,
  listablePages,
  lookupPage,
  PAGE_TYPES,
} from "../wiki/browse.ts";
import { cliFail, errorMessage } from "./colors.ts";
import { CHECKOUT_ENV, type CheckoutResolution } from "./k-wiki-binding.ts";
import { lastChangeLine, lastCommitDate } from "./last-change.ts";
import { type RunContext, runContext } from "./run-context.ts";
import { agentRunFlags, parseArgs } from "./shell.ts";

/** Human phrase for each checkout resolution origin. */
export const ORIGIN_LABELS = {
  flag: "the --checkout flag",
  env: `the ${CHECKOUT_ENV} environment variable`,
  file: ".k-wiki.json",
  cwd: "the cwd itself",
} as const;

/** What one verb run hands the runner: the resolved checkout. */
export interface AgentVerbInput {
  readonly resolution: CheckoutResolution;
  readonly home: string;
}

/** Print one usage error red on stderr and set the exit code. */
function fail(message: string): void {
  cliFail("k-wiki", message);
}

/** Print the resolved binding: origin, checkout, instance, paths,
 *  last change. Labels pad to 13 chars (issue #321). */
async function runStatus(
  resolution: CheckoutResolution,
  run: RunContext,
  instance: WikiInstance,
): Promise<void> {
  const lastCommit = await lastCommitDate(run);

  console.log(
    [
      `checkout:    ${resolution.checkout} (from ${ORIGIN_LABELS[resolution.origin]})`,
      `instance:    ${instance.name ?? "default"}`,
      `sync:        ${instance.configPath}`,
      `settings:    ${bindingSettings(resolution, instance)}`,
      `data repo:   ${run.dataRoot}`,
      `outputs:     ${instance.outputsDir}`,
      `wiki:        ${run.wikiDir}`,
      `index:       ${join(run.wikiDir, "index.md")}`,
      lastChangeLine(lastCommit, run.now()),
    ].join("\n"),
  );
}

/** The effective settings file: the binding's settings key
 *  overrides the derived one (issue #306). Exported for the
 *  write verbs — propose resolves its agent settings through the
 *  same rule (issue #340). */
export function bindingSettings(
  resolution: CheckoutResolution,
  instance: WikiInstance,
): string {
  return resolution.settings === undefined
    ? instance.settingsPath
    : join(resolution.checkout, resolution.settings);
}

/** The structured wiki listing, grouped (or filtered) by type. */
async function runList(
  wikiDir: string,
  typeFilter: string | undefined,
): Promise<void> {
  if (typeFilter !== undefined && !isPageType(typeFilter)) {
    fail(
      `unknown type ${JSON.stringify(typeFilter)}; valid types: ${PAGE_TYPES.join("|")}`,
    );

    return;
  }

  const pages = await listablePages(wikiDir);

  if (typeFilter !== undefined) {
    console.log(filteredLines(pages, typeFilter).join("\n"));

    return;
  }

  console.log(groupedLines(groupPages(pages)).join("\n"));
}

/** Print one wiki page verbatim, resolved by file name. */
async function runRead(wikiDir: string, slug: string): Promise<void> {
  const lookup = await lookupPage(wikiDir, slug);

  if (lookup.kind === "page") {
    process.stdout.write(lookup.content);

    return;
  }

  if (lookup.kind === "ambiguous") {
    fail(
      `ambiguous page name ${JSON.stringify(slug)}: ${lookup.matches.join(", ")}`,
    );

    return;
  }

  fail(
    lookup.nearMatches.length === 0
      ? `no page named ${JSON.stringify(slug)}`
      : `no page named ${JSON.stringify(slug)}; near matches: ${lookup.nearMatches.join(", ")}`,
  );
}

/** Check the bound projection (delegates to check-raw, read-only). */
async function runHealth(rawDir: string, failOnStale: boolean): Promise<void> {
  printHealthReport(await checkRaw(rawDir), "k-wiki", failOnStale);
}

/** Usage error for k-wiki read's argument count, undefined when valid. */
function readArityError(rest: readonly string[]): string | undefined {
  if (rest.length === 0) {
    return "a <slug> is required: k-wiki read <slug>";
  }

  if (rest.length > 1) {
    return "k-wiki read takes exactly one <slug> argument";
  }

  return undefined;
}

/** Usage error for a verb's argument count, undefined when valid. */
function arityErrorFor(
  verb: string,
  rest: readonly string[],
): string | undefined {
  if ((verb === "status" || verb === "health") && rest.length > 0) {
    return `k-wiki ${verb} takes no arguments (got ${JSON.stringify(rest[0])})`;
  }

  if (verb === "list" && rest.length > 1) {
    return "k-wiki list takes at most one <type> argument";
  }

  if (verb === "read") {
    return readArityError(rest);
  }

  return undefined;
}

/** Usage error for k-wiki query's question, undefined when valid. */
function queryUsageError(rest: readonly string[]): string | undefined {
  const question = rest[0] ?? "";

  if (question.trim() === "") {
    return 'a question is required: k-wiki query "<question>"';
  }

  if (rest.length > 1) {
    return `expected exactly one <question> argument, got ${rest.length}`;
  }

  return undefined;
}

/** Usage error for one read verb's arguments, undefined when
 *  valid (the verb is already stripped). */
export function agentVerbUsageError(
  verb: string,
  rest: readonly string[],
): string | undefined {
  const arityError = arityErrorFor(verb, rest);

  if (arityError !== undefined) {
    return arityError;
  }

  if (verb === "query") {
    return queryUsageError(rest);
  }

  return undefined;
}

/** Where the instance name came from, for miss errors. Exported
 *  for the write verbs — propose quotes the same source in its
 *  resolution errors (issue #340). */
export function nameSourceFor(
  resolution: CheckoutResolution,
  wikiFlag: string | undefined,
): string | undefined {
  if (wikiFlag !== undefined) {
    return "the --wiki flag";
  }

  return resolution.origin === "file" ? ".k-wiki.json" : undefined;
}

/** The instance's run context: the -w/--wiki flag (decision 12)
 *  or the binding's wiki key (issue #306) selects the config —
 *  the default when neither — and every derived path follows it. */
async function instancePaths(
  resolution: CheckoutResolution,
  home: string,
  wikiFlag: string | undefined,
): Promise<{ run: RunContext; instance: WikiInstance }> {
  const instance = await resolveWikiInstance({
    checkout: resolution.checkout,
    name: wikiFlag ?? resolution.wiki,
    home,
    nameSource: nameSourceFor(resolution, wikiFlag),
  });

  return { run: runContext({ rawDir: instance.rawDir }), instance };
}

/** Run status, list, read, or health; true when one of them ran. */
async function runReadOnlyVerb(
  verb: string,
  rest: readonly string[],
  resolution: CheckoutResolution,
  run: RunContext,
  instance: WikiInstance,
  failOnStale: boolean,
): Promise<boolean> {
  if (verb === "status") {
    await runStatus(resolution, run, instance);

    return true;
  }

  if (verb === "list") {
    await runList(run.wikiDir, rest[0]);

    return true;
  }

  if (verb === "read") {
    await runRead(run.wikiDir, rest[0] ?? "");

    return true;
  }

  if (verb === "health") {
    await runHealth(run.rawDir, failOnStale);

    return true;
  }

  return false;
}

/** Run the one LLM verb: query — the shared query shell. The
 *  settings and outputs paths follow the resolved instance; the
 *  binding's explicit settings key still wins. */
async function runQueryVerb(
  resolution: CheckoutResolution,
  run: RunContext,
  instance: WikiInstance,
  timeoutMs: number | undefined,
  question: string,
): Promise<void> {
  const wiki = instance.name === undefined ? "" : `--wiki ${instance.name} `;
  const hint = `To file this answer (human step): k-wiki wiki-query ${wiki}--file-last, run inside the checkout`;

  await runQueryCli({
    prefix: "k-wiki",
    settingsPath: bindingSettings(resolution, instance),
    rawDir: run.rawDir,
    promptsDir: join(resolution.checkout, "prompts"),
    outputsDir: instance.outputsDir,
    question,
    timeoutMs,
    hint,
  });
}

/** Run one agent-door verb (query, status, list, read, health) with
 *  its argv — the verb already stripped by the dispatcher. */
export async function runAgentVerbs(
  verb: string,
  args: readonly string[],
  input: AgentVerbInput,
): Promise<void> {
  const cli = parseArgs(args, {
    value: ["--checkout", "--timeout", "--wiki"],
    boolean: ["--fail-on-stale"],
    alias: new Map([["-w", "--wiki"]]),
  });

  if (cli.error !== undefined) {
    fail(cli.error);

    return;
  }

  const pathValues = new Map(cli.values);

  pathValues.delete("--wiki");

  const runFlags = agentRunFlags(pathValues);
  const usageError =
    wikiArgError(cli.values) ??
    runFlags.error ??
    agentVerbUsageError(verb, cli.positional);

  if (usageError !== undefined) {
    fail(usageError);

    return;
  }

  try {
    const wikiFlag = cli.values.get("--wiki");
    const { run, instance } = await instancePaths(
      input.resolution,
      input.home,
      wikiFlag,
    );
    const handled = await runReadOnlyVerb(
      verb,
      cli.positional,
      input.resolution,
      run,
      instance,
      cli.flags.has("--fail-on-stale"),
    );

    if (handled) {
      return;
    }

    await runQueryVerb(
      input.resolution,
      run,
      instance,
      runFlags.timeoutMs,
      cli.positional[0] ?? "",
    );
  } catch (error) {
    fail(errorMessage(error));
  }
}
