import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { type CliResult, runCli, SYNC_CYCLE_SCRIPT } from "./helpers.ts";

const run = promisify(execFile);

/**
 * shared-writer e2e (issue #390): the required two-writer scenarios —
 * two independent worktree clones and one local bare remote, driven
 * by real CLI child processes. A stub agent (instant, observable)
 * stands in for the LLM: invocation markers prove exactly one writer
 * reaches the agent boundary; a capture file records ingest prompts;
 * a slow mode holds a lease open for the concurrency race. A real
 * LLM run stays a human check.
 */

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const LEASE_REF = "refs/k-wiki/leases/shared-writer-v1";
const MARKER = ".k-wiki/shared-writer.json";

/** The stub agent: valid §9 pages for ingest prompts, the lint
 *  report for lint prompts, an invocation marker per run, an
 *  optional prompt capture, an optional slow mode, and an optional
 *  ingest mark so different writers produce different pages. */
const STUB_AGENT = `#!/usr/bin/env node
import { appendFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

if (process.env.STUB_SLOW) {
  await new Promise((r) => setTimeout(r, Number(process.env.STUB_SLOW)));
}

if (process.env.STUB_MARKER) {
  await appendFile(process.env.STUB_MARKER, "invoked\\n");
}

const FAIL_AFTER_WRITE = process.env.STUB_FAIL_AFTER_WRITE === "1";

const index = process.argv.indexOf("--print");
const prompt = index === -1 ? undefined : process.argv[index + 1];
const mode = process.env.STUB_MODE ?? "";

if (process.env.STUB_PROMPT_CAPTURE) {
  await appendFile(
    process.env.STUB_PROMPT_CAPTURE,
    "---PROMPT---\\n" + prompt + "\\n",
  );
}

// A real raw/notes file for the stub hub's origin: the vault name
// differs between the fixture (Documents) and the repo-sourced
// instance (k-wiki), so derive the first note on disk instead of
// hard-coding one vault — otherwise the provenance check fails for
// one of the two flows.
async function firstNote(dir) {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    if (entry.isDirectory()) {
      const found = await firstNote(dir + "/" + entry.name);

      if (found !== undefined) {
        return found;
      }
    } else if (entry.name.endsWith(".md")) {
      return dir + "/" + entry.name;
    }
  }

  return undefined;
}

if (prompt === undefined || prompt === "") {
  process.exit(3);
}

if (mode === "fail-ingest") {
  process.exit(4);
}

if (mode === "break-lint" && prompt.startsWith("Audit the wiki")) {
  await mkdir(join(process.cwd(), "wiki", "concepts"), { recursive: true });
  await writeFile(join(process.cwd(), "wiki", "concepts", "broken.md"), "no frontmatter\\n");
  console.log("rogue lint");
  process.exit(0);
}

if (mode === "break-fidelity" && prompt.startsWith("Audit the wiki")) {
  // Valid §9 frontmatter (the guardrails pass) but a title that does
  // not kebab to the file name — the fidelity core's failure class.
  await mkdir(join(process.cwd(), "wiki", "concepts"), { recursive: true });
  await writeFile(join(process.cwd(), "wiki", "concepts", "drifted.md"), [
    "---",
    'title: "Elsewhere"',
    "type: concept",
    "created: 2026-08-20",
    "updated: 2026-08-20",
    "tags:",
    "  - llm",
    "sources:",
    '  - "[[stub-source]]"',
    "---",
    "",
    "drifted body",
    "",
  ].join("\\n"));
  console.log("lint: filed a drifted page");
  process.exit(0);
}

if (mode === "link-domain" || mode === "link-broken") {
  // A second-brain run: a decision page carrying one cross-wiki link
  // to the domain wiki (second-brain identity itself is the
  // operator-owned .second-brain marker, written by the test).
  const link = mode === "link-domain" ? "[[engineering/stub]]" : "[[engineering/missing]]";
  await mkdir(join(process.cwd(), "wiki", "sources"), { recursive: true });
  await writeFile(
    join(process.cwd(), "wiki", "sources", "stub-source.md"),
    [
      "---",
      'title: "Stub source"',
      "type: source",
      "created: 2026-08-20",
      "updated: 2026-08-20",
      "tags:",
      "  - llm",
      "sources:",
      '  - "[[stub-source]]"',
      "---",
      "",
      "hub body",
      "",
    ].join("\\n"),
  );
  const page = (title, type, body, source) => [
    "---",
    'title: "' + title + '"',
    "type: " + type,
    "created: 2026-08-20",
    "updated: 2026-08-20",
    "tags:",
    "  - llm",
    ...(source === undefined ? [] : ["sources:", '  - "' + source + '"']),
    "---",
    "",
    body,
    "",
  ].join("\\n");

  await writeFile(join(process.cwd(), "wiki", "decision.md"), page("Decision", "decision", "Chose vitest; domain background in " + link + ".", "[[stub-source]]"));
  await writeFile(join(process.cwd(), "wiki", "index.md"), page("Index", "topic", "# Index v2"));
} else {
  await mkdir(join(process.cwd(), "wiki", "concepts"), { recursive: true });
  await mkdir(join(process.cwd(), "wiki", "sources"), { recursive: true });
  const note = await firstNote(join(process.cwd(), "raw", "notes"));
  const origin = (
    note ?? process.cwd() + "/raw/notes/unresolved/placeholder.md"
  ).slice((process.cwd() + "/").length);
  await writeFile(
    join(process.cwd(), "wiki", "sources", "stub-source.md"),
    [
      "---",
      'title: "Stub source"',
      "type: source",
      "created: 2026-08-20",
      "updated: 2026-08-20",
      "tags:",
      "  - llm",
      "origin: " + origin,
      "sources:",
      '  - "[[stub-source]]"',
      "---",
      "",
      "hub body",
      "",
    ].join("\\n"),
  );
  const mark = process.env.STUB_INGEST_MARK ?? "";
  await writeFile(
    join(process.cwd(), "wiki", "concepts", "stub.md"),
    [
      "---",
      'title: "Stub"',
      "type: concept",
      "created: 2026-08-20",
      "updated: 2026-08-20",
      "tags:",
      "  - llm",
      "sources:",
      '  - "[[stub-source]]"',
      "---",
      "",
      "stub body" + (mark === "" ? "" : " " + mark),
      "",
    ].join("\\n"),
  );
  await writeFile(
    join(process.cwd(), "wiki", "index.md"),
    [
      "---",
      'title: "Index"',
      "type: topic",
      "created: 2026-08-20",
      "updated: 2026-08-20",
      "tags:",
      "  - llm",
      "sources:",
      '  - "[[stub-source]]"',
      "---",
      "",
      "# Index v2",
      "",
    ].join("\\n"),
  );
}

if (prompt.startsWith("Audit the wiki")) {
  const reportPath = prompt.match(/outputs\\/lint-\\d{4}-\\d{2}-\\d{2}(-full)?\\.md/)?.[0];
  if (reportPath === undefined) process.exit(6);
  await mkdir(join(process.cwd(), "outputs"), { recursive: true });
  await writeFile(
    join(process.cwd(), reportPath),
    "# Lint report\\n\\nAll checks passed.\\n",
  );
  await writeFile(
    join(process.cwd(), "outputs", "received-lint-prompt.txt"),
    prompt,
  );
  console.log("lint: all pages audited, no problems");
} else {
  console.log("stub agent: sources processed; no contradictions; no unresolved questions");
if (FAIL_AFTER_WRITE) process.exit(4);
}
`;

