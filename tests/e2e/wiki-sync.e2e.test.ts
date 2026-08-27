import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
  generateFixtureVault,
  VAULT_NAME,
} from "../../src/fixtures/generate.ts";
import { runCli, SYNC_CYCLE_SCRIPT } from "./helpers.ts";

/**
 * wiki-sync e2e: the real orchestrator CLI as a child process, driving
 * a stub agent through the full cycle — sync → ingest → lint → one
 * data-repo commit — then the no-change rerun (nothing to do) and a
 * tripped lint guardrail (revert, exit 1). The stub dispatches on the
 * real prompt files: the lint prompt starts "Audit the wiki", the
 * ingest prompts do not. A real LLM run stays a human check.
 */

const run = promisify(execFile);

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/**
 * The stub agent: ingest prompts write valid wiki pages; the lint
 * prompt additionally writes the lint report into the data repo's
 * outputs/ (where prompts/lint.md tells the agent to save it). A lint
 * variant that writes a broken page trips guardrail 2; an ingest
 * variant that fails outright tests the stopped chain.
 */
const STUB_AGENT = `#!/usr/bin/env node
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const index = process.argv.indexOf("--print");
const prompt = index === -1 ? undefined : process.argv[index + 1];
const mode = process.env.STUB_MODE ?? "";

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
      "stub body",
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
  const reportPath = prompt.match(/outputs\\/lint-\\d{4}-\\d{2}-\\d{2}\\.md/)?.[0];
  if (reportPath === undefined) process.exit(6);
  await mkdir(join(process.cwd(), "outputs"), { recursive: true });
  await writeFile(
    join(process.cwd(), reportPath),
    "# Lint report\\n\\nAll checks passed.\\n",
  );
  console.log("lint: all pages audited, no problems");
} else {
  console.log("stub agent: sources processed; no contradictions; no unresolved questions");
}
`;

interface Repo {
  readonly dataRoot: string;
  readonly configPath: string;
  readonly settingsPath: string;
  readonly outputsDir: string;
}

/** A domain wiki tree (wiki/ plus the sibling raw/manifest.json
 *  naming vault Engineering) for the cycle's crosslink audit to
 *  validate links against. */
async function makeDomainWiki(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "k-wiki-eng-wiki-"));

  tempDirs.push(dir);

  await mkdir(join(dir, "wiki"), { recursive: true });
  await mkdir(join(dir, "raw"), { recursive: true });
  await writeFile(join(dir, "wiki", "index.md"), "# Engineering\n");
  await writeFile(join(dir, "wiki", "stub.md"), "# Stub\n");
  await writeFile(
    join(dir, "raw", "manifest.json"),
    `${JSON.stringify({ vaults: { Engineering: {} } }, null, 2)}\n`,
  );

  return join(dir, "wiki");
}

/** Point a repo's settings at a domain wiki for the crosslink stage
 *  and mark the data repo as a second brain (the operator-owned
 *  `.second-brain` marker, issue #94). */
async function configureDomains(repo: Repo, domainWiki: string) {
  await writeFile(join(repo.dataRoot, ".second-brain"), "");
  await writeFile(
    repo.settingsPath,
    `command: ${join(repo.dataRoot, "stub-agent.mjs")}\nmodel: E2E-MODEL\nreasoning: low\nsecondBrain.domains: [${domainWiki}]\n`,
  );
}

