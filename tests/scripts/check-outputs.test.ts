import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { checkOutputs } from "../../scripts/check-outputs.ts";

/** check-outputs tests: the day-file shape mode, the pair-reference
 *  citations mode, and the CLI surface (exit codes, --help). The
 *  parsing primitives come from src/sync/cycle-reports.ts and are
 *  tested at their mirrored path tests/sync/cycle-reports.test.ts. */

const script = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../bin/libexec/check-outputs",
);

interface RunResult {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

function runNode(args: readonly string[]): Promise<RunResult> {
  // argv[1] must be the real path: import.meta.url is realpath'd by
  // Node, and a symlinked spawn path (macOS tmp) would make the CLI
  // import guard compare unequal and skip main().
  const realArgs = [realpathSync(script), ...args];
  const env = { ...process.env };

  delete env.NO_COLOR;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, realArgs, { stdio: "pipe", env });

    let out = "";
    let err = "";

    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const CYCLE_TITLE = "# wiki-sync cycle digest — 2026-10-12";
const LINT_TITLE = "# Windowed lint — 2026-10-12";
const CYCLE_1 = "2026-10-12T14:54:53+01:00";
const CYCLE_2 = "2026-10-12T18:00:59+01:00";
const LINT_1 = "2026-10-12T14:54:52+01:00 (window audit, 34 pages)";

/** A lint bullet naming lint run 1's section, as the writer emits it. */
function lintBullet(lintTitle: string): string {
  return `- **Lint:** window audit (34 pages: changed this cycle plus reverse neighbors) — report \`outputs/lint-2026-10-12.md\` — section "${lintTitle}" — summary below`;
}

/** A cycle back-reference line, as the lint prompt dictates it. */
function backReference(cycleTitle: string): string {
  return `Cycle audited: \`outputs/cycle-2026-10-12.md\` — section "${cycleTitle}"`;
}

function cycleDayFile(...sections: readonly string[]): string {
  const bodies = sections.flatMap((body, index) => {
    const heading = `## Cycle ${index + 1} — ${
      index === 0 ? CYCLE_1 : CYCLE_2
    }`;
    const lead = index === 0 ? [] : ["---", ""];

    return [...lead, heading, "", body, ""];
  });

  return [CYCLE_TITLE, "", ...bodies].join("\n");
}

/** An outputs dir with the given files written. */
async function makeOutputs(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "k-wiki-check-outputs-"));

  tempDirs.push(dir);

  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, dirname(name)), { recursive: true });
    await writeFile(join(dir, name), content);
  }

  return dir;
}

const PAIRED: Record<string, string> = {
  "cycle-2026-10-12.md": cycleDayFile(
    lintBullet(`Lint run 1 — ${LINT_1}`),
    "- second cycle digest",
  ),
  "lint-2026-10-12.md": [
    LINT_TITLE,
    "",
    `## Lint run 1 — ${LINT_1}`,
    "",
    backReference(`Cycle 1 — ${CYCLE_1}`),
    "",
    "audit body",
    "",
    "---",
    "",
    "## Lint run 2 — 2026-10-12T18:00:58+01:00 (window audit, 2 pages)",
    "",
    "Standalone — no citing cycle.",
    "",
    "standalone body",
    "",
  ].join("\n"),
};

