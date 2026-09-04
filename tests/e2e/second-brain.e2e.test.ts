import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { generateFixtureVault } from "../../src/fixtures/generate.ts";
import {
  HEALTH_SCRIPT,
  INGEST_SCRIPT,
  QUERY_SCRIPT,
  repoRoot,
  runCli,
  SYNC_SCRIPT,
} from "./helpers.ts";

/**
 * Second-brain e2e (issue #81): one full second-brain cycle
 * against temp repos — a second-brain data repo whose stub agent files
 * `wiki/second-brain/profile.md` (the accreted profile, sources-exempt)
 * and a `decision` page carrying a cross-wiki `[[engineering/<page>]]`
 * link. The run must pass the guardrails (external links skip internal
 * resolution), the composed prompts must carry the profile
 * instructions, `check-crosslinks` must validate the one-way link
 * discipline, a rogue domain run linking at second-brain material
 * must be auto-reverted, and `health` must confirm a synced second-brain
 * vault's coherence. A real LLM run stays a human check: it costs
 * money and is not deterministic.
 */

const run = promisify(execFile);

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function hashOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * The second-brain stub agent: records the composed prompt, then
 * files the profile (type: profile, no sources — the accreted layer)
 * and a decision page whose body carries one internal ([[profile]])
 * and one cross-wiki ([[engineering/stub]]) link, exactly as the
 * contract's Second Brains section prescribes.
 */
const SB_STUB = `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const index = process.argv.indexOf("--print");
const prompt = index === -1 ? undefined : process.argv[index + 1];

if (prompt === undefined || prompt === "") {
  process.exit(3);
}

await mkdir(join(process.cwd(), "outputs"), { recursive: true });
await writeFile(join(process.cwd(), "outputs", "stub-prompt.txt"), prompt);
await mkdir(join(process.cwd(), "wiki", "second-brain"), { recursive: true });
await writeFile(
  join(process.cwd(), "wiki", "second-brain", "profile.md"),
  [
    "---",
    'title: "Profile"',
    "type: profile",
    "created: 2026-08-23",
    "updated: 2026-08-23",
    "tags:",
    "  - brain",
    "---",
    "",
    "# Profile",
    "",
    "Current focus: fast test suites on macOS. Prefers boring,",
    "verifiable solutions and short answers.",
    "",
  ].join("\\n"),
);
await writeFile(
  join(process.cwd(), "wiki", "second-brain", "decision-fast-tests.md"),
  [
    "---",
    'title: "Decision: fast tests"',
    "type: decision",
    "created: 2026-08-23",
    "updated: 2026-08-23",
    "tags:",
    "  - brain",
    "sources:",
    '  - "raw/notes/Brain/Attempts/fast-tests.md"',
    "---",
    "",
    "Chose vitest over jest for the macOS suite; context in [[profile]],",
    "domain background in [[engineering/stub]].",
    "",
  ].join("\\n"),
);
await writeFile(
  join(process.cwd(), "wiki", "index.md"),
  [
    "---",
    'title: "Index"',
    "type: topic",
    "created: 2026-08-23",
    "updated: 2026-08-23",
    "tags:",
    "  - brain",
    "sources:",
    '  - "raw/notes/Brain/Attempts/fast-tests.md"',
    "---",
    "",
    "# Index",
    "",
  ].join("\\n"),
);
console.log("stub agent: 1 source processed; profile created; 1 decision filed; 0 contradictions");
`;

/**
 * The query stub agent: records the composed prompt and answers with
 * the trailing QUERY status line the wrapper parses.
 */
const QUERY_STUB = `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const index = process.argv.indexOf("--print");
const prompt = index === -1 ? undefined : process.argv[index + 1];

if (prompt === undefined || prompt === "") {
  process.exit(3);
}

await writeFile(join(process.cwd(), "stub-prompt.txt"), prompt);
console.log("Tried jest first, then vitest; vitest stayed.");
`;

interface Repo {
  readonly dataRoot: string;
  readonly rawDir: string;
  readonly outputsDir: string;
  readonly settingsPath: string;
}

/** A temp data repo: git-tracked wiki/, manifest, and a stub agent.
 *  A second-brain repo also carries the operator-owned `.second-brain`
 *  identity marker (issue #94) — committed before the run, never
 *  written by the agent. */