/** A temp data repo plus fixture vault, sync.json, and stub agent. */
async function makeRepo(): Promise<Repo> {
  const tmp = await mkdtemp(join(tmpdir(), "k-wiki-sync-e2e-"));

  tempDirs.push(tmp);

  const dataRoot = join(tmp, "data");
  const vaultRoot = await generateFixtureVault(tmp);
  const configPath = join(tmp, "sync.json");
  const settingsPath = join(tmp, "settings.yml");
  const outputsDir = join(tmp, "outputs");

  await writeFile(
    configPath,
    JSON.stringify({
      vaults: [{ name: VAULT_NAME, root: vaultRoot, exclude: "wiki:false" }],
    }),
  );
  await mkdir(join(dataRoot, "raw"), { recursive: true });
  await mkdir(join(dataRoot, "wiki"), { recursive: true });
  await writeFile(
    join(dataRoot, "raw", "manifest.json"),
    `${JSON.stringify({ vaults: {} }, null, 2)}\n`,
  );
  await writeFile(join(dataRoot, "wiki", "index.md"), "# Index\n");
  await run("git", ["init", "--quiet"], { cwd: dataRoot });
  await run("git", ["config", "user.email", "t@t"], { cwd: dataRoot });
  await run("git", ["config", "user.name", "t"], { cwd: dataRoot });
  await run("git", ["add", "-A"], { cwd: dataRoot });
  await run("git", ["commit", "--quiet", "-m", "init"], { cwd: dataRoot });
  await writeFile(join(dataRoot, "stub-agent.mjs"), STUB_AGENT, {
    mode: 0o755,
  });
  await writeFile(
    settingsPath,
    `command: ${join(dataRoot, "stub-agent.mjs")}\nmodel: E2E-MODEL\nreasoning: low\n`,
  );

  return { dataRoot, configPath, settingsPath, outputsDir };
}

function runCycle(repo: Repo, extraEnv: NodeJS.ProcessEnv = {}) {
  return runCli(
    SYNC_CYCLE_SCRIPT,
    [
      "--settings",
      repo.settingsPath,
      "--outputs",
      repo.outputsDir,
      repo.configPath,
      join(repo.dataRoot, "raw"),
    ],
    { env: extraEnv },
  );
}

/** A temp data repo plus a committed temp source repo and a
 *  repo-sourced config (the meta shape, issue #145) — the sync-repo
 *  fixture pattern from sync-repo.e2e.test.ts, wired for the cycle. */
async function makeRepoSourcedRepo(): Promise<
  Repo & { readonly sourceRoot: string }
> {
  const tmp = await mkdtemp(join(tmpdir(), "k-wiki-meta-e2e-"));

  tempDirs.push(tmp);

  const sourceRoot = join(tmp, "source");

  await mkdir(join(sourceRoot, "docs"), { recursive: true });
  await writeFile(join(sourceRoot, "README.md"), "readme body\n");
  await writeFile(join(sourceRoot, "docs", "guide.md"), "guide\n");
  await run("git", ["init", "--quiet"], { cwd: sourceRoot });
  await run("git", ["config", "user.email", "t@t"], { cwd: sourceRoot });
  await run("git", ["config", "user.name", "t"], { cwd: sourceRoot });
  await run("git", ["add", "-A"], { cwd: sourceRoot });
  await run("git", ["commit", "--quiet", "-m", "fixture"], {
    cwd: sourceRoot,
  });

  const dataRoot = join(tmp, "data");
  const configPath = join(tmp, "sync-meta.json");
  const settingsPath = join(tmp, "settings.yml");
  const outputsDir = join(tmp, "outputs");

  await writeFile(
    configPath,
    JSON.stringify({
      vaults: [
        {
          source: "repo",
          name: "k-wiki",
          root: sourceRoot,
          include: ["README.md", "docs/*.md"],
        },
      ],
    }),
  );
  await mkdir(join(dataRoot, "raw"), { recursive: true });
  await mkdir(join(dataRoot, "wiki"), { recursive: true });
  await writeFile(
    join(dataRoot, "raw", "manifest.json"),
    `${JSON.stringify({ vaults: {} }, null, 2)}\n`,
  );
  await writeFile(join(dataRoot, "wiki", "index.md"), "# Index\n");
  await run("git", ["init", "--quiet"], { cwd: dataRoot });
  await run("git", ["config", "user.email", "t@t"], { cwd: dataRoot });
  await run("git", ["config", "user.name", "t"], { cwd: dataRoot });
  await run("git", ["add", "-A"], { cwd: dataRoot });
  await run("git", ["commit", "--quiet", "-m", "init"], { cwd: dataRoot });
  await writeFile(join(dataRoot, "stub-agent.mjs"), STUB_AGENT, {
    mode: 0o755,
  });
  await writeFile(
    settingsPath,
    `command: ${join(dataRoot, "stub-agent.mjs")}\nmodel: E2E-MODEL\nreasoning: low\n`,
  );

  return { dataRoot, configPath, settingsPath, outputsDir, sourceRoot };
}

