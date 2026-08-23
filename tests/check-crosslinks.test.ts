import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { checkCrossWikiLinks } from "../scripts/check-crosslinks.ts";

const script = join(
  dirname(fileURLToPath(import.meta.url)),
  "../scripts/check-crosslinks.ts",
);

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A minimal wiki tree at `<root>/<name>` holding the given files. */
async function makeWiki(
  name: string,
  files: Record<string, string>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "k-wiki-xlinks-"));

  tempDirs.push(root);

  for (const [file, content] of Object.entries(files)) {
    await mkdir(join(root, name, dirname(file)), { recursive: true });
    await writeFile(join(root, name, file), content);
  }

  return root;
}

/** A personal wiki plus an engineering wiki under one temp root. */
async function makePair(
  personal: Record<string, string>,
  engineering: Record<string, string>,
): Promise<{
  readonly root: string;
  readonly personal: string;
  readonly engineering: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "k-wiki-xlinks-"));

  tempDirs.push(root);

  for (const [name, files] of [
    ["personal", personal],
    ["engineering", engineering],
  ] as const) {
    for (const [file, content] of Object.entries(files)) {
      await mkdir(join(root, name, dirname(file)), { recursive: true });
      await writeFile(join(root, name, file), content);
    }
  }

  return {
    root,
    personal: join(root, "personal"),
    engineering: join(root, "engineering"),
  };
}

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

  // Colored expectations: drop NO_COLOR so the child always renders
  // codes (one dedicated test below runs with NO_COLOR=1 instead).
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

describe("checkCrossWikiLinks", () => {
  it("resolves an engineering link against the engineering page names", async () => {
    const pair = await makePair(
      {
        "personal/decision-fast-tests.md": "Backed by [[engineering/stub]].\n",
      },
      { "concepts/stub.md": "# Stub\n" },
    );

    const report = await checkCrossWikiLinks(pair.personal, pair.engineering);

    expect(report.problems).toEqual([]);
    expect(report.external).toBe(1);
  });

  it("resolves an engineering link with an alias and an anchor", async () => {
    const pair = await makePair(
      {
        "index.md":
          "See [[engineering/stub|the stub]] and [[engineering/stub#section]].\n",
      },
      { "entities/stub.md": "# Stub\n" },
    );

    const report = await checkCrossWikiLinks(pair.personal, pair.engineering);

    expect(report.problems).toEqual([]);
    expect(report.external).toBe(2);
  });

  it("reports a broken cross-wiki link as file:line -> [[link]]", async () => {
    const pair = await makePair(
      { "personal/profile.md": "Points at [[engineering/missing]].\n" },
      { "concepts/stub.md": "# Stub\n" },
    );

    const report = await checkCrossWikiLinks(pair.personal, pair.engineering);

    expect(report.problems).toEqual([
      "personal/personal/profile.md:1 -> [[engineering/missing]]",
    ]);
  });

  it("reports a cross-wiki self-reference inside the engineering wiki", async () => {
    const pair = await makePair(
      { "index.md": "# Personal\n" },
      {
        "concepts/stub.md": "# Stub\n",
        "entities/leaky.md": "Dodges resolution via [[engineering/stub]].\n",
      },
    );

    const report = await checkCrossWikiLinks(pair.personal, pair.engineering);

    expect(report.problems).toEqual([
      "engineering/entities/leaky.md:1 -> [[engineering/stub]]",
    ]);
  });

  it("counts no external links for a wiki without cross-wiki links", async () => {
    const pair = await makePair(
      { "index.md": "Internal [[note]] only.\n", "note.md": "# Note\n" },
      { "index.md": "# Engineering\n" },
    );

    const report = await checkCrossWikiLinks(pair.personal, pair.engineering);

    expect(report.problems).toEqual([]);
    expect(report.external).toBe(0);
    expect(report.pages).toBe(2);
  });

  it("skips AGENTS.md in both trees", async () => {
    const pair = await makePair(
      { "AGENTS.md": "Contract mentions [[engineering/missing]].\n" },
      { "AGENTS.md": "Self [[engineering/missing]].\n", "index.md": "# E\n" },
    );

    const report = await checkCrossWikiLinks(pair.personal, pair.engineering);

    expect(report.problems).toEqual([]);
    expect(report.engineeringPages).toBe(1);
  });

  it("rejects an audited wiki directory that does not exist", async () => {
    const root = await makeWiki("engineering", { "index.md": "# E\n" });

    await expect(
      checkCrossWikiLinks(join(root, "missing"), join(root, "engineering")),
    ).rejects.toThrow(
      `wiki directory does not exist: ${join(root, "missing")}`,
    );
  });

  it("rejects an engineering wiki directory that does not exist", async () => {
    const root = await makeWiki("personal", { "index.md": "# P\n" });

    await expect(
      checkCrossWikiLinks(join(root, "personal"), join(root, "missing")),
    ).rejects.toThrow(
      `engineering wiki directory does not exist: ${join(root, "missing")}`,
    );
  });
});