describe("checkOutputs shape mode", () => {
  it("passes a well-formed two-cycle day file and its lint mirror", async () => {
    const dir = await makeOutputs(PAIRED);

    expect(await checkOutputs(dir, "shape")).toEqual([]);
  });

  it("rejects a family-titled file whose sections date the file differently", async () => {
    const dir = await makeOutputs({
      "cycle-2026-10-12.md": cycleDayFile("- only body").replace(
        CYCLE_TITLE,
        "# wiki-sync cycle digest — 2026-10-11",
      ),
    });

    expect(await checkOutputs(dir, "shape")).toEqual([
      'cycle-2026-10-12.md: day title must be "# wiki-sync cycle digest — 2026-10-12"',
    ]);
  });

  it("rejects a section numbered off its position", async () => {
    const dir = await makeOutputs({
      "cycle-2026-10-12.md": cycleDayFile(
        lintBullet(`Lint run 1 — ${LINT_1}`),
        "- second cycle digest",
      ).replace(`## Cycle 2 — ${CYCLE_2}`, `## Cycle 3 — ${CYCLE_2}`),
    });

    expect(await checkOutputs(dir, "shape")).toEqual([
      "cycle-2026-10-12.md: section 2 is numbered 3, expected 2 (sections number by position)",
    ]);
  });

  it("rejects consecutive sections without the --- separator", async () => {
    const dir = await makeOutputs({
      "cycle-2026-10-12.md": cycleDayFile(
        lintBullet(`Lint run 1 — ${LINT_1}`),
        "- second cycle digest",
      ).replace("\n---\n", "\n"),
    });

    expect(await checkOutputs(dir, "shape")).toEqual([
      "cycle-2026-10-12.md: sections separate with a --- line",
    ]);
  });

  it("rejects a heading at the section's own level inside a section", async () => {
    const dir = await makeOutputs({
      "cycle-2026-10-12.md": cycleDayFile("## Ingest digest\n\ndigest body"),
    });

    expect(await checkOutputs(dir, "shape")).toEqual([
      'cycle-2026-10-12.md: heading escapes its section — "## Ingest digest"',
    ]);
  });

  it("exempts code-fenced lines from the containment scan", async () => {
    const dir = await makeOutputs({
      "cycle-2026-10-12.md": cycleDayFile("- only sync facts"),
      "lint-2026-10-12.md": [
        LINT_TITLE,
        "",
        `## Lint run 1 — ${LINT_1}`,
        "",
        backReference(`Cycle 1 — ${CYCLE_1}`),
        "",
        "```",
        "## example",
        "```",
        "",
      ].join("\n"),
    });

    expect(await checkOutputs(dir, "all")).toEqual([]);
  });

  it("reports a family-named file whose date cannot exist", async () => {
    const dir = await makeOutputs({
      "cycle-2026-02-30.md": "# wiki-sync cycle digest — 2026-02-30\n",
    });

    expect(await checkOutputs(dir, "all")).toEqual([
      "cycle-2026-02-30.md: unparseable date in name",
    ]);
  });

  it("rejects a lint run heading carrying supersession prose", async () => {
    const dir = await makeOutputs({
      "lint-2026-10-12.md": [
        LINT_TITLE,
        "",
        "## Lint run 1 — 2026-10-12T14:54:52+01:00 (supersedes the morning audit)",
        "",
        "Standalone — no citing cycle.",
        "",
      ].join("\n"),
    });

    expect(await checkOutputs(dir, "shape")).toEqual([
      "lint-2026-10-12.md: section heading carries supersession prose",
    ]);
  });

  it("exempts a legacy-shape file from every shape rule", async () => {
    const dir = await makeOutputs({
      "cycle-2026-10-12.md": [
        "# wiki-sync cycle digest",
        "",
        "## Lint summary",
        "",
        "overwrite-era content at H2",
        "",
      ].join("\n"),
    });

    expect(await checkOutputs(dir, "shape")).toEqual([]);
  });

  it("ignores files outside the day-file families", async () => {
    const dir = await makeOutputs({
      "runs/x.md": "# anything goes\n",
      "last-query.md": "# query\n",
    });

    expect(await checkOutputs(dir, "all")).toEqual([]);
  });
});

