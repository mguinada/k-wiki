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
  "../bin/check-crosslinks.ts",
);

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** Write one wiki tree (`<name>/` with files) under `root`; when
 *  `vault` is given, also the sibling `raw/manifest.json` naming that
 *  vault — a domain wiki's identity source. */
async function writeWiki(
  root: string,
  name: string,
  files: Record<string, string>,
  vault?: string,
): Promise<void> {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(join(root, name, dirname(file)), { recursive: true });
    await writeFile(join(root, name, file), content);
  }

  if (vault !== undefined) {
    await mkdir(join(root, "raw"), { recursive: true });
    await writeFile(
      join(root, "raw", "manifest.json"),
      `${JSON.stringify({ vaults: { [vault]: {} } }, null, 2)}\n`,
    );
  }
}

/** A temp root holding `<name>/` wiki (plus a manifest naming `vault`
 *  when given). */
async function makeWiki(
  name: string,
  files: Record<string, string>,
  vault?: string,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "k-wiki-xlinks-"));

  tempDirs.push(root);
  await writeWiki(root, name, files, vault);

  return root;
}

interface RunResult {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

function runNode(
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  // argv[1] must be the real path: import.meta.url is realpath'd by
  // Node, and a symlinked spawn path (macOS tmp) would make the CLI
  // import guard compare unequal and skip main().
  const realArgs = [realpathSync(script), ...args];

  // Colored expectations: drop NO_COLOR so the child always renders
  // codes (one dedicated test below runs with NO_COLOR=1 instead).
  const env = { ...process.env };

  delete env.NO_COLOR;
  Object.assign(env, options.env);

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
  it("resolves a cross-wiki link against the domain wiki's pages", async () => {
    const brain = await makeWiki("brain", {
      "decision-fast-tests.md": "Backed by [[engineering/stub]].\n",
    });
    const engineering = await makeWiki(
      "engineering",
      { "concepts/stub.md": "# Stub\n" },
      "Engineering",
    );

    const report = await checkCrossWikiLinks(
      join(brain, "brain"),
      join(engineering, "engineering"),
    );

    expect(report.problems).toEqual([]);
    expect(report.external).toBe(1);
  });

  it("matches the vault name case-insensitively", async () => {
    const brain = await makeWiki("brain", {
      "index.md": "See [[Engineering/stub]].\n",
    });
    const engineering = await makeWiki(
      "engineering",
      { "entities/stub.md": "# Stub\n" },
      "Engineering",
    );

    const report = await checkCrossWikiLinks(
      join(brain, "brain"),
      join(engineering, "engineering"),
    );

    expect(report.problems).toEqual([]);
    expect(report.external).toBe(1);
  });

  it("resolves links to several domain wikis in one run", async () => {
    const brain = await makeWiki("brain", {
      "index.md": "See [[engineering/stub]] and [[anthropology/kinship]].\n",
    });
    const engineering = await makeWiki(
      "engineering",
      { "concepts/stub.md": "# Stub\n" },
      "Engineering",
    );
    const anthropology = await makeWiki(
      "anthropology",
      { "entities/kinship.md": "# Kinship\n" },
      "Anthropology",
    );

    const report = await checkCrossWikiLinks(
      join(brain, "brain"),
      join(engineering, "engineering"),
      join(anthropology, "anthropology"),
    );

    expect(report.problems).toEqual([]);
    expect(report.external).toBe(2);
    expect(report.auditedPages).toBe(1);
    expect(report.domainPages).toBe(2);
  });

  it("reports a broken cross-wiki link as file:line -> [[link]]", async () => {
    const brain = await makeWiki("brain", {
      "profile.md": "Points at [[engineering/missing]].\n",
    });
    const engineering = await makeWiki(
      "engineering",
      { "concepts/stub.md": "# Stub\n" },
      "Engineering",
    );

    const report = await checkCrossWikiLinks(
      join(brain, "brain"),
      join(engineering, "engineering"),
    );

    expect(report.problems).toEqual([
      "brain/profile.md:1 -> [[engineering/missing]]",
    ]);
  });

  it("reports a link naming an unknown domain wiki", async () => {
    const brain = await makeWiki("brain", {
      "index.md": "Points at [[history/foo]].\n",
    });
    const engineering = await makeWiki(
      "engineering",
      { "index.md": "# Engineering\n" },
      "Engineering",
    );

    const report = await checkCrossWikiLinks(
      join(brain, "brain"),
      join(engineering, "engineering"),
    );

    expect(report.problems).toEqual([
      'brain/index.md:1 -> [[history/foo]] (unknown domain wiki "history")',
    ]);
  });

  it("reports a cross-wiki link inside a domain wiki", async () => {
    const brain = await makeWiki("brain", { "index.md": "# Brain\n" });
    const engineering = await makeWiki(
      "engineering",
      { "entities/leaky.md": "Dodges resolution via [[brain/decision]].\n" },
      "Engineering",
    );

    const report = await checkCrossWikiLinks(
      join(brain, "brain"),
      join(engineering, "engineering"),
    );

    expect(report.problems).toEqual([
      "engineering/entities/leaky.md:1 -> [[brain/decision]] (domain wikis must not use cross-wiki links)",
    ]);
  });

  it("ignores protocol links entirely", async () => {
    const brain = await makeWiki("brain", {
      "index.md": "Plain URL wikilink [[https://example.com/page]].\n",
    });
    const engineering = await makeWiki(
      "engineering",
      { "index.md": "# Engineering\n" },
      "Engineering",
    );

    const report = await checkCrossWikiLinks(
      join(brain, "brain"),
      join(engineering, "engineering"),
    );

    expect(report.problems).toEqual([]);
    expect(report.external).toBe(0);
  });

  it("skips AGENTS.md in both trees", async () => {
    const brain = await makeWiki("brain", {
      "AGENTS.md": "Contract mentions [[engineering/missing]].\n",
    });
    const engineering = await makeWiki(
      "engineering",
      { "AGENTS.md": "Self [[engineering/missing]].\n", "index.md": "# E\n" },
      "Engineering",
    );

    const report = await checkCrossWikiLinks(
      join(brain, "brain"),
      join(engineering, "engineering"),
    );

    expect(report.problems).toEqual([]);
    expect(report.auditedPages).toBe(0);
    expect(report.domainPages).toBe(1);
  });

  it("rejects a missing audited wiki directory", async () => {
    const root = await makeWiki("engineering", { "index.md": "# E\n" });

    await expect(
      checkCrossWikiLinks(join(root, "missing"), join(root, "engineering")),
    ).rejects.toThrow(
      `wiki directory does not exist: ${join(root, "missing")}`,
    );
  });

  it("rejects a missing domain wiki directory", async () => {
    const root = await makeWiki("brain", { "index.md": "# P\n" });

    await expect(
      checkCrossWikiLinks(join(root, "brain"), join(root, "missing")),
    ).rejects.toThrow(
      `wiki directory does not exist: ${join(root, "missing")}`,
    );
  });

  it("rejects a domain wiki without a sibling manifest", async () => {
    const brain = await makeWiki("brain", { "index.md": "# P\n" });
    const bare = await makeWiki("engineering", { "index.md": "# E\n" });

    await expect(
      checkCrossWikiLinks(join(brain, "brain"), join(bare, "engineering")),
    ).rejects.toThrow(/no manifest at .*raw\/manifest\.json/);
  });

  it("rejects a domain wiki whose manifest names no vaults", async () => {
    const brain = await makeWiki("brain", { "index.md": "# P\n" });
    const empty = await makeWiki(
      "engineering",
      { "index.md": "# E\n" },
      "Empty",
    );

    await writeFile(
      join(empty, "raw", "manifest.json"),
      `${JSON.stringify({ vaults: {} }, null, 2)}\n`,
    );
    await expect(
      checkCrossWikiLinks(join(brain, "brain"), join(empty, "engineering")),
    ).rejects.toThrow(/names no vaults/);
  });

  it("lets a domain wiki keep internal links", async () => {
    const brain = await makeWiki("brain", {
      "decision.md": "Backed by [[engineering/stub]].\n",
    });
    const engineering = await makeWiki(
      "engineering",
      {
        "concepts/stub.md": "# Stub\n\nSee also [[notes]].\n",
        "concepts/notes.md": "# Notes\n",
      },
      "Engineering",
    );

    const report = await checkCrossWikiLinks(
      join(brain, "brain"),
      join(engineering, "engineering"),
    );

    expect(report.problems).toEqual([]);
  });
});

