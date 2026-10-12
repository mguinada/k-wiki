import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seedDataRepo } from "../../src/data/init-data-repo.ts";
import {
  answerabilityFailures,
  correctnessFailures,
  filingFidelityFailures,
  fixtureFiles,
  main,
  worklistFailures,
  writeFixture,
} from "../../src/quality/content-quality-runner.ts";

const dirs: string[] = [];

const run = promisify(execFile);

/** A hermetic git identity for the seeded data repo: its commits (the
 *  seed commit and the query-filing commit) must not depend on the
 *  ambient machine's git identity config (CI runners carry none). The
 *  env seeds the initial commit; local config covers every later
 *  commit run inside the repo. Same pattern as
 *  tests/data/init-data-repo.test.ts and tests/schedule/sync-watchdog.test.ts. */
const GIT_ENV = {
  PATH: process.env.PATH,
  GIT_AUTHOR_NAME: "k-wiki test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "k-wiki test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  HOME: process.env.HOME,
};

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "k-wiki-quality-runner-"));
  dirs.push(root);
  return root;
}

async function seededDataRoot(): Promise<string> {
  const root = await tempRoot();
  const dataRoot = join(root, "data");
  await seedDataRepo({ dataRoot, env: GIT_ENV });
  await run("git", ["config", "user.name", "k-wiki test"], { cwd: dataRoot });
  await run("git", ["config", "user.email", "test@example.com"], {
    cwd: dataRoot,
  });
  return dataRoot;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("writeFixture", () => {
  it("writes every pinned fixture note under the vault root", async () => {
    const root = await tempRoot();
    const vault = await writeFixture(root);
    const written = (await readdir(vault, { recursive: true }))
      .filter((entry) => entry.endsWith(".md"))
      .sort();
    expect(written).toEqual([
      "Research/Agent Evaluation Source/Chapter One.md",
      "Research/Agent Evaluation Source/Chapter Two.md",
      "Research/borderline-term.md",
      "Research/fine-tuning.md",
      "Research/link-stubs.md",
      "Research/retrieval.md",
    ]);
  });

  it("writes fixture notes that opt every page into the wiki", async () => {
    const root = await tempRoot();
    const vault = await writeFixture(root);
    const chapter = await readFile(
      join(vault, "Research/Agent Evaluation Source/Chapter One.md"),
      "utf8",
    );
    expect(chapter).toMatch(/^---\nwiki: true\n---/);
  });
});

describe("correctnessFailures", () => {
  it("finds no floor violations in the freshly seeded skeleton repo", async () => {
    const dataRoot = await seededDataRoot();
    expect(await correctnessFailures(dataRoot)).toEqual([]);
  });
});

describe("filingFidelityFailures", () => {
  it("passes a web partition that files with its sources", async () => {
    const dataRoot = await seededDataRoot();
    expect(await filingFidelityFailures(dataRoot)).toEqual([]);
  });
});

describe("worklistFailures", () => {
  it("finds no mechanical defects in a contract-conforming wiki", async () => {
    const root = await tempRoot();
    const wiki = join(root, "wiki");
    await mkdir(wiki, { recursive: true });
    await writeFile(
      join(wiki, "index.md"),
      `---
title: Index
type: index
created: 2026-10-11
updated: 2026-10-11
tags:
  - test
---

Navigate: [[drift]].
`,
      "utf8",
    );
    await writeFile(
      join(wiki, "drift.md"),
      `---
title: Drift
type: source
created: 2026-10-11
updated: 2026-10-11
tags:
  - test
---

Calibration drift content.
`,
      "utf8",
    );
    expect(await worklistFailures(wiki)).toEqual([]);
  });
});

describe("answerabilityFailures", () => {
  it("reports only the questions no cited page covers", async () => {
    const root = await tempRoot();
    const wiki = join(root, "wiki");
    await mkdir(wiki, { recursive: true });
    await writeFile(
      join(wiki, "calibration-drift.md"),
      "---\ntitle: Calibration drift\n---\n\nCalibration drift appears only here.\n",
      "utf8",
    );
    const failures = await answerabilityFailures(root, [
      {
        question: "Where does calibration drift appear?",
        terms: ["calibration drift"],
        answer: "[[calibration-drift]]",
      },
      {
        question: "What does Procedure Beta use?",
        terms: ["procedure beta"],
        answer: "[[calibration-drift]]",
      },
    ]);
    expect(failures).toEqual([
      "query answerability: What does Procedure Beta use?",
    ]);
  });

  it("resolves citations into typed directories by page name", async () => {
    const root = await tempRoot();
    const wiki = join(root, "wiki", "concepts");
    await mkdir(wiki, { recursive: true });
    await writeFile(
      join(wiki, "calibration-drift.md"),
      "---\ntitle: Calibration drift\n---\n\nCalibration drift appears only here.\n",
      "utf8",
    );
    const failures = await answerabilityFailures(root, [
      {
        question: "Where does calibration drift appear?",
        terms: ["calibration drift"],
        answer: "[[calibration-drift]]",
      },
    ]);
    expect(failures).toEqual([]);
  });
});

describe("main", () => {
  it("prints the usage and exits cleanly on --help", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...line: unknown[]) => {
      logged.push(line.map(String).join(" "));
    });
    await main(["--help"]);
    expect(logged.join("\n")).toContain("Usage: content-quality-bench");
  });

  it("rejects a value flag left without its value", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...line: unknown[]) => {
      errors.push(line.map(String).join(" "));
    });
    const previous = process.exitCode;

    try {
      await main(["--settings"]);
    } finally {
      process.exitCode = previous;
    }

    expect(errors.join("\n")).toContain("--settings needs a path value");
  });
});

describe("fixtureFiles", () => {
  it("names every fixture note with its vault-relative path", () => {
    expect(Object.keys(fixtureFiles()).length).toBe(6);
  });
});