describe("wiki-sync e2e", () => {
  it("answers --help with usage and exit 0", async () => {
    const result = await runCli(SYNC_CYCLE_SCRIPT, ["--help"]);

    expect(`${result.code}|${result.out}`).toMatch(/0\|Usage: wiki-sync/);
  });

  it("runs the full cycle into one readable data-repo commit", async () => {
    const repo = await makeRepo();
    const result = await runCycle(repo);
    const lintPath =
      /- \*\*Lint:\*\* report `(outputs\/lint-\d{4}-\d{2}-\d{2}\.md)`/.exec(
        result.out,
      )?.[1];

    if (lintPath === undefined) {
      throw new Error("expected a lint report path in the digest");
    }

    expect(result.code).toBe(0);
    expect(result.out).toContain("# wiki-sync cycle digest");
    expect(result.out).toContain(`**Lint:** report \`${lintPath}\``);
    expect(result.out).toMatch(
      /- \*\*Fidelity:\*\* ok — \d+ tokens? trace to origins, \d+ titles? match(?:es)? across \d+ pages?/,
    );
    expect(result.out).toMatch(
      /- \*\*Provenance:\*\* ok — \d+ source links? resolve, \d+ origins? exist(?:s)? across \d+ pages?/,
    );
    expect(result.out).toContain("**Commit:** `");

    const { stdout: log } = await run("git", ["log", "-1", "--pretty=%B"], {
      cwd: repo.dataRoot,
    });

    expect(log).toMatch(
      /^wiki-sync: \d+ sources processed, \d+ pages touched$/m,
    );
    expect(log).toContain(`- lint: ${lintPath}`);

    await expect(
      readFile(join(repo.dataRoot, lintPath), "utf8"),
    ).resolves.toContain("Lint report");
    await expect(
      readFile(join(repo.dataRoot, "wiki", "concepts", "stub.md"), "utf8"),
    ).resolves.toContain("stub body");
    await expect(
      readFile(
        join(repo.dataRoot, "raw", "notes", VAULT_NAME, "AI", "RAG.md"),
        "utf8",
      ),
    ).resolves.toContain("RAG");
  });

  it("prints the cycle's commit hash in the digest", async () => {
    const repo = await makeRepo();
    const result = await runCycle(repo);
    const { stdout: hash } = await run("git", ["rev-parse", "HEAD"], {
      cwd: repo.dataRoot,
    });

    expect(result.out).toContain(hash.trim().slice(0, 8));
  });

  it("does nothing on a rerun with no vault changes", async () => {
    const repo = await makeRepo();

    await runCycle(repo);

    const { stdout: head } = await run("git", ["rev-parse", "HEAD"], {
      cwd: repo.dataRoot,
    });
    const result = await runCycle(repo);

    expect(result.code).toBe(0);
    expect(result.out).toContain("nothing to do");

    const { stdout: headAfter } = await run("git", ["rev-parse", "HEAD"], {
      cwd: repo.dataRoot,
    });

    expect(headAfter).toBe(head);
  });

  it("stops the chain with exit 1 and no commit when the ingest agent fails", async () => {
    const repo = await makeRepo();

    const { stdout: head } = await run("git", ["rev-parse", "HEAD"], {
      cwd: repo.dataRoot,
    });
    const result = await runCycle(repo, { STUB_MODE: "fail-ingest" });

    expect(result.code).toBe(1);
    expect(result.err).toContain("code 4");

    const { stdout: headAfter } = await run("git", ["rev-parse", "HEAD"], {
      cwd: repo.dataRoot,
    });

    expect(headAfter).toBe(head);
  });

  it("runs the crosslink audit in the cycle when secondBrain.domains is configured", async () => {
    const repo = await makeRepo();
    const domainWiki = await makeDomainWiki();

    await configureDomains(repo, domainWiki);

    const result = await runCycle(repo, { STUB_MODE: "link-domain" });

    expect(result.code).toBe(0);
    expect(result.out).toContain(
      "- **Crosslinks:** ok — 1 cross-wiki link against 2 domain pages",
    );
  });

  it("fails the cycle naming a broken cross-wiki link, with no commit", async () => {
    const repo = await makeRepo();
    const domainWiki = await makeDomainWiki();

    await configureDomains(repo, domainWiki);

    const { stdout: head } = await run("git", ["rev-parse", "HEAD"], {
      cwd: repo.dataRoot,
    });
    const result = await runCycle(repo, { STUB_MODE: "link-broken" });

    expect(result.code).toBe(1);
    expect(result.err).toContain("crosslink audit failed");
    expect(result.err).toMatch(
      /wiki\/decision\.md:\d+ -> \[\[engineering\/missing\]\]/,
    );

    const { stdout: headAfter } = await run("git", ["rev-parse", "HEAD"], {
      cwd: repo.dataRoot,
    });

    expect(headAfter).toBe(head);
  });

  it("reverts a tripped lint guardrail and leaves no commit", async () => {
    const repo = await makeRepo();

    const { stdout: head } = await run("git", ["rev-parse", "HEAD"], {
      cwd: repo.dataRoot,
    });
    const result = await runCycle(repo, { STUB_MODE: "break-lint" });

    expect(result.code).toBe(1);
    expect(result.err).toContain("lint guardrail check 2 (frontmatter)");

    await expect(
      readFile(join(repo.dataRoot, "wiki", "concepts", "broken.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(repo.dataRoot, "wiki", "concepts", "stub.md"), "utf8"),
    ).resolves.toContain("stub body");

    const { stdout: headAfter } = await run("git", ["rev-parse", "HEAD"], {
      cwd: repo.dataRoot,
    });

    expect(headAfter).toBe(head);
  });

  it("reverts the lint edits and keeps the ingest edits when the fidelity check fails", async () => {
    const repo = await makeRepo();

    const { stdout: head } = await run("git", ["rev-parse", "HEAD"], {
      cwd: repo.dataRoot,
    });
    const result = await runCycle(repo, { STUB_MODE: "break-fidelity" });

    expect(result.code).toBe(1);
    expect(result.err).toContain("fidelity check failed");
    expect(result.err).toMatch(
      /concepts\/drifted\.md -> title "Elsewhere" does not kebab to drifted/,
    );

    await expect(
      readFile(join(repo.dataRoot, "wiki", "concepts", "drifted.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(repo.dataRoot, "wiki", "concepts", "stub.md"), "utf8"),
    ).resolves.toContain("stub body");

    const { stdout: headAfter } = await run("git", ["rev-parse", "HEAD"], {
      cwd: repo.dataRoot,
    });

    expect(headAfter).toBe(head);
  });

  it("runs the full cycle for a repo-sourced instance (the meta flow)", async () => {
    const repo = await makeRepoSourcedRepo();
    const result = await runCycle(repo);

    expect(result.code).toBe(0);
    expect(result.out).toContain("# wiki-sync cycle digest");
    expect(result.out).toContain("2 sources copied, 0 sources removed");
    expect(result.err).toContain("wiki-sync: stage 1/5 — sync-repo");

    await expect(
      readFile(
        join(repo.dataRoot, "raw", "notes", "k-wiki", "README.md"),
        "utf8",
      ),
    ).resolves.toBe("readme body\n");

    const manifest = JSON.parse(
      await readFile(join(repo.dataRoot, "raw", "manifest.json"), "utf8"),
    );
    const { stdout: sourceHead } = await run("git", [
      "-C",
      repo.sourceRoot,
      "rev-parse",
      "HEAD",
    ]);

    expect(manifest.source_commit).toBe(sourceHead.trim());

    const { stdout: log } = await run("git", ["log", "-1", "--pretty=%B"], {
      cwd: repo.dataRoot,
    });

    expect(log).toMatch(/^wiki-sync: 2 sources processed, 3 pages touched$/m);
  });

  it("does nothing on a repo-sourced rerun with no source changes", async () => {
    const repo = await makeRepoSourcedRepo();

    await runCycle(repo);

    const { stdout: head } = await run("git", ["rev-parse", "HEAD"], {
      cwd: repo.dataRoot,
    });
    const result = await runCycle(repo);

    expect(result.code).toBe(0);
    expect(result.out).toContain("nothing to do");

    const { stdout: headAfter } = await run("git", ["rev-parse", "HEAD"], {
      cwd: repo.dataRoot,
    });

    expect(headAfter).toBe(head);
  });
});
