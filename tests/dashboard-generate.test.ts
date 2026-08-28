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
import { collectData } from "../src/dashboard/collect.ts";
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

  it("excludes the operating-contract files from the growth count", async () => {
    const dataRoot = await makeDataRepo();

    await writeFile(join(dataRoot, "wiki", "AGENTS.md"), "contract\n");
    await writeFile(join(dataRoot, "wiki", "AGENTS.meta.md"), "meta\n");
    await writeFile(
      join(dataRoot, "wiki", "extra-page.md"),
      "---\ntype: concept\n---\n\nBody.\n",
    );
    await run(
      "git",
      ["add", "wiki/AGENTS.md", "wiki/AGENTS.meta.md", "wiki/extra-page.md"],
      { cwd: dataRoot },
    );
    await git(
      dataRoot,
      "commit",
      "--quiet",
      "--date=2029-12-20T10:00:00Z",
      "-m",
      "contracts and a page",
    );

    const html = await readFile(
      await writeDashboard(dataRoot, {
        now: () => new Date("2030-01-01T12:00:00.000Z"),
      }),
      "utf8",
    );

    expect(html).toContain(
      '<span class="stat-value">3</span><span class="stat-label">pages added, cumulative',
    );
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

  it("reads quoted frontmatter values", async () => {
    const dataRoot = await makeDataRepo();

    await writeFile(
      join(dataRoot, "wiki", "quoted.md"),
      [
        "---",
        'title: "Quoted"',
        "type: source",
        'status: "needs-review"',
        'updated: "2026-05-01"',
        "sources:",
        '  - "notes/Engineering/a.md"',
        "---",
        "",
        "Body.",
        "",
      ].join("\n"),
    );

    const html = await readFile(
      await writeDashboard(dataRoot, {
        now: () => new Date("2026-09-01T12:00:00.000Z"),
      }),
      "utf8",
    );

    expect(html).toContain("&gt; 90 days");
  });

  it("ignores non-vault files at the raw notes root", async () => {
    const dataRoot = await makeDataRepo();

    await writeFile(join(dataRoot, "raw", "notes", ".gitkeep"), "");

    const path = await writeDashboard(dataRoot, {
      now: () => new Date("2026-09-01T12:00:00.000Z"),
    });

    expect((await readFile(path, "utf8")).startsWith("<!DOCTYPE html>")).toBe(
      true,
    );
  });

  it("treats an unparseable snapshot as absent", async () => {
    const dataRoot = await makeDataRepo();

    await writeFile(
      join(dataRoot, "outputs", "last-ingested-manifest.json"),
      "not json",
    );

    const html = await readFile(
      await writeDashboard(dataRoot, {
        now: () => new Date("2026-09-01T12:00:00.000Z"),
      }),
      "utf8",
    );

    expect(html).toContain("no ingest snapshot found");
  });
});