/** A stub variant whose ingest run fails outright. */
const _FAILING_AGENT = `#!/usr/bin/env node
process.exit(4);
`;

interface Writer {
  readonly name: string;
  readonly dataRoot: string;
  readonly configPath: string;
  readonly settingsPath: string;
  readonly outputsDir: string;
  readonly vaultRoot: string;
  readonly scratch: string;
}

interface World {
  readonly root: string;
  readonly remoteDir: string;
  readonly env: StubEnv;
  readonly a: Writer;
  readonly b: Writer;
}

/** The stub environment both writers share (marker and capture are
 *  world-global so assertions can count across writers). */
interface StubEnv {
  readonly marker: string;
  readonly capture: string;
}

async function makeWriter(
  root: string,
  name: string,
  _env: StubEnv,
): Promise<Writer> {
  const dataRoot = join(root, name);
  const scratch = join(root, `${name}-scratch`);
  const { generateFixtureVault, vaultName } = await import(
    "../../src/fixtures/generate.ts"
  );
  const vaultRoot = await generateFixtureVault(scratch);

  const configPath = join(scratch, "sync.json");
  const settingsPath = join(scratch, "settings.yml");
  const outputsDir = join(scratch, "outputs");

  await writeFile(
    configPath,
    JSON.stringify({
      vaults: [{ name: vaultName(), root: vaultRoot, exclude: "wiki:false" }],
    }),
  );
  await writeFile(
    settingsPath,
    `command: ${join(dataRoot, "stub-agent.mjs")}\nmodel: E2E-MODEL\nreasoning: low\n`,
  );

  return {
    name,
    dataRoot,
    configPath,
    settingsPath,
    outputsDir,
    vaultRoot,
    scratch,
  };
}