describe("check-crosslinks CLI", () => {
  it("exits 0 with an ok summary when every cross-wiki link resolves", async () => {
    const pair = await makePair(
      { "personal/decision.md": "Backed by [[engineering/stub]].\n" },
      { "concepts/stub.md": "# Stub\n" },
    );
    const result = await runNode([pair.personal, pair.engineering]);

    expect(`${result.code}|${result.out}`).toMatch(
      /0\|.*ok: 1 cross-wiki link resolves against 1 engineering page/,
    );
  });

  it("exits 1 and prints the broken cross-wiki link", async () => {
    const pair = await makePair(
      { "personal/decision.md": "Points at [[engineering/missing]].\n" },
      { "concepts/stub.md": "# Stub\n" },
    );
    const result = await runNode([pair.personal, pair.engineering]);

    expect(result.code).toBe(1);
    expect(result.err).toContain(
      "personal/personal/decision.md:1 -> [[engineering/missing]]",
    );
  });

  it("exits 1 when the engineering wiki self-references", async () => {
    const pair = await makePair(
      { "index.md": "# Personal\n" },
      { "entities/leaky.md": "[[engineering/stub]]\n" },
    );
    const result = await runNode([pair.personal, pair.engineering]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("engineering/entities/leaky.md:1");
  });

  it("exits 1 with a clean message when a directory is missing", async () => {
    const root = await makeWiki("personal", { "index.md": "# P\n" });
    const result = await runNode([join(root, "personal"), join(root, "nope")]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("engineering wiki directory does not exist");
  });

  it("exits 1 when a positional argument is missing", async () => {
    const root = await makeWiki("personal", { "index.md": "# P\n" });
    const result = await runNode([join(root, "personal")]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("expected exactly two arguments");
  });

  it("prints the usage line for --help with exit 0", async () => {
    const result = await runNode(["--help"]);

    expect(`${result.code}|${result.out}`).toMatch(
      /0\|Usage: check-crosslinks/,
    );
  });

  it("prints the same help for -h as for --help", async () => {
    const [dash, double] = await Promise.all([
      runNode(["-h"]),
      runNode(["--help"]),
    ]);

    expect(dash.out).toBe(double.out);
  });

  it("documents the -h and --help switches themselves", async () => {
    const result = await runNode(["--help"]);

    expect(result.out).toContain("-h, --help");
  });

  it("prints help before validating the wiki paths", async () => {
    const result = await runNode(["--help", "/definitely/missing", "/also"]);

    expect(`${result.code}|${result.out}`).toMatch(
      /0\|Usage: check-crosslinks/,
    );
  });

  it("prints plain text when NO_COLOR is set", async () => {
    const pair = await makePair(
      { "personal/decision.md": "Points at [[engineering/missing]].\n" },
      { "concepts/stub.md": "# Stub\n" },
    );
    const env = { ...process.env, NO_COLOR: "1" };
    const realScript = realpathSync(script);
    const result = await new Promise<RunResult>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [realScript, pair.personal, pair.engineering],
        { stdio: "pipe", env },
      );
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

    expect(result.err).not.toContain("\x1b[");
  });

  it("prints color when NO_COLOR is unset", async () => {
    const pair = await makePair(
      { "personal/decision.md": "Points at [[engineering/missing]].\n" },
      { "concepts/stub.md": "# Stub\n" },
    );
    const result = await runNode([pair.personal, pair.engineering]);

    expect(result.err).toContain("\x1b[");
  });
});