describe("collectData", () => {
  /** A repo whose raw manifest exercises vault order and stamp order:
   *  Zeta oldest-first, Alpha newest-first and overall newest, Beta
   *  trailing, Delta carrying junk entries. */
  async function makeManifestRepo(
    vaults: Record<string, unknown>,
  ): Promise<string> {
    const dataRoot = await makeDataRepo();

    await writeFile(
      join(dataRoot, "raw", "manifest.json"),
      `${JSON.stringify({ vaults })}\n`,
    );

    return dataRoot;
  }

  const orderedVaults = {
    Zeta: {
      "z1.md": { hash: "z1", last_synced: "2026-07-10T00:00:00.000Z" },
      "z2.md": { hash: "z2", last_synced: "2026-08-01T00:00:00.000Z" },
    },
    Alpha: {
      "a.md": { hash: "a", last_synced: "2026-09-25T00:00:00.000Z" },
      "b.md": { hash: "b", last_synced: "2026-08-15T00:00:00.000Z" },
    },
    Beta: {
      "c.md": { hash: "c", last_synced: "2026-07-01T00:00:00.000Z" },
    },
    Delta: {
      "d.md": null,
      "e.md": { hash: "e" },
      "f.md": "junk",
    },
  };

  it("returns the newest sync stamp across vaults", async () => {
    const input = await collectData(await makeManifestRepo(orderedVaults));

    expect(input.lastSync).toBe("2026-09-25T00:00:00.000Z");
  });

  it("returns the newest sync stamp when a vault's stamps run oldest-first", async () => {
    const input = await collectData(
      await makeManifestRepo({
        Alpha: {
          "a.md": { hash: "a", last_synced: "2026-08-15T00:00:00.000Z" },
          "b.md": { hash: "b", last_synced: "2026-09-25T00:00:00.000Z" },
        },
        Beta: {
          "c.md": { hash: "c", last_synced: "2026-07-01T00:00:00.000Z" },
        },
      }),
    );

    expect(input.lastSync).toBe("2026-09-25T00:00:00.000Z");
  });

  it("lists one sync entry per manifest note that has a string last_synced", async () => {
    const input = await collectData(await makeManifestRepo(orderedVaults));

    expect(input.rawNoteSyncDates).toEqual([
      { key: "Zeta/z1.md", lastSynced: "2026-07-10T00:00:00.000Z" },
      { key: "Zeta/z2.md", lastSynced: "2026-08-01T00:00:00.000Z" },
      { key: "Alpha/a.md", lastSynced: "2026-09-25T00:00:00.000Z" },
      { key: "Alpha/b.md", lastSynced: "2026-08-15T00:00:00.000Z" },
      { key: "Beta/c.md", lastSynced: "2026-07-01T00:00:00.000Z" },
    ]);
  });

  it("rejects when last-query.md exists but is not readable as a file", async () => {
    const dataRoot = await makeManifestRepo(orderedVaults);

    await mkdir(join(dataRoot, "outputs", "last-query.md"));

    await expect(collectData(dataRoot)).rejects.toThrow(/EISDIR/);
  });

  it("reports no lastSync when the raw manifest is missing", async () => {
    const dataRoot = await makeDataRepo();

    await rm(join(dataRoot, "raw", "manifest.json"));

    const input = await collectData(dataRoot);

    expect(input.lastSync).toBeNull();
  });

  it("treats a non-object raw manifest as absent", async () => {
    const dataRoot = await makeDataRepo();

    await writeFile(join(dataRoot, "raw", "manifest.json"), "42\n");

    const input = await collectData(dataRoot);

    expect(input.lastSync).toBeNull();
  });

  it("skips manifest vaults whose entries are not objects", async () => {
    const input = await collectData(
      await makeManifestRepo({
        Good: {
          "x.md": { hash: "x", last_synced: "2026-01-01T00:00:00.000Z" },
        },
        Bad: null,
      }),
    );

    expect(input.rawNoteSyncDates).toEqual([
      { key: "Good/x.md", lastSynced: "2026-01-01T00:00:00.000Z" },
    ]);
  });

  it("collects the ingest snapshot's note keys, skipping non-object vaults", async () => {
    const dataRoot = await makeDataRepo();

    await writeFile(
      join(dataRoot, "outputs", "last-ingested-manifest.json"),
      `${JSON.stringify({
        vaults: {
          Engineering: { "a.md": { hash: "x", last_synced: "t" } },
          Bad: null,
        },
      })}\n`,
    );

    const input = await collectData(dataRoot);

    expect(input.ingestedKeys).toEqual(["Engineering/a.md"]);
  });
});

describe("dashboard CLI", () => {
  it("rejects an unknown option naming it, exit 1", async () => {
    const { main } = await import("../src/dashboard/generate.ts");
    const argv = process.argv;
    const err: string[] = [];

    process.argv = [...argv.slice(0, 2), "--bogus"];

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...parts: unknown[]) => err.push(parts.join(" ")));

    try {
      await main();
    } finally {
      process.argv = argv;
      errorSpy.mockRestore();
    }

    expect(err.join("\n")).toContain('unknown option "--bogus"');
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
  });

  it("rejects more than one data-repo argument", async () => {
    const { main } = await import("../src/dashboard/generate.ts");
    const argv = process.argv;
    const err: string[] = [];

    process.argv = [...argv.slice(0, 2), "/tmp", "/tmp"];

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...parts: unknown[]) => err.push(parts.join(" ")));

    try {
      await main();
    } finally {
      process.argv = argv;
      errorSpy.mockRestore();
    }

    expect(err.join("\n")).toContain("expected at most one <data-repo>");
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
  });

  it("fails red on a data repo that does not exist", async () => {
    const { main } = await import("../src/dashboard/generate.ts");
    const argv = process.argv;
    const err: string[] = [];

    process.argv = [
      ...argv.slice(0, 2),
      join(tmpdir(), "k-wiki-dash-nonexistent"),
    ];

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...parts: unknown[]) => err.push(parts.join(" ")));

    try {
      await main();
    } finally {
      process.argv = argv;
      errorSpy.mockRestore();
    }

    expect(err.join("\n")).toContain("dashboard: ");
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
  });

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

