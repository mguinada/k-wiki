import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runContext } from "../../src/cli/run-context.ts";
import { runVerificationStage } from "../../src/sync/verification-stage.ts";

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A wiki page body with valid frontmatter whose title kebab-cases
 *  to the file name the caller writes. */
function wikiPage(body: string, title = "Page"): string {
  return frontmatterPage(title, "concept", ["sources:", '  - "[[src]]"'], body);
}

/** A wiki page whose frontmatter carries the given type plus extra
 *  fields — the shape the fidelity/provenance failure fixtures build. */
function frontmatterPage(
  title: string,
  type: string,
  extra: readonly string[],
  body: string,
): string {
  return [
    "---",
    `title: "${title}"`,
    `type: ${type}`,
    "created: 2026-08-20",
    "updated: 2026-08-20",
    "tags:",
    "  - llm",
    ...extra,
    "---",
    "",
    body,
    "",
  ].join("\n");
}

describe("runVerificationStage", () => {
  /** A minimal data-repo shape for the stage: wiki/ beside raw/,
   *  one title-clean concept page with a resolvable source link. */
  async function makeVerificationRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "k-wiki-verify-"));

    tempDirs.push(root);

    await mkdir(join(root, "wiki", "concepts"), { recursive: true });
    await mkdir(join(root, "wiki", "sources"), { recursive: true });
    await mkdir(join(root, "raw"), { recursive: true });
    await writeFile(join(root, "wiki", "index.md"), "# Index\n");
    await writeFile(
      join(root, "wiki", "sources", "src.md"),
      "---\ntitle: Src\ntype: source\ncreated: 2026-08-20\nupdated: 2026-08-20\ntags:\n  - source\n---\nHub.\n",
    );
    await writeFile(
      join(root, "wiki", "concepts", "clean.md"),
      wikiPage("Clean body", "Clean"),
    );

    return root;
  }

  it("reports no fidelity problems for a faithful wiki", async () => {
    const root = await makeVerificationRoot();

    const result = await runVerificationStage({
      run: runContext({ rawDir: join(root, "raw") }),
    });

    expect(result.fidelity.problems).toEqual([]);
  });

  it("reports no provenance problems for a coherent wiki", async () => {
    const root = await makeVerificationRoot();

    const result = await runVerificationStage({
      run: runContext({ rawDir: join(root, "raw") }),
    });

    expect(result.provenance.problems).toEqual([]);
  });

  it("rejects listing one line per fidelity problem", async () => {
    const root = await makeVerificationRoot();

    await writeFile(
      join(root, "wiki", "concepts", "drifted.md"),
      wikiPage("Drifted body", "Elsewhere"),
    );
    await mkdir(join(root, "wiki", "sources"), { recursive: true });
    await mkdir(join(root, "raw", "notes", "Engineering", "AI"), {
      recursive: true,
    });
    await writeFile(
      join(root, "raw", "notes", "Engineering", "AI", "RAG.md"),
      "rag body without the command\n",
    );
    await writeFile(
      join(root, "wiki", "sources", "misquote.md"),
      frontmatterPage(
        "Misquote",
        "source",
        ["origin: notes/Engineering/AI/RAG.md"],
        "Run `npm run build`.",
      ),
    );

    await expect(
      runVerificationStage({
        run: runContext({ rawDir: join(root, "raw") }),
      }),
    ).rejects.toThrow(
      "fidelity check failed:\n" +
        'wiki/concepts/drifted.md -> title "Elsewhere" does not kebab to drifted\n' +
        "wiki/sources/misquote.md -> `npm run build` not in origin notes/Engineering/AI/RAG.md",
    );
  });

  it("rejects listing one line per provenance problem", async () => {
    const root = await makeVerificationRoot();

    await mkdir(join(root, "wiki", "sources"), { recursive: true });
    await writeFile(
      join(root, "wiki", "sources", "dead-origin.md"),
      frontmatterPage(
        "Dead Origin",
        "source",
        ["origin: notes/Engineering/gone.md"],
        "body without artifacts",
      ),
    );
    await writeFile(
      join(root, "wiki", "sources", "dead-link.md"),
      frontmatterPage(
        "Dead Link",
        "concept",
        ["sources:", '  - "[[gone-page]]"'],
        "body",
      ),
    );

    await expect(
      runVerificationStage({
        run: runContext({ rawDir: join(root, "raw") }),
      }),
    ).rejects.toThrow(
      "provenance check failed:\n" +
        "wiki/sources/dead-link.md -> [[gone-page]] (missing source page)\n" +
        "wiki/sources/dead-origin.md -> origin notes/Engineering/gone.md (missing under raw/)",
    );
  });

  it("announces the check on the progress line", async () => {
    const root = await makeVerificationRoot();
    const progress: string[] = [];

    await runVerificationStage({
      run: runContext({
        rawDir: join(root, "raw"),
        onProgress: (message) => progress.push(message),
      }),
    });

    expect(progress).toContain(
      "wiki-sync: verification — checking citation fidelity and provenance",
    );
  });
});
