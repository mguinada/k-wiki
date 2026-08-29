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
import { repoRoot, runCli } from "./helpers.ts";

const SCHEDULED_RUN_SCRIPT = join(repoRoot, "bin", "scheduled-run.ts");

/**
 * scheduled-run e2e (issue #14): the real unattended wrapper as a
 * child process, run the way launchd runs it — a minimal PATH, no
 * shell env — against a temp data repo wired to a bare upstream
 * origin through a stub agent. Covers the full lock → pull →
 * wiki-sync → push cycle, the busy-lock skip, the push-rejection
 * retry (a pre-receive hook that rejects once), and the alert after a
 * second rejection. A real LLM run stays a human check.
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
 * prompt (starts "Audit the wiki") additionally writes the lint
 * report into the data repo's outputs/. Same shape as the wiki-sync
 * e2e stub, trimmed to the no-second-brain flow.
 */
const STUB_AGENT = `#!/usr/bin/env node
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const index = process.argv.indexOf("--print");
const prompt = index === -1 ? undefined : process.argv[index + 1];

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

const frontmatter = (title, type, extra) => [
  "---",
  'title: "' + title + '"',
  "type: " + type,
  "created: 2026-08-20",
  "updated: 2026-08-20",
  "tags:",
  "  - llm",
  ...extra,
  "---",
  "",
].join("\\n");

await mkdir(join(process.cwd(), "wiki", "concepts"), { recursive: true });
await mkdir(join(process.cwd(), "wiki", "sources"), { recursive: true });
const note = await firstNote(join(process.cwd(), "raw", "notes"));
const origin = (
  note ?? process.cwd() + "/raw/notes/unresolved/placeholder.md"
).slice((process.cwd() + "/").length);

await writeFile(
  join(process.cwd(), "wiki", "sources", "stub-source.md"),
  frontmatter("Stub source", "source", ["origin: " + origin, "sources:", '  - "[[stub-source]]"']) + "hub body\\n",
);
await writeFile(
  join(process.cwd(), "wiki", "concepts", "stub.md"),
  frontmatter("Stub", "concept", ["sources:", '  - "[[stub-source]]"']) + "stub body\\n",
);
await writeFile(
  join(process.cwd(), "wiki", "index.md"),
  frontmatter("Index", "topic", ["sources:", '  - "[[stub-source]]"']) + "# Index v2\\n",
);

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
  readonly tmp: string;
  readonly dataRoot: string;
  readonly configPath: string;
  readonly settingsPath: string;
  readonly outputsDir: string;
  readonly upstream: string;
}

async function git(args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await run("git", args, { cwd });

  return stdout;
}

/** A temp data repo plus fixture vault, sync.json, stub agent, and a
 *  bare upstream origin the wrapper can push to. */
async function makeRepo(): Promise<Repo> {
  const tmp = await mkdtemp(join(tmpdir(), "k-wiki-sched-e2e-"));

  tempDirs.push(tmp);

  const dataRoot = join(tmp, "data");
  const upstream = join(tmp, "upstream.git");
  const vaultRoot = await generateFixtureVault(tmp);
  const configPath = join(tmp, "sync.json");
  const settingsPath = join(tmp, "settings.yml");
  const outputsDir = join(tmp, "outputs");

  await writeFile(
    configPath,
    JSON.stringify({
      dataRoot,
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
  await git(["init", "--quiet", "--initial-branch=main"], dataRoot);
  await git(["config", "user.email", "t@t"], dataRoot);
  await git(["config", "user.name", "t"], dataRoot);
  await git(["add", "-A"], dataRoot);
  await git(["commit", "--quiet", "-m", "init"], dataRoot);
  await git(
    ["init", "--quiet", "--bare", "--initial-branch=main", upstream],
    tmp,
  );
  await git(["remote", "add", "origin", upstream], dataRoot);
  await git(["push", "--quiet", "-u", "origin", "main"], dataRoot);
  await writeFile(join(dataRoot, "stub-agent.mjs"), STUB_AGENT, {
    mode: 0o755,
  });
  await writeFile(
    settingsPath,
    `command: ${join(dataRoot, "stub-agent.mjs")}\nmodel: E2E-MODEL\nreasoning: low\n`,
  );

  return { tmp, dataRoot, configPath, settingsPath, outputsDir, upstream };
}

/** Run the wrapper the way launchd does: minimal PATH, no shell env
 *  beyond HOME — the wrapper builds the rest. The log goes to a temp
 *  file, never the operator's. */
function runScheduled(repo: Repo, extraEnv: NodeJS.ProcessEnv = {}) {
  return runCli(
    SCHEDULED_RUN_SCRIPT,
    [
      "--settings",
      repo.settingsPath,
      "--outputs",
      repo.outputsDir,
      repo.configPath,
      join(repo.dataRoot, "raw"),
    ],
    {
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        KWIKI_SCHEDULED_LOG: join(repo.tmp, "scheduled-run.log"),
        ...extraEnv,
      },
    },
  );
}

function lockPath(repo: Repo): string {
  return join(repo.dataRoot, ".scheduled-run.lock");
}

async function upstreamHead(repo: Repo): Promise<string> {
  return (
    await git(["log", "main", "-1", "--pretty=%s"], repo.upstream)
  ).trim();
}

describe("scheduled-run e2e", () => {
  it("answers --help with usage and exit 0", async () => {
    const result = await runCli(SCHEDULED_RUN_SCRIPT, ["--help"]);

    expect(`${result.code}|${result.out}`).toMatch(/0\|Usage: scheduled-run/);
  });

  it("runs the full cycle and pushes the commit to the upstream", async () => {
    const repo = await makeRepo();
    const result = await runScheduled(repo);

    expect(result.code).toBe(0);
    expect(await upstreamHead(repo)).toMatch(
      /^wiki-sync: \d+ sources? processed/,
    );
    await expect(readFile(lockPath(repo), "utf8")).rejects.toThrow();
    await expect(
      readFile(join(repo.tmp, "scheduled-run.log"), "utf8"),
    ).resolves.toContain("cycle complete");
  });

  it("runs the second cycle as a no-op and pushes nothing", async () => {
    const repo = await makeRepo();

    await runScheduled(repo);

    const head = await upstreamHead(repo);
    const result = await runScheduled(repo);

    expect(result.code).toBe(0);
    expect(await upstreamHead(repo)).toBe(head);
  });

  it("skips without touching git while a fresh lock exists", async () => {
    const repo = await makeRepo();
    const first = await runScheduled(repo);

    expect(first.code).toBe(0);

    const head = await upstreamHead(repo);

    await writeFile(
      lockPath(repo),
      `${JSON.stringify({ pid: 1, takenAt: new Date().toISOString() })}\n`,
    );

    const result = await runScheduled(repo);

    expect(result.code).toBe(0);
    expect(result.out).toContain("skipped");
    expect(await upstreamHead(repo)).toBe(head);
  });

  it("recovers a push rejection via pull --rebase and one retry", async () => {
    const repo = await makeRepo();
    // A pre-receive hook that rejects exactly the first push: the
    // benign lost-the-push-race, simulated against real git.
    const hook = join(repo.upstream, "hooks", "pre-receive");

    await mkdir(join(repo.upstream, "hooks"), { recursive: true });
    await writeFile(
      hook,
      '#!/bin/sh\ncount=$(ls "$(dirname "$0")"/*.seen 2>/dev/null | wc -l)\ntouch "$(dirname "$0")/push.seen"\n[ "$count" -ge 1 ]\n',
      { mode: 0o755 },
    );

    const result = await runScheduled(repo);

    expect(result.code).toBe(0);
    expect(await upstreamHead(repo)).toMatch(/^wiki-sync:/);
    await expect(
      readFile(join(repo.tmp, "scheduled-run.log"), "utf8"),
    ).resolves.toContain("pushed after retry");
  });

  it("alerts and exits 1 when the push fails twice", async () => {
    const repo = await makeRepo();
    const hook = join(repo.upstream, "hooks", "pre-receive");

    await mkdir(join(repo.upstream, "hooks"), { recursive: true });
    await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    const result = await runScheduled(repo);

    expect(result.code).toBe(1);
    expect(result.err).toContain("push");
    await expect(
      readFile(join(repo.tmp, "scheduled-run.log"), "utf8"),
    ).resolves.toContain("ALERT");
    // The wiki stays at the last good commit — the commit never
    // reached upstream.
    expect(await upstreamHead(repo)).toBe("init");
  });
});
