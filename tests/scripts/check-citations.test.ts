import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createColors } from "picocolors";
import { afterAll, describe, expect, it } from "vitest";

/** CLI tests for bin/libexec/check-citations (scripts/check-citations.ts):
 *  exit codes, colored rendering, --help. The library core
 *  (checkCitationWall) is tested at its mirrored path
 *  tests/sandbox/citations.test.ts (issue #260). */

const script = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../bin/libexec/check-citations",
);

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A wiki tree at `<root>/wiki` holding the given files. */
async function makeWiki(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "k-wiki-cite-"));

  tempDirs.push(root);

  for (const [file, content] of Object.entries(files)) {
    await mkdir(join(root, "wiki", ...file.split("/").slice(0, -1)), {
      recursive: true,
    });
    await writeFile(join(root, "wiki", file), content);
  }

  return root;
}

/** A sandbox page carrying the pipeline's stamps. */
function sandboxPage(body: string): string {
  return ["---", "via: agent", "expires: 2099-01-01", "---", "", body, ""].join(
    "\n",
  );
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

describe("check-citations CLI", () => {
  const paint = createColors(true);

  it("exits 0 with a green summary when the wall holds", async () => {
    const root = await makeWiki({
      "index.md": "# Index\n",
      "sandbox/proposal.md": sandboxPage("Discusses [[index]]."),
    });

    const result = await runNode([join(root, "wiki")]);

    expect(`${result.code}: ${result.out}`).toBe(
      `0: ${paint.green("ok: the one-way wall holds over 1 page (1 sandbox note)")}\n`,
    );
  });

  it("exits 1 and prints the wall violation with its location", async () => {
    const root = await makeWiki({
      "index.md": "# Index\n\nSee [[proposal]].\n",
      "sandbox/proposal.md": sandboxPage("Body."),
    });

    const result = await runNode([join(root, "wiki")]);

    expect(`${result.code}: ${result.err}`).toBe(
      `1: ${paint.red("wiki/index.md:3 -> [[proposal]] (main pages must not link or embed sandbox pages)")}\n`,
    );
  });

  it("exits 0 on the repository wiki with no arguments", async () => {
    const result = await runNode([]);

    expect(`${result.code}: ${result.out.startsWith("\u001b[32mok:")}`).toBe(
      "0: true",
    );
  });

  it("exits 1 with a clean message when the wiki directory does not exist", async () => {
    const root = await makeWiki({});
    const missing = join(root, "missing");

    const result = await runNode([missing]);

    expect(`${result.code}: ${result.err}`).toBe(
      `1: ${paint.red(`check-citations: wiki directory does not exist: ${missing}`)}\n`,
    );
  });

  it("prints the usage line for --help with exit 0", async () => {
    const result = await runNode(["--help"]);

    expect(`${result.code}|${result.out}`).toMatch(
      /0\|Usage: check-citations \[-h \| --help\] \[<wiki-dir>\]/,
    );
  });

  it("prints the same help for -h as for --help", async () => {
    expect((await runNode(["-h"])).out).toBe((await runNode(["--help"])).out);
  });

  it("documents the -h and --help switches themselves", async () => {
    expect((await runNode(["--help"])).out).toContain("-h, --help");
  });

  it("prints plain text when NO_COLOR is set", async () => {
    const root = await makeWiki({
      "index.md": "# Index\n\nSee [[proposal]].\n",
      "sandbox/proposal.md": sandboxPage("Body."),
    });
    const realArgs = [realpathSync(script), join(root, "wiki")];
    const env = { ...process.env, NO_COLOR: "1" };

    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, realArgs, {
        stdio: "pipe",
        env,
      });

      let err = "";

      child.stderr.on("data", (chunk: Buffer) => {
        err += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        expect(`${code}: ${err}`).toBe(
          "1: wiki/index.md:3 -> [[proposal]] (main pages must not link or embed sandbox pages)\n",
        );
        resolve();
      });
    });
  });
});