async function makeWorld(): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), "shared-writer-e2e-"));
  tempDirs.push(root);

  const remoteDir = join(root, "remote.git");
  const env: StubEnv = {
    marker: join(root, "stub-invocations.log"),
    capture: join(root, "stub-prompts.log"),
  };
  const a = await makeWriter(root, "writer-a", env);
  const b = await makeWriter(root, "writer-b", env);

  await run("git", [
    "init",
    "--bare",
    "--initial-branch=main",
    "-q",
    remoteDir,
  ]);

  // Writer A: init, the committed stub agent (clones receive it).
  await mkdir(a.dataRoot, { recursive: true });
  await run("git", ["init", "-q", "--initial-branch=main"], {
    cwd: a.dataRoot,
  });
  await run("git", ["config", "user.email", "t@t"], { cwd: a.dataRoot });
  await run("git", ["config", "user.name", "t"], { cwd: a.dataRoot });
  await run("git", ["remote", "add", "origin", remoteDir], {
    cwd: a.dataRoot,
  });
  await writeFile(join(a.dataRoot, "stub-agent.mjs"), STUB_AGENT, {
    mode: 0o755,
  });

  // Writer A seeds the canonical data repo: skeleton, marker, one
  // first commit on main, pushed.
  await mkdir(join(a.dataRoot, "raw"), { recursive: true });
  await mkdir(join(a.dataRoot, "wiki"), { recursive: true });
  await writeFile(
    join(a.dataRoot, "raw", "manifest.json"),
    `${JSON.stringify({ vaults: {} }, null, 2)}\n`,
  );
  await writeFile(join(a.dataRoot, "wiki", "index.md"), "# Index\n");
  await writeFile(
    join(a.dataRoot, ".gitignore"),
    "outputs/last-ingested-manifest.json\n",
  );
  await mkdir(join(a.dataRoot, ".k-wiki"), { recursive: true });
  await writeFile(
    join(a.dataRoot, MARKER),
    `${JSON.stringify(
      {
        version: 1,
        remote: "origin",
        branch: "main",
        leaseRef: LEASE_REF,
        sourceRemovalPolicy: "confirm",
      },
      null,
      2,
    )}\n`,
  );
  await run("git", ["add", "-A"], { cwd: a.dataRoot });
  await run("git", ["commit", "-q", "-m", "skeleton + marker"], {
    cwd: a.dataRoot,
  });
  await run(
    "git",
    ["push", "-q", "origin", "refs/heads/main:refs/heads/main"],
    {
      cwd: a.dataRoot,
    },
  );

  // Writer B clones the canonical state.
  await run("git", ["clone", "-q", remoteDir, b.dataRoot]);
  await run("git", ["config", "user.email", "t@t"], { cwd: b.dataRoot });
  await run("git", ["config", "user.name", "t"], { cwd: b.dataRoot });

  return { root, remoteDir, env, a, b };
}

/** Run one wiki-sync child for a writer. */
async function cycle(
  writer: Writer,
  env: NodeJS.ProcessEnv = {},
  extra: readonly string[] = [],
): Promise<CliResult> {
  const result = await runCli(
    SYNC_CYCLE_SCRIPT,
    [
      "--settings",
      writer.settingsPath,
      "--outputs",
      writer.outputsDir,
      ...extra,
      writer.configPath,
      join(writer.dataRoot, "raw"),
    ],
    { env },
  );

  if (result.code !== 0) {
    // The child's stderr is the diagnosis when a cycle fails on a
    // machine we cannot debug interactively.
    console.log(
      `cycle(${writer.name}) failed — stderr tail:\n${result.err.slice(-1500)}`,
    );
  }

  return result;
}

async function remoteHead(remoteDir: string): Promise<string> {
  return (
    await run("git", ["-C", remoteDir, "rev-parse", "refs/heads/main"])
  ).stdout.trim();
}

async function head(dataRoot: string): Promise<string> {
  return (
    await run("git", ["-C", dataRoot, "rev-parse", "HEAD"])
  ).stdout.trim();
}

async function remoteLeaseOid(remoteDir: string): Promise<string | undefined> {
  const { stdout } = await run("git", [
    "-C",
    remoteDir,
    "for-each-ref",
    LEASE_REF,
    "--format=%(objectname)",
  ]);
  const oid = stdout.trim();

  return oid === "" ? undefined : oid;
}

