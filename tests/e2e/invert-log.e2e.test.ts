import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { repoRoot, runCli } from "./helpers.ts";

/**
 * invert-log e2e (issue #369's deployment tool): the real libexec
 * door as a child process against temp data repos, covering the
 * safety envelope the unit tests shape — dry-run default, the
 * lossless write with its audit entry on top, idempotency, the
 * one-way refusals, and --help.
 */

const INVERT_SCRIPT = join(repoRoot, "bin", "libexec", "invert-log");

const run = promisify(execFile);

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const OLDEST_FIRST = [
  "# Wiki Log",
  "",
  "## [2026-07-01] ingest | Old",
  "",
  "Old body.",
  "",
  "## [2026-08-01] ingest | New",
  "",
  "New body.",
  "",
].join("\n");

/** A temp data repo (git-initialized, committed clean) whose
 *  wiki/log.md holds `log`. */
async function makeRepo(log: string): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), "k-wiki-invert-e2e-"));

  tempDirs.push(tmp);

  const dataRoot = join(tmp, "data");

  await mkdir(join(dataRoot, "wiki"), { recursive: true });
  await writeFile(join(dataRoot, "wiki", "log.md"), log, "utf8");

  for (const args of [
    ["init", "--quiet"],
    ["config", "user.email", "t@t"],
    ["config", "user.name", "t"],
    ["add", "-A"],
    ["commit", "--quiet", "-m", "init"],
  ]) {
    await run("git", args, { cwd: dataRoot });
  }

  return dataRoot;
}

describe("invert-log e2e", () => {
  it("answers --help with usage and exit 0", async () => {
    const result = await runCli(INVERT_SCRIPT, ["--help"]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("Usage: invert-log");
  });

  it("reports an oldest-first log without writing on the dry-run default", async () => {
    const dataRoot = await makeRepo(OLDEST_FIRST);

    const result = await runCli(INVERT_SCRIPT, [
      "--date",
      "2026-09-01",
      join(dataRoot, "wiki"),
    ]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("would invert — 2 entries verified lossless");
    expect(await readFile(join(dataRoot, "wiki", "log.md"), "utf8")).toBe(
      OLDEST_FIRST,
    );
  });

  it("inverts losslessly with the audit entry on top on --write", async () => {
    const dataRoot = await makeRepo(OLDEST_FIRST);

    const result = await runCli(INVERT_SCRIPT, [
      "--write",
      "--date",
      "2026-09-01",
      join(dataRoot, "wiki"),
    ]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("invert-log: inverted — 2 entries");
    expect(await readFile(join(dataRoot, "wiki", "log.md"), "utf8")).toBe(
      [
        "# Wiki Log",
        "",
        "## [2026-09-01] log-inversion | 2 entries",
        "",
        "## [2026-08-01] ingest | New",
        "",
        "New body.",
        "",
        "## [2026-07-01] ingest | Old",
        "",
        "Old body.",
        "",
      ].join("\n"),
    );
  });

  it("is idempotent: a re-run exits 0 and writes nothing", async () => {
    const dataRoot = await makeRepo(OLDEST_FIRST);

    await runCli(INVERT_SCRIPT, [
      "--write",
      "--date",
      "2026-09-01",
      join(dataRoot, "wiki"),
    ]);

    const before = await readFile(join(dataRoot, "wiki", "log.md"), "utf8");
    const result = await runCli(INVERT_SCRIPT, [
      "--write",
      "--date",
      "2026-09-02",
      join(dataRoot, "wiki"),
    ]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("nothing to do (log-inversion");
    expect(await readFile(join(dataRoot, "wiki", "log.md"), "utf8")).toBe(
      before,
    );
  });

  it("refuses ambiguous dates with exit 1 and writes nothing", async () => {
    const ambiguous = [
      "# Wiki Log",
      "",
      "## [2026-07-01] a | x",
      "",
      "## [2026-08-01] b | y",
      "",
      "## [2026-07-15] c | z",
      "",
    ].join("\n");
    const dataRoot = await makeRepo(ambiguous);

    const result = await runCli(INVERT_SCRIPT, [
      "--write",
      "--date",
      "2026-09-01",
      join(dataRoot, "wiki"),
    ]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("ambiguous");
    expect(await readFile(join(dataRoot, "wiki", "log.md"), "utf8")).toBe(
      ambiguous,
    );
  });

  it("refuses --write on a dirty tree with exit 1", async () => {
    const dataRoot = await makeRepo(OLDEST_FIRST);

    await writeFile(join(dataRoot, "wiki", "index.md"), "dirty\n", "utf8");

    const result = await runCli(INVERT_SCRIPT, [
      "--write",
      "--date",
      "2026-09-01",
      join(dataRoot, "wiki"),
    ]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("uncommitted changes");
  });
});