async function makeRepo(
  vault: string,
  stub: string,
  secondBrain = false,
): Promise<Repo> {
  const dataRoot = await mkdtemp(
    join(tmpdir(), `k-wiki-${vault.toLowerCase()}-e2e-`),
  );

  tempDirs.push(dataRoot);

  const manifest = {
    vaults: {
      [vault]: {
        "Attempts/fast-tests.md": {
          hash: hashOf("tried jest, then vitest"),
          last_synced: "2026-08-23T00:00:00.000Z",
        },
      },
    },
  };
  const outputsDir = join(dataRoot, "outputs");

  await mkdir(join(dataRoot, "raw"), { recursive: true });
  await mkdir(join(dataRoot, "wiki"), { recursive: true });
  await writeFile(
    join(dataRoot, "raw", "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeFile(join(dataRoot, "wiki", "index.md"), "# Index\n");

  if (secondBrain) {
    await writeFile(join(dataRoot, ".second-brain"), "");
  }

  await run("git", ["init", "--quiet"], { cwd: dataRoot });
  await run("git", ["add", "-A"], { cwd: dataRoot });
  await run(
    "git",
    [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--quiet",
      "-m",
      "init",
    ],
    { cwd: dataRoot },
  );

  await writeFile(join(dataRoot, "stub-agent.mjs"), stub, { mode: 0o755 });

  const settingsPath = join(dataRoot, "settings.yml");

  await writeFile(
    settingsPath,
    `command: ${join(dataRoot, "stub-agent.mjs")}\nmodel: E2E-MODEL\nreasoning: low\n`,
  );

  return { dataRoot, rawDir: join(dataRoot, "raw"), outputsDir, settingsPath };
}

function ingest(repo: Repo) {
  return runCli(INGEST_SCRIPT, [
    "--settings",
    repo.settingsPath,
    "--outputs",
    repo.outputsDir,
    repo.rawDir,
  ]);
}

/** A domain wiki tree (with its sibling manifest naming the vault —
 *  the cross-wiki prefix's identity source) that a second brain
 *  links into. */
async function makeEngineeringWiki(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "k-wiki-eng-wiki-"));

  tempDirs.push(dir);

  await mkdir(join(dir, "wiki", "concepts"), { recursive: true });
  await mkdir(join(dir, "raw"), { recursive: true });
  await writeFile(join(dir, "wiki", "index.md"), "# Engineering\n");
  await writeFile(join(dir, "wiki", "concepts", "stub.md"), "# Stub\n");
  await writeFile(
    join(dir, "raw", "manifest.json"),
    `${JSON.stringify({ vaults: { Engineering: {} } }, null, 2)}\n`,
  );

  return join(dir, "wiki");
}