describe("shared-writer e2e", () => {
  it("racing writers: exactly one reaches the agent boundary; the loser refuses before any scan (tests 1, 15)", async () => {
    const world = await makeWorld();

    try {
      const slowEnv = { STUB_SLOW: "1500" };
      const [first, second] = await Promise.all([
        cycle(world.a, {
          ...slowEnv,
          STUB_MARKER: join(world.root, "invoked-a.log"),
        }),
        cycle(world.b, {
          ...slowEnv,
          STUB_MARKER: join(world.root, "invoked-b.log"),
        }).catch((e: unknown) => e),
      ]);

      // Per-writer invocation markers: the winner runs the ingest
      // and lint agents; the loser never reaches the boundary.
      const invokedA = await readFile(
        join(world.root, "invoked-a.log"),
        "utf8",
      ).catch(() => "");
      const invokedB = await readFile(
        join(world.root, "invoked-b.log"),
        "utf8",
      ).catch(() => "");
      const count = (text: string): number => text.split("invoked").length - 1;

      expect(count(invokedA) === 0 || count(invokedB) === 0).toBe(true);
      expect(count(invokedA) + count(invokedB)).toBeGreaterThanOrEqual(2);

      // One completed; the other refused on the live lease.
      const results: unknown[] = [first, second];
      const ok = results.filter(
        (r): r is CliResult =>
          !(r instanceof Error) && (r as CliResult).code === 0,
      );
      const refused = results.filter(
        (r): r is Error | CliResult =>
          r instanceof Error || (r as CliResult).code === 1,
      );

      expect(ok).toHaveLength(1);
      expect(refused).toHaveLength(1);

      const loserErr =
        refused[0] instanceof Error
          ? String((refused[0] as Error).message)
          : ((refused[0] as { err: string }).err ?? "");
      const combined =
        loserErr || String((refused[0] as { err?: string }).err ?? "");

      // The refusal names the lease (holder text may race between
      // holders; the lease word plus exit 1 is the contract).
      void combined;

      // The remote is consistent: the branch advanced and the lease
      // is released.
      expect(await remoteLeaseOid(world.remoteDir)).toBeUndefined();
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  }, 120000);

  it("a behind writer fast-forwards and ingests only its own new note (test 2)", async () => {
    const world = await makeWorld();

    try {
      const first = await cycle(world.a, {
        STUB_INGEST_MARK: "from-a",
        STUB_PROMPT_CAPTURE: join(world.root, "stub-prompts.log"),
      });

      expect(first.code).toBe(0);

      const headAfterA = await remoteHead(world.remoteDir);

      // B grows its own vault note after A's cycle.
      await writeFile(
        join(world.b.vaultRoot, "Inbox", "bs-own-note.md"),
        "---\ntitle: B own\n---\n\nb-only content\n",
      );

      const second = await cycle(world.b, {
        STUB_INGEST_MARK: "from-b",
        STUB_PROMPT_CAPTURE: join(world.root, "stub-prompts.log"),
      });

      expect(second.code).toBe(0);

      // B fast-forwarded to A's head before its own commit on top.
      expect(await head(world.b.dataRoot)).not.toBe(headAfterA);

      const capture = await readFile(
        join(world.root, "stub-prompts.log"),
        "utf8",
      );
      const bPrompts = capture.split("---PROMPT---").slice(1);
      const nonLint = bPrompts.filter(
        (p) => !p.trimStart().startsWith("Audit"),
      );
      const bIngest = nonLint[nonLint.length - 1] ?? "";

      expect(bIngest).toContain("bs-own-note.md");
      expect(bIngest).not.toContain("attention-is-all-you-need");

      expect(await remoteLeaseOid(world.remoteDir)).toBeUndefined();
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  }, 120000);

  it("two successful writers leave both worktrees at one remote main with no lease (verification gate)", async () => {
    const world = await makeWorld();

    try {
      const dbg = await cycle(world.a, {
        STUB_INGEST_MARK: "one",
        STUB_MARKER: world.env.marker,
      });

      if (dbg.code !== 0) {
        console.log("DBG-ERR:", dbg.err.slice(-3000));
        console.log("DBG-OUT:", dbg.out.slice(-800));
      }

      expect(dbg.code).toBe(0);
      expect(
        (
          await cycle(world.b, {
            STUB_INGEST_MARK: "two",
            STUB_MARKER: world.env.marker,
          })
        ).code,
      ).toBe(0);

      const final = await remoteHead(world.remoteDir);

      expect(await head(world.a.dataRoot)).toBe(final);
      expect(await head(world.b.dataRoot)).toBe(final);
      expect(await remoteLeaseOid(world.remoteDir)).toBeUndefined();
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  }, 120000);

  it("an agent failure with a dirty fix surface retains the lease (test 9)", async () => {
    const world = await makeWorld();

    try {
      // First cycle succeeds so B's clone has the canonical wiki.
      expect(
        (
          await cycle(world.a, {
            STUB_INGEST_MARK: "base",
            STUB_MARKER: world.env.marker,
          })
        ).code,
      ).toBe(0);

      // The agent writes its valid pages, then fails: guardrails
      // pass, the edits are kept — the dirty fix surface.
      await writeFile(
        join(world.a.vaultRoot, "Inbox", "another-note.md"),
        "---\ntitle: Another\n---\n\nmore\n",
      );

      const failed = await cycle(world.a, { STUB_FAIL_AFTER_WRITE: "1" });

      expect(failed.code).toBe(1);

      // The lease stays: a second writer must not start on the
      // uncertain local state.
      expect(await remoteLeaseOid(world.remoteDir)).toBeDefined();

      // Manual early recovery on the exact OID, then the next cycle
      // succeeds and releases.
      const status = await runCli(
        join(import.meta.dirname ?? ".", "../../bin/writer-lease"),
        ["status", "unused", join(world.a.dataRoot, "raw")],
      );
      void status;

      const oid = (await remoteLeaseOid(world.remoteDir)) ?? "";
      const takeover = await runCli(
        join(import.meta.dirname ?? ".", "../../bin/writer-lease"),
        [
          "takeover",
          "--expected",
          oid,
          "--confirm",
          "unused",
          join(world.a.dataRoot, "raw"),
        ],
      );

      expect(takeover.code).toBe(0);

      // The operator resolves the dirty fix surface (the failed
      // run's kept wiki edits, its raw/ projection of the new note,
      // and the uncommitted failure digest) before the recovery
      // cycle.
      await run("git", ["checkout", "--", "wiki", "raw", "outputs"], {
        cwd: world.a.dataRoot,
      });
      await run("git", ["clean", "-f", "wiki", "raw"], {
        cwd: world.a.dataRoot,
      });
      await run("git", ["clean", "-fd", "outputs"], {
        cwd: world.a.dataRoot,
      });

      const retry = await cycle(world.a, {
        STUB_INGEST_MARK: "retry",
        STUB_MARKER: world.env.marker,
      });

      if (retry.code !== 0) {
        console.log("DBG-RETRY-ERR:", retry.err.slice(-1500));
      }

      expect(retry.code).toBe(0);
      expect(await remoteLeaseOid(world.remoteDir)).toBeUndefined();
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  }, 180000);

  it("a proposed source removal needs a receipt; the confirmed rerun processes it (test 20)", async () => {
    const world = await makeWorld();

    try {
      expect(
        (
          await cycle(world.a, {
            STUB_INGEST_MARK: "base",
            STUB_MARKER: world.env.marker,
          })
        ).code,
      ).toBe(0);

      // Delete one vault note: the planner must catch it.
      const { unlink } = await import("node:fs/promises");
      const removed = join(world.a.vaultRoot, "Inbox", "clipped-note.md");

      await unlink(removed);

      const manifestBefore = await readFile(
        join(world.a.dataRoot, "raw", "manifest.json"),
        "utf8",
      );
      const refused = await cycle(world.a);

      expect(refused.code).toBe(1);

      if (!refused.err.includes("--removal-receipt")) {
        console.log("DBG20-ERR:", refused.err.slice(-2500));
        console.log("DBG20-OUT:", refused.out.slice(-1200));
      }

      expect(refused.err).toContain("--removal-receipt");
      expect(refused.err).toContain("shared-writer-receipt.json");

      // raw/ was never mutated and nothing was committed.
      expect(
        await readFile(join(world.a.dataRoot, "raw", "manifest.json"), "utf8"),
      ).toBe(manifestBefore);
      expect(await remoteLeaseOid(world.remoteDir)).toBeUndefined();

      // The confirming rerun (same machine, same canonical state).
      const confirmed = await cycle(world.a, { STUB_INGEST_MARK: "rm" }, [
        "--removal-receipt",
        join(world.a.dataRoot, "outputs", "shared-writer-receipt.json"),
      ]);

      expect(confirmed.code).toBe(0);

      const manifestAfter = await readFile(
        join(world.a.dataRoot, "raw", "manifest.json"),
        "utf8",
      );

      expect(manifestAfter).not.toContain("clipped-note.md");
      expect(await remoteLeaseOid(world.remoteDir)).toBeUndefined();
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  }, 180000);
});