describe("checkOutputs citations mode", () => {
  it("passes resolving in-cycle pairs and exempts the marked standalone run", async () => {
    const dir = await makeOutputs(PAIRED);

    expect(await checkOutputs(dir, "citations")).toEqual([]);
  });

  it("rejects a lint run carrying neither marker nor back-reference", async () => {
    const dir = await makeOutputs({
      "lint-2026-10-12.md": [
        LINT_TITLE,
        "",
        `## Lint run 1 — ${LINT_1}`,
        "",
        "audit body with no contract line",
        "",
      ].join("\n"),
    });

    expect(await checkOutputs(dir, "citations")).toEqual([
      'lint-2026-10-12.md: section "Lint run 1 — 2026-10-12T14:54:52+01:00 (window audit, 34 pages)" carries neither the standalone marker nor a cycle back-reference',
    ]);
  });

  it("rejects a lint reference naming a day file that does not exist", async () => {
    const dir = await makeOutputs({
      "cycle-2026-10-12.md": cycleDayFile(lintBullet(`Lint run 2 — ${LINT_1}`)),
    });

    expect(await checkOutputs(dir, "citations")).toEqual([
      'cycle-2026-10-12.md: section "Cycle 1 — 2026-10-12T14:54:53+01:00" references outputs/lint-2026-10-12.md — no such day file in the append shape',
    ]);
  });

  it("rejects a back-reference naming a section that is not there", async () => {
    const dir = await makeOutputs({
      "cycle-2026-10-12.md": cycleDayFile(lintBullet(`Lint run 1 — ${LINT_1}`)),
      "lint-2026-10-12.md": [
        LINT_TITLE,
        "",
        `## Lint run 1 — ${LINT_1}`,
        "",
        backReference(`Cycle 9 — ${CYCLE_1}`),
        "",
      ].join("\n"),
    });

    expect(await checkOutputs(dir, "citations")).toEqual([
      'lint-2026-10-12.md: section "Lint run 1 — 2026-10-12T14:54:52+01:00 (window audit, 34 pages)" references outputs/cycle-2026-10-12.md — no section "Cycle 9 — 2026-10-12T14:54:53+01:00" there',
    ]);
  });

  it("rejects an [[outputs/...]] wikilink in a day file", async () => {
    const dir = await makeOutputs({
      "lint-2026-10-12.md": [
        LINT_TITLE,
        "",
        `## Lint run 1 — ${LINT_1}`,
        "",
        "Standalone — no citing cycle.",
        "",
        "see [[outputs/lint-2026-10-12.md]]",
        "",
      ].join("\n"),
    });

    expect(await checkOutputs(dir, "citations")).toEqual([
      "lint-2026-10-12.md: carries an [[outputs/...]] wikilink — references are plain data-repo-relative paths",
    ]);
  });

  it("exempts a pre-append bound from the citation rules", async () => {
    const dir = await makeOutputs({
      "lint-2026-10-12.md": [
        LINT_TITLE,
        "",
        "## Lint run 1 (pre-append)",
        "",
        "# Overwrite-era title",
        "",
        "legacy content, no marker",
        "",
        "---",
        "",
        `## Lint run 2 — ${LINT_1}`,
        "",
        "Standalone — no citing cycle.",
        "",
      ].join("\n"),
    });

    expect(await checkOutputs(dir, "citations")).toEqual([]);
  });
});

describe("check-outputs CLI", () => {
  it("answers --help with usage and exit 0", async () => {
    const result = await runNode(["--help"]);

    expect(`${result.code}|${result.out}`).toMatch(/0\|Usage: check-outputs/);
  });

  it("exits 1 naming the unresolved pair on a broken lint file", async () => {
    const dir = await makeOutputs({
      "lint-2026-10-12.md": [
        LINT_TITLE,
        "",
        `## Lint run 1 — ${LINT_1}`,
        "",
        "no contract line",
        "",
      ].join("\n"),
    });

    const failing = await runNode([dir]);

    expect(failing.err).toContain("carries neither the standalone marker");
  });

  it("exits 1 when a citation check fails", async () => {
    const dir = await makeOutputs({
      "lint-2026-10-12.md": [
        LINT_TITLE,
        "",
        `## Lint run 1 — ${LINT_1}`,
        "",
        "no contract line",
        "",
      ].join("\n"),
    });

    const failing = await runNode([dir]);

    expect(failing.code).toBe(1);
  });

  it("exits 0 with an ok summary over the paired day files", async () => {
    const clean = await makeOutputs(PAIRED);
    const passing = await runNode([clean]);

    expect(passing.code).toBe(0);
  });

  it("prints the ok summary naming the run mode", async () => {
    const clean = await makeOutputs(PAIRED);
    const passing = await runNode([clean]);

    expect(passing.out).toContain("ok: day files checked");
  });

  it("reports shape-only runs clean when --mode restricts the check", async () => {
    const dir = await makeOutputs({
      "lint-2026-10-12.md": [
        LINT_TITLE,
        "",
        `## Lint run 1 — ${LINT_1}`,
        "",
        "no contract line",
        "",
      ].join("\n"),
    });

    const shapeOnly = await runNode(["--mode", "shape", dir]);

    expect(shapeOnly.out).toContain("ok: day files checked (shape)");
  });
});