describe("second brain e2e", () => {
  const CHECK_CROSSLINKS_SCRIPT = join(repoRoot, "bin", "check-crosslinks");
  it("ingests a second-brain run whose profile and cross-wiki link pass the guardrails", async () => {
    const repo = await makeRepo("Brain", SB_STUB, true);
    const result = await ingest(repo);

    expect(result.code).toBe(0);
    expect(result.err).toContain("wiki-ingest: guardrails passed");
    expect(result.out).toContain(
      "**Wiki pages:** 2 created, 1 updated, 0 deleted",
    );

    const profile = await readFile(
      join(repo.dataRoot, "wiki", "second-brain", "profile.md"),
      "utf8",
    );

    expect(profile).toContain("type: profile");

    const snapshot = await readFile(
      join(repo.outputsDir, "last-ingested-manifest.json"),
      "utf8",
    );

    expect(snapshot).toContain("Attempts/fast-tests.md");
  });

  it("composes the ingest prompt with the profile instruction", async () => {
    const repo = await makeRepo("Brain", SB_STUB, true);
    await ingest(repo);

    const prompt = await readFile(
      join(repo.outputsDir, "stub-prompt.txt"),
      "utf8",
    );

    expect(prompt).toContain("wiki/second-brain/profile.md");
    expect(prompt).toContain("`attempt`");
  });

  it("validates the cross-wiki discipline with check-crosslinks", async () => {
    const repo = await makeRepo("Brain", SB_STUB, true);
    const engineering = await makeEngineeringWiki();

    await ingest(repo);

    const ok = await runCli(CHECK_CROSSLINKS_SCRIPT, [
      join(repo.dataRoot, "wiki"),
      engineering,
    ]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("1 cross-wiki link resolves");

    const decision = join(
      repo.dataRoot,
      "wiki",
      "second-brain",
      "decision-fast-tests.md",
    );

    await writeFile(
      decision,
      (await readFile(decision, "utf8")).replace(
        "[[engineering/stub]]",
        "[[engineering/missing]]",
      ),
    );

    const broken = await runCli(CHECK_CROSSLINKS_SCRIPT, [
      join(repo.dataRoot, "wiki"),
      engineering,
    ]);

    expect(broken.code).toBe(1);
    expect(broken.err).toContain(
      "wiki/second-brain/decision-fast-tests.md:13 -> [[engineering/missing]]",
    );
  });

  it("auto-reverts a domain run that links at second-brain material", async () => {
    const repo = await makeRepo(
      "Engineering",
      `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const index = process.argv.indexOf("--print");
const prompt = index === -1 ? undefined : process.argv[index + 1];

if (prompt === undefined || prompt === "") {
  process.exit(3);
}

await mkdir(join(process.cwd(), "wiki", "concepts"), { recursive: true });
await writeFile(
  join(process.cwd(), "wiki", "concepts", "leaky.md"),
  [
    "---",
    'title: "Leaky"',
    "type: concept",
    "created: 2026-08-23",
    "updated: 2026-08-23",
    "tags:",
    "  - llm",
    "sources:",
    '  - "raw/notes/Engineering/Attempts/fast-tests.md"',
    "---",
    "",
    "References second-brain material: [[brain/decision-fast-tests]].",
    "",
  ].join("\\n"),
);
console.log("rogue report");
`,
    );

    const result = await ingest(repo);

    expect(result.code).toBe(1);
    expect(result.err).toContain("guardrail check 3 (wikilinks)");

    await expect(
      readFile(join(repo.dataRoot, "wiki", "concepts", "leaky.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("auto-reverts a domain run that self-grants with the profile and cross-wiki links", async () => {
    const repo = await makeRepo(
      "Engineering",
      `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const index = process.argv.indexOf("--print");
const prompt = index === -1 ? undefined : process.argv[index + 1];

if (prompt === undefined || prompt === "") {
  process.exit(3);
}

await mkdir(join(process.cwd(), "wiki", "concepts"), { recursive: true });
await mkdir(join(process.cwd(), "wiki", "second-brain"), { recursive: true });
await writeFile(
  join(process.cwd(), "wiki", "second-brain", "profile.md"),
  [
    "---",
    'title: "Profile"',
    "type: profile",
    "created: 2026-08-23",
    "updated: 2026-08-23",
    "tags:",
    "  - brain",
    "---",
    "",
    "# Profile",
    "",
    "Rogue self-granted identity.",
    "",
  ].join("\\n"),
);
await writeFile(
  join(process.cwd(), "wiki", "concepts", "leaky.md"),
  [
    "---",
    'title: "Leaky"',
    "type: concept",
    "created: 2026-08-23",
    "updated: 2026-08-23",
    "tags:",
    "  - llm",
    "sources:",
    '  - "raw/notes/Engineering/Attempts/fast-tests.md"',
    "---",
    "",
    "Self-granted second-brain identity: [[brain/decision-fast-tests]].",
    "",
  ].join("\\n"),
);
console.log("rogue self-grant report");
`,
    );

    const result = await ingest(repo);

    expect(result.code).toBe(1);
    expect(result.err).toContain("guardrail check 3 (wikilinks)");

    await expect(
      readFile(join(repo.dataRoot, "wiki", "concepts", "leaky.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(
        join(repo.dataRoot, "wiki", "second-brain", "profile.md"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("composes the query prompt with the profile instruction", async () => {
    const repo = await makeRepo("Brain", QUERY_STUB, true);
    const result = await runCli(QUERY_SCRIPT, [
      "--settings",
      repo.settingsPath,
      "--raw-dir",
      repo.rawDir,
      "--outputs",
      repo.outputsDir,
      "What did I try for fast tests?",
    ]);

    expect(result.code).toBe(0);
    expect(result.out.trim()).toBe(
      "Tried jest first, then vitest; vitest stayed.",
    );

    const prompt = await readFile(
      join(repo.dataRoot, "stub-prompt.txt"),
      "utf8",
    );

    expect(prompt).toContain("wiki/second-brain/profile.md");
    expect(prompt).toContain("What did I try for fast tests?");
  });

  it("health certifies a synced second-brain vault's raw projection", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-brain-sync-"));

    tempDirs.push(dir);

    const vaultRoot = await generateFixtureVault(dir);
    const configPath = join(dir, "sync.json");
    const rawDir = join(dir, "raw");

    await writeFile(
      configPath,
      JSON.stringify({
        vaults: [{ name: "Brain", root: vaultRoot, exclude: "wiki:false" }],
      }),
    );

    const sync = await runCli(SYNC_SCRIPT, [configPath, rawDir]);

    expect(sync.code).toBe(0);

    const health = await runCli(HEALTH_SCRIPT, [rawDir]);

    expect(health.code).toBe(0);
    expect(health.out).toContain("healthy");
  });
});
