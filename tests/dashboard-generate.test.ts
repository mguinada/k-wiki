import { execFile as execFileCb } from "node:child_process";
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
import { afterAll, describe, expect, it, vi } from "vitest";
import { writeDashboard } from "../src/dashboard/generate.ts";

/**
 * The generator's contract over a real temp data repo (issue #73):
 * read the listed artifacts, write nothing but dashboard.html, stamp
 * timestamp + HEAD, degrade gracefully, and print accurate help.
 */

const run = promisify(execFileCb);

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
  });
}

/** A data repo: raw notes + manifest, wiki pages, git history. */
async function makeDataRepo(): Promise<string> {
  const dataRoot = await mkdtemp(join(tmpdir(), "k-wiki-dash-"));

  tempDirs.push(dataRoot);

  await mkdir(join(dataRoot, "raw", "notes", "Engineering"), {
    recursive: true,
  });
  await mkdir(join(dataRoot, "wiki", "concepts"), { recursive: true });
  await mkdir(join(dataRoot, "outputs"), { recursive: true });

  await writeFile(join(dataRoot, "raw", "notes", "Engineering", "a.md"), "a");
  await writeFile(join(dataRoot, "raw", "notes", "Engineering", "b.md"), "b");

  await writeFile(
    join(dataRoot, "raw", "manifest.json"),
    `${JSON.stringify(
      {
        vaults: {
          Engineering: {
            "a.md": { hash: "x", last_synced: "2026-08-30T00:00:00.000Z" },
            "b.md": { hash: "y", last_synced: "2026-08-30T00:00:00.000Z" },
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  await writeFile(
    join(dataRoot, "wiki", "concepts", "agent-evals.md"),
    [
      "---",
      'title: "Agent evals"',
      "type: concept",
      "created: 2026-08-20",
      "updated: 2026-08-25",
      "status: stable",
      "sources:",
      '  - "[[beginner-roadmap]]"',
      "---",
      "",
      "See [[beginner-roadmap]].",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(dataRoot, "wiki", "beginner-roadmap.md"),
    [
      "---",
      'title: "Beginner roadmap"',
      "type: source",
      "created: 2026-05-01",
      "updated: 2026-05-01",
      "status: needs-review",
      "sources:",
      '  - "notes/Engineering/a.md"',
      "---",
      "",
      "Body.",
      "",
    ].join("\n"),
  );

  await run("git", ["init", "--quiet"], { cwd: dataRoot });
  await git(dataRoot, "add", "-A");
  await git(dataRoot, "commit", "--quiet", "-m", "init");
  await git(
    dataRoot,
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "wiki-sync: 9 sources processed, 45 pages touched",
  );

  return dataRoot;
}

describe("writeDashboard", () => {
  it("writes a self-contained dashboard.html into the data repo root", async () => {
    const dataRoot = await makeDataRepo();

    const path = await writeDashboard(dataRoot, {
      now: () => new Date("2026-09-01T12:00:00.000Z"),
    });

    expect(path).toBe(join(dataRoot, "dashboard.html"));

    const html = await readFile(path, "utf8");

    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("prefers-color-scheme");
  });

  it("stamps the data repo HEAD into the page", async () => {
    const dataRoot = await makeDataRepo();
    const { stdout } = await run("git", ["rev-parse", "--short", "HEAD"], {
      cwd: dataRoot,
    });

    const html = await readFile(
      await writeDashboard(dataRoot, {
        now: () => new Date("2026-09-01T12:00:00.000Z"),
      }),
      "utf8",
    );

    expect(html).toContain(stdout.trim());
  });

  it("writes nothing but dashboard.html", async () => {
    const dataRoot = await makeDataRepo();

    const before = new Set(await readdir(dataRoot));

    await writeDashboard(dataRoot, {
      now: () => new Date("2026-09-01T12:00:00.000Z"),
    });

    const after = await readdir(dataRoot);

    expect(after.filter((name) => !before.has(name))).toEqual([
      "dashboard.html",
    ]);
  });

  it("computes KPIs from the repo's artifacts", async () => {
    const dataRoot = await makeDataRepo();

    const html = await readFile(
      await writeDashboard(dataRoot, {
        now: () => new Date("2026-09-01T12:00:00.000Z"),
      }),
      "utf8",
    );

    expect(html).toContain("needs-review");
    expect(html).toContain("beginner-roadmap.md");
  });

  it("hides the query funnel when last-query.md is absent", async () => {
    const dataRoot = await makeDataRepo();

    const html = await readFile(
      await writeDashboard(dataRoot, {
        now: () => new Date("2026-09-01T12:00:00.000Z"),
      }),
      "utf8",
    );

    expect(html).not.toContain("Query funnel");
  });

  it("shows the query funnel when last-query.md exists", async () => {
    const dataRoot = await makeDataRepo();

    await writeFile(
      join(dataRoot, "outputs", "last-query.md"),
      [
        "---",
        'question: "Why eval?"',
        'timestamp: "2026-08-30T10:00:00.000Z"',
        "pages: []",
        "---",
        "",
        "Because.",
        "",
      ].join("\n"),
    );

    const html = await readFile(
      await writeDashboard(dataRoot, {
        now: () => new Date("2026-09-01T12:00:00.000Z"),
      }),
      "utf8",
    );

    expect(html).toContain("Query funnel");
    expect(html).toContain("2026-08-30");
  });

  it("warns when the data repo gitignore lacks dashboard.html", async () => {
    const dataRoot = await makeDataRepo();
    const warnings: string[] = [];

    await writeDashboard(dataRoot, {
      now: () => new Date("2026-09-01T12:00:00.000Z"),
      warn: (message) => warnings.push(message),
    });

    expect(warnings.join("\n")).toContain("dashboard.html");
  });

  it("stays silent when the gitignore already lists dashboard.html", async () => {
    const dataRoot = await makeDataRepo();
    const warnings: string[] = [];

    await writeFile(join(dataRoot, ".gitignore"), "dashboard.html\n");

    await writeDashboard(dataRoot, {
      now: () => new Date("2026-09-01T12:00:00.000Z"),
      warn: (message) => warnings.push(message),
    });

    expect(warnings).toEqual([]);
  });

  it("counts backlog from the ingest snapshot when present", async () => {
    const dataRoot = await makeDataRepo();

    await writeFile(
      join(dataRoot, "outputs", "last-ingested-manifest.json"),
      `${JSON.stringify({
        snapshotFor: dataRoot,
        vaults: { Engineering: { "a.md": { hash: "x", last_synced: "t" } } },
      })}\n`,
    );

    const html = await readFile(
      await writeDashboard(dataRoot, {
        now: () => new Date("2026-09-01T12:00:00.000Z"),
      }),
      "utf8",
    );

    expect(html).toContain("1"); // b.md pending
  });

  it("still generates when the wiki directory is missing", async () => {
    const dataRoot = await makeDataRepo();

    await rm(join(dataRoot, "wiki"), { recursive: true });

    const path = await writeDashboard(dataRoot, {
      now: () => new Date("2026-09-01T12:00:00.000Z"),
    });

    expect((await readFile(path, "utf8")).startsWith("<!DOCTYPE html>")).toBe(
      true,
    );
  });
});

describe("dashboard CLI", () => {
  it("prints help for --help without side effects", async () => {
    const dataRoot = await makeDataRepo();

    const htmlBefore = await readFile(
      await writeDashboard(dataRoot, {
        now: () => new Date("2026-09-01T12:00:00.000Z"),
      }),
      "utf8",
    );

    const { main } = await import("../src/dashboard/generate.ts");
    const argv = process.argv;
    const out: string[] = [];
    const err: string[] = [];

    process.argv = [...argv.slice(0, 2), "--help"];

    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...parts: unknown[]) => out.push(parts.join(" ")));
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...parts: unknown[]) => err.push(parts.join(" ")));

    try {
      await main();
    } finally {
      process.argv = argv;
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(out.join("\n")).toContain("Usage: dashboard");
    expect(process.exitCode).toBeUndefined();

    const htmlAfter = await readFile(join(dataRoot, "dashboard.html"), "utf8");

    expect(htmlAfter).toBe(htmlBefore);
  });
});