describe("dashboard CLI --open", () => {
  /** A PATH-stub opener that records its argument to a log file,
   *  named after the command `openerFor` actually invokes on this
   *  platform (`open` on macOS, `xdg-open` on Linux) — a stub named
   *  only `open` never runs on Linux CI. */
  async function makeOpenStub(): Promise<{ stubDir: string; log: string }> {
    const { openerFor } = await import("../src/dashboard/generate.ts");
    const stubDir = await mkdtemp(join(tmpdir(), "k-wiki-open-"));

    tempDirs.push(stubDir);

    const log = join(stubDir, "open-log");

    await writeFile(
      join(stubDir, openerFor(process.platform).command),
      `#!/bin/sh\nprintf '%s' "$1" > ${JSON.stringify(log)}\n`,
      { mode: 0o755 },
    );

    return { stubDir, log };
  }

  /** A PATH-stub opener that always fails (exit 1). */
  async function makeFailingOpenStub(): Promise<string> {
    const { openerFor } = await import("../src/dashboard/generate.ts");
    const stubDir = await mkdtemp(join(tmpdir(), "k-wiki-openfail-"));

    tempDirs.push(stubDir);

    await writeFile(
      join(stubDir, openerFor(process.platform).command),
      "#!/bin/sh\nexit 1\n",
      { mode: 0o755 },
    );

    return stubDir;
  }

  /** Run main() with argv (and optionally PATH) stubbed; capture
   *  console output. */
  async function runMain(
    args: readonly string[],
    pathPrefix?: string,
  ): Promise<{ out: string; err: string }> {
    const { main } = await import("../src/dashboard/generate.ts");
    const argv = process.argv;
    const pathEnv = process.env.PATH;
    const out: string[] = [];
    const err: string[] = [];
    const spies = [
      vi
        .spyOn(console, "log")
        .mockImplementation((...parts: unknown[]) => out.push(parts.join(" "))),
      vi
        .spyOn(console, "error")
        .mockImplementation((...parts: unknown[]) => err.push(parts.join(" "))),
    ];

    process.argv = [...argv.slice(0, 2), ...args];

    if (pathPrefix !== undefined) {
      process.env.PATH = `${pathPrefix}:${pathEnv}`;
    }

    try {
      await main();
    } finally {
      process.argv = argv;
      process.env.PATH = pathEnv;

      for (const spy of spies) spy.mockRestore();
    }

    return { out: out.join("\n"), err: err.join("\n") };
  }

  it("opens the generated dashboard file with -o", async () => {
    const dataRoot = await makeDataRepo();
    const { stubDir, log } = await makeOpenStub();
    const { main } = await import("../src/dashboard/generate.ts");
    const argv = process.argv;
    const pathEnv = process.env.PATH;
    const spies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ];

    process.argv = [...argv.slice(0, 2), "-o", dataRoot];
    process.env.PATH = `${stubDir}:${pathEnv}`;

    try {
      await main();
    } finally {
      process.argv = argv;
      process.env.PATH = pathEnv;

      for (const spy of spies) spy.mockRestore();
    }

    expect(await readFile(log, "utf8")).toBe(join(dataRoot, "dashboard.html"));
  });

  it("opens the generated dashboard file with --open", async () => {
    const dataRoot = await makeDataRepo();
    const { stubDir, log } = await makeOpenStub();

    await runMain(["--open", dataRoot], stubDir);

    expect(await readFile(log, "utf8")).toBe(join(dataRoot, "dashboard.html"));
  });

  it("does not open the dashboard when no open flag is given", async () => {
    const dataRoot = await makeDataRepo();
    const { stubDir, log } = await makeOpenStub();

    await runMain([dataRoot], stubDir);

    expect(await readFile(log, "utf8").catch(() => "")).toBe("");
  });

  it("prints an error when the opener fails", async () => {
    const dataRoot = await makeDataRepo();
    const stubDir = await makeFailingOpenStub();

    const { err } = await runMain(["-o", dataRoot], stubDir);

    expect(err).toContain("could not open it");
  });

  it("exits 1 when the opener fails", async () => {
    const dataRoot = await makeDataRepo();
    const stubDir = await makeFailingOpenStub();

    await runMain(["-o", dataRoot], stubDir);

    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
  });

  it("keeps the written dashboard when the opener fails", async () => {
    const dataRoot = await makeDataRepo();
    const stubDir = await makeFailingOpenStub();

    await runMain(["-o", dataRoot], stubDir);

    const html = await readFile(join(dataRoot, "dashboard.html"), "utf8");

    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
  });

  it("documents --open in the help text", async () => {
    const { main } = await import("../src/dashboard/generate.ts");
    const argv = process.argv;
    const out: string[] = [];

    process.argv = [...argv.slice(0, 2), "--help"];

    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...parts: unknown[]) => out.push(parts.join(" ")));

    try {
      await main();
    } finally {
      process.argv = argv;
      logSpy.mockRestore();
    }

    expect(out.join("\n")).toContain("--open");
  });
});

describe("dashboard opener platform detection", () => {
  it("selects macOS open on darwin", async () => {
    const { openerFor } = await import("../src/dashboard/generate.ts");

    expect(openerFor("darwin")).toEqual({ command: "open", argsPrefix: [] });
  });

  it("selects xdg-open on linux", async () => {
    const { openerFor } = await import("../src/dashboard/generate.ts");

    expect(openerFor("linux")).toEqual({
      command: "xdg-open",
      argsPrefix: [],
    });
  });

  it("routes Windows through cmd start with an empty title argument", async () => {
    const { openerFor } = await import("../src/dashboard/generate.ts");

    expect(openerFor("win32")).toEqual({
      command: "cmd",
      argsPrefix: ["/c", "start", ""],
    });
  });
});