describe("check-crosslinks CLI", () => {
  it("exits 0 with an ok summary when every cross-wiki link resolves", async () => {
    const brain = await makeWiki("brain", {
      "decision.md": "Backed by [[engineering/stub]].\n",
    });
    const engineering = await makeWiki(
      "engineering",
      { "concepts/stub.md": "# Stub\n" },
      "Engineering",
    );
    const result = await runNode([
      join(brain, "brain"),
      join(engineering, "engineering"),
    ]);

    expect(`${result.code}|${result.out}`).toMatch(
      /0\|.*ok: 1 cross-wiki link resolves against 1 domain page/,
    );
  });

  it("exits 1 and prints the broken cross-wiki link", async () => {
    const brain = await makeWiki("brain", {
      "decision.md": "Points at [[engineering/missing]].\n",
    });
    const engineering = await makeWiki(
      "engineering",
      { "concepts/stub.md": "# Stub\n" },
      "Engineering",
    );
    const result = await runNode([
      join(brain, "brain"),
      join(engineering, "engineering"),
    ]);

    expect(result.code).toBe(1);
    expect(result.err).toContain(
      "brain/decision.md:1 -> [[engineering/missing]]",
    );
  });

  it("exits 1 when a link names an unknown domain wiki", async () => {
    const brain = await makeWiki("brain", {
      "index.md": "Points at [[history/foo]].\n",
    });
    const engineering = await makeWiki(
      "engineering",
      { "index.md": "# Engineering\n" },
      "Engineering",
    );
    const result = await runNode([
      join(brain, "brain"),
      join(engineering, "engineering"),
    ]);

    expect(result.code).toBe(1);
    expect(result.err).toContain('unknown domain wiki "history"');
  });

  it("exits 1 when the domain wiki self-references", async () => {
    const brain = await makeWiki("brain", { "index.md": "# Brain\n" });
    const engineering = await makeWiki(
      "engineering",
      { "entities/leaky.md": "[[brain/decision]]\n" },
      "Engineering",
    );
    const result = await runNode([
      join(brain, "brain"),
      join(engineering, "engineering"),
    ]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("engineering/entities/leaky.md:1");
  });

  it("exits 1 with a clean message when a directory is missing", async () => {
    const root = await makeWiki("brain", { "index.md": "# P\n" });
    const result = await runNode([join(root, "brain"), join(root, "nope")]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("wiki directory does not exist");
  });

  it("exits 1 when a domain wiki dir is missing", async () => {
    const root = await makeWiki("brain", { "index.md": "# P\n" });
    const result = await runNode([join(root, "brain")]);

    expect(result.code).toBe(1);
    expect(result.err).toContain(
      "expected <wiki-dir> and at least one <domain-wiki-dir>",
    );
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
    const brain = await makeWiki("brain", {
      "decision.md": "Points at [[engineering/missing]].\n",
    });
    const engineering = await makeWiki(
      "engineering",
      { "concepts/stub.md": "# Stub\n" },
      "Engineering",
    );
    const result = await runNode(
      [join(brain, "brain"), join(engineering, "engineering")],
      { env: { NO_COLOR: "1" } },
    );

    expect(result.err).not.toContain("\x1b[");
  });

  it("prints color when NO_COLOR is unset", async () => {
    const brain = await makeWiki("brain", {
      "decision.md": "Points at [[engineering/missing]].\n",
    });
    const engineering = await makeWiki(
      "engineering",
      { "concepts/stub.md": "# Stub\n" },
      "Engineering",
    );
    const result = await runNode([
      join(brain, "brain"),
      join(engineering, "engineering"),
    ]);

    expect(result.err).toContain("\x1b[");
  });
});
