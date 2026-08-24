import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
  appendIndexEntry,
  citedPages,
  citedSourcePages,
  driftWarning,
  fileLastQuery,
  indexEntryFor,
  logEntry,
  parseQueryArtifact,
  type QueryArtifact,
  readQueryArtifact,
  renderQueryArtifact,
  slugForQuestion,
  templateQueryPage,
  writeQueryArtifact,
} from "../src/query/file-last.ts";

const run = promisify(execFile);

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const QUESTION = "When should I prefer RAG over fine-tuning?";

const ANSWER =
  "Prefer RAG when the knowledge base changes often; fine-tune when it is stable.\n\nSee [[retrieval-augmented-generation]] and [[rag-evaluation-notes]].";

const ARTIFACT: QueryArtifact = {
  question: QUESTION,
  timestamp: "2026-08-20T10:00:00.000Z",
  pages: ["rag-evaluation-notes", "retrieval-augmented-generation"],
  answer: ANSWER,
};

describe("renderQueryArtifact and parseQueryArtifact", () => {
  it("round-trips the question, timestamp, pages, and answer", () => {
    expect(parseQueryArtifact(renderQueryArtifact(ARTIFACT))).toEqual(ARTIFACT);
  });

  it("keeps an answer that starts with a --- line byte-exact", () => {
    const artifact = { ...ARTIFACT, answer: "---\nnot frontmatter\n" };

    expect(parseQueryArtifact(renderQueryArtifact(artifact)).answer).toBe(
      "---\nnot frontmatter\n",
    );
  });

  it("keeps an answer containing header-like lines byte-exact", () => {
    const artifact = {
      ...ARTIFACT,
      answer: '## Question\n\nquestion: "not the header"\n---\nstill answer',
    };

    expect(parseQueryArtifact(renderQueryArtifact(artifact)).answer).toBe(
      artifact.answer,
    );
  });

  it("round-trips a multi-line question with JSON escaping", () => {
    const artifact = {
      ...ARTIFACT,
      question: 'line one\nline two: "quoted"',
    };

    expect(parseQueryArtifact(renderQueryArtifact(artifact)).question).toBe(
      'line one\nline two: "quoted"',
    );
  });

  it("rejects text without a frontmatter block", () => {
    expect(() => parseQueryArtifact("Just an answer.\n")).toThrow(
      "not a wiki-query artifact",
    );
  });

  it("rejects an unterminated frontmatter block", () => {
    expect(() =>
      parseQueryArtifact('---\nquestion: "q"\ntimestamp: "t"\npages: []\n'),
    ).toThrow("not a wiki-query artifact");
  });

  it("rejects a missing required key", () => {
    expect(() => parseQueryArtifact('---\nquestion: "q"\n---\n\nA.\n')).toThrow(
      "not a wiki-query artifact",
    );
  });

  it("rejects a malformed header value", () => {
    expect(() =>
      parseQueryArtifact(
        '---\nquestion: [broken\ntimestamp: "t"\npages: []\n---\n\nA.\n',
      ),
    ).toThrow("not a wiki-query artifact");
  });

  it("rejects a timestamp that is not a date", () => {
    expect(() =>
      parseQueryArtifact(
        renderQueryArtifact({ ...ARTIFACT, timestamp: "not-a-date" }),
      ),
    ).toThrow("not a wiki-query artifact");
  });
});

describe("readQueryArtifact", () => {
  it("reads a written artifact back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-fl-"));

    tempDirs.push(dir);

    const path = join(dir, "last-query.md");

    await writeFile(path, renderQueryArtifact(ARTIFACT), "utf8");

    expect(await readQueryArtifact(path)).toEqual(ARTIFACT);
  });

  it("fails naming the path and the remedy when the artifact is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-fl-"));

    tempDirs.push(dir);

    const path = join(dir, "last-query.md");

    await expect(readQueryArtifact(path)).rejects.toThrow(
      `no saved answer at ${path} — run wiki-query "<question>" first`,
    );
  });
});

describe("writeQueryArtifact", () => {
  it("round-trips the artifact through a fresh outputs directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-fl-"));

    tempDirs.push(dir);

    const path = join(dir, "outputs", "last-query.md");

    await writeQueryArtifact(path, ARTIFACT);

    expect(await readQueryArtifact(path)).toEqual(ARTIFACT);
  });
});

describe("slugForQuestion", () => {
  it("derives a kebab-case slug from the question", () => {
    expect(slugForQuestion(QUESTION)).toBe(
      "when-should-i-prefer-rag-over-fine-tuning",
    );
  });

  it("collapses punctuation and whitespace runs into one hyphen", () => {
    expect(slugForQuestion("What's new? — RAG, fine-tuning!")).toBe(
      "what-s-new-rag-fine-tuning",
    );
  });

  it("falls back to query when nothing survives", () => {
    expect(slugForQuestion("??? — ???")).toBe("query");
  });

  it("caps the slug at 80 characters", () => {
    expect(slugForQuestion("a".repeat(200))).toHaveLength(80);
  });
});

describe("citedPages", () => {
  it("lists each wikilink target once, sorted", () => {
    expect(citedPages("See [[b]] and [[a]], then [[b|alias]] again.")).toEqual([
      "a",
      "b",
    ]);
  });

  it("returns an empty list when the answer cites nothing", () => {
    expect(citedPages("No links here.")).toEqual([]);
  });
});

describe("citedSourcePages", () => {
  it("keeps only cited pages whose page is type source", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-fl-"));

    tempDirs.push(dir);

    await mkdir(join(dir, "sources"), { recursive: true });
    await mkdir(join(dir, "concepts"), { recursive: true });
    await writeFile(
      join(dir, "sources", "retrieval-augmented-generation.md"),
      "---\ntype: source\n---\nRAG\n",
    );
    await writeFile(
      join(dir, "concepts", "chunking.md"),
      "---\ntype: concept\n---\nChunking\n",
    );

    expect(
      await citedSourcePages(dir, [
        "retrieval-augmented-generation",
        "chunking",
        "no-such-page",
      ]),
    ).toEqual(["retrieval-augmented-generation"]);
  });
});

describe("templateQueryPage", () => {
  it("carries the guide §9 frontmatter fields for a query page", () => {
    const page = templateQueryPage(ARTIFACT, {
      created: "2026-08-21",
      updated: "2026-08-21",
      sources: ["retrieval-augmented-generation"],
    });

    expect(page).toContain("type: query");
    expect(page).toContain(`question: ${JSON.stringify(QUESTION)}`);
    expect(page).toContain("created: 2026-08-21");
    expect(page).toContain("updated: 2026-08-21");
    expect(page).toContain("  - query");
    expect(page).toContain('  - "[[retrieval-augmented-generation]]"');
    expect(page).toContain(`title: ${JSON.stringify(QUESTION)}`);
  });

  it("contains the answer byte-exactly", () => {
    const page = templateQueryPage(ARTIFACT, {
      created: "2026-08-21",
      updated: "2026-08-21",
      sources: [],
    });

    expect(page).toContain(ANSWER);
  });

  it("collapses a multi-line question in the heading", () => {
    const page = templateQueryPage(
      { ...ARTIFACT, question: "one\ntwo" },
      { created: "2026-08-21", updated: "2026-08-21", sources: [] },
    );

    expect(page).toContain("# one two");
  });
});

describe("indexEntryFor and appendIndexEntry", () => {
  it("links the page and states the question on one line", () => {
    expect(indexEntryFor("rag-vs-finetuning", QUESTION)).toBe(
      `- [[rag-vs-finetuning]] — ${QUESTION}`,
    );
  });

  it("inserts the entry directly under the ## Queries heading", () => {
    const index = [
      "# Wiki Index",
      "",
      "## Concepts",
      "",
      "<!-- concepts here -->",
      "",
      "## Queries",
      "",
      "<!-- Add filed query answers here -->",
      "",
    ].join("\n");

    expect(appendIndexEntry(index, "- [[q]] — question?")).toBe(
      [
        "# Wiki Index",
        "",
        "## Concepts",
        "",
        "<!-- concepts here -->",
        "",
        "## Queries",
        "- [[q]] — question?",
        "",
        "<!-- Add filed query answers here -->",
        "",
      ].join("\n"),
    );
  });

  it("appends a ## Queries section when the heading is missing", () => {
    expect(appendIndexEntry("# Wiki Index\n", "- [[q]] — q?")).toBe(
      "# Wiki Index\n\n## Queries\n\n- [[q]] — q?\n",
    );
  });
});

describe("logEntry", () => {
  it("renders the guide §12 heading format for a query", () => {
    expect(logEntry(QUESTION, "2026-08-21")).toBe(
      `## [2026-08-21] query | ${QUESTION}`,
    );
  });

  it("collapses a multi-line question onto one heading line", () => {
    expect(logEntry("one\ntwo", "2026-08-21")).toBe(
      "## [2026-08-21] query | one two",
    );
  });
});

describe("driftWarning", () => {
  it("is undefined when no commit touched raw/ or wiki/", async () => {
    const dataRoot = await makeCommittedRepo();

    expect(
      await driftWarning(dataRoot, process.env, "2026-08-20T10:00:00Z"),
    ).toBeUndefined();
  });

  it("is undefined when the last raw/ or wiki/ commit predates the answer", async () => {
    const dataRoot = await makeCommittedRepo();

    await commitAll(
      dataRoot,
      "wiki edit",
      [["wiki/index.md", "# Index v2\n"]],
      "2026-08-19T12:00:00+00:00",
    );

    expect(
      await driftWarning(dataRoot, process.env, "2026-08-20T10:00:00Z"),
    ).toBeUndefined();
  });

  it("warns when a commit touched raw/ or wiki/ after the answer", async () => {
    const dataRoot = await makeCommittedRepo();

    await commitAll(
      dataRoot,
      "wiki edit",
      [["wiki/index.md", "# Index v2\n"]],
      "2026-08-21T12:00:00+00:00",
    );

    const warning = await driftWarning(
      dataRoot,
      process.env,
      "2026-08-20T10:00:00Z",
    );

    expect(warning).toMatch(
      /^warning: the data repo changed after the saved answer/,
    );
  });

  it("is undefined when git cannot report", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-fl-"));

    tempDirs.push(dir);

    expect(
      await driftWarning(dir, process.env, "2026-08-20T10:00:00Z"),
    ).toBeUndefined();
  });

  it("warns on uncommitted wiki changes newer than the saved answer", async () => {
    const dataRoot = await makeCommittedRepo();

    await writeFile(join(dataRoot, "wiki", "index.md"), "# Index v2\n");
    await utimes(
      join(dataRoot, "wiki", "index.md"),
      new Date("2026-08-21T12:00:00Z"),
      new Date("2026-08-21T12:00:00Z"),
    );

    expect(
      await driftWarning(dataRoot, process.env, "2026-08-20T10:00:00Z"),
    ).toMatch(
      /^warning: the data repo changed after the saved answer \(uncommitted changes under raw\/ or wiki\/\)/,
    );
  });

  it("is undefined for uncommitted wiki changes older than the saved answer", async () => {
    const dataRoot = await makeCommittedRepo();

    await writeFile(join(dataRoot, "wiki", "index.md"), "# Index v2\n");
    await utimes(
      join(dataRoot, "wiki", "index.md"),
      new Date("2026-08-19T12:00:00Z"),
      new Date("2026-08-19T12:00:00Z"),
    );

    expect(
      await driftWarning(dataRoot, process.env, "2026-08-20T10:00:00Z"),
    ).toBeUndefined();
  });

  it("is undefined for an uncommitted wiki deletion", async () => {
    const dataRoot = await makeCommittedRepo();

    await rm(join(dataRoot, "wiki", "index.md"));

    expect(
      await driftWarning(dataRoot, process.env, "2026-08-20T10:00:00Z"),
    ).toBeUndefined();
  });
});

describe("fileLastQuery", () => {
  it("files the saved answer byte-exactly with index and log entries", async () => {
    const { dataRoot, artifactPath } = await makeFiledRepo();

    const result = await fileLastQuery({
      artifactPath,
      dataRoot,
      now: () => new Date("2026-08-21T09:00:00Z"),
    });

    expect(result.pagePath).toBe(
      "wiki/queries/when-should-i-prefer-rag-over-fine-tuning.md",
    );

    const page = await readFile(join(dataRoot, result.pagePath), "utf8");

    expect(page).toContain(ANSWER);

    const index = await readFile(join(dataRoot, "wiki", "index.md"), "utf8");

    expect(index).toContain(
      `- [[when-should-i-prefer-rag-over-fine-tuning]] — ${QUESTION}`,
    );

    const log = await readFile(join(dataRoot, "wiki", "log.md"), "utf8");

    expect(log).toContain(`## [2026-08-21] query | ${QUESTION}`);
  });

  it("derives sources from cited type: source pages", async () => {
    const { dataRoot, artifactPath } = await makeFiledRepo();

    const result = await fileLastQuery({
      artifactPath,
      dataRoot,
      now: () => new Date("2026-08-21T09:00:00Z"),
    });

    const page = await readFile(join(dataRoot, result.pagePath), "utf8");

    expect(page).toContain('  - "[[retrieval-augmented-generation]]"');
    expect(page).not.toContain("[[chunking]]");
  });

  it("suffixed -2 on a slug collision, deterministically", async () => {
    const { dataRoot, artifactPath } = await makeFiledRepo();

    await mkdir(join(dataRoot, "wiki", "queries"), { recursive: true });
    await writeFile(
      join(
        dataRoot,
        "wiki",
        "queries",
        "when-should-i-prefer-rag-over-fine-tuning.md",
      ),
      "taken\n",
    );

    const result = await fileLastQuery({
      artifactPath,
      dataRoot,
      now: () => new Date("2026-08-21T09:00:00Z"),
    });

    expect(result.pagePath).toBe(
      "wiki/queries/when-should-i-prefer-rag-over-fine-tuning-2.md",
    );
  });

  it("fails with the remedy when no saved answer exists", async () => {
    const { dataRoot, artifactPath } = await makeFiledRepo();

    await rm(artifactPath);

    await expect(
      fileLastQuery({ artifactPath, dataRoot, now: () => new Date() }),
    ).rejects.toThrow("no saved answer");
  });

  it("passes the drift warning through when the wiki moved", async () => {
    const { dataRoot, artifactPath } = await makeFiledRepo();

    await commitAll(
      dataRoot,
      "wiki edit",
      [["wiki/index.md", "# Index v2\n"]],
      "2026-08-22T12:00:00+00:00",
    );

    const messages: string[] = [];

    const result = await fileLastQuery({
      artifactPath,
      dataRoot,
      now: () => new Date("2026-08-23T09:00:00Z"),
      onProgress: (message) => messages.push(message),
    });

    expect(result.warning).toMatch(/^warning: the data repo changed/);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^warning: the data repo changed/),
      ]),
    );
  });

  it("reports no warning when nothing moved", async () => {
    const { dataRoot, artifactPath } = await makeFiledRepo();

    const result = await fileLastQuery({
      artifactPath,
      dataRoot,
      now: () => new Date("2026-08-21T09:00:00Z"),
    });

    expect(result.warning).toBeUndefined();
  });
});

/** A committed data repo whose wiki cites a source and a concept page. */
async function makeCommittedRepo(): Promise<string> {
  const dataRoot = await mkdtemp(join(tmpdir(), "k-wiki-fl-"));

  tempDirs.push(dataRoot);

  await mkdir(join(dataRoot, "raw"), { recursive: true });
  await mkdir(join(dataRoot, "wiki"), { recursive: true });
  await writeFile(join(dataRoot, "wiki", "index.md"), "# Index\n");
  await run("git", ["init", "--quiet"], { cwd: dataRoot });
  await commitAll(dataRoot, "init", [["wiki/index.md", "# Index\n"]]);

  return dataRoot;
}

/** Stage and commit file writes at a fixed commit date. */
async function commitAll(
  root: string,
  message: string,
  files: readonly (readonly [string, string])[],
  date = "2026-08-18T12:00:00+00:00",
): Promise<void> {
  for (const [path, text] of files) {
    await writeFile(join(root, path), text);
  }

  await run("git", ["add", "-A"], { cwd: root });
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
      message,
    ],
    { cwd: root, env: { ...process.env, GIT_COMMITTER_DATE: date } },
  );
}

/**
 * A committed data repo (wiki/index.md, wiki/log.md, one source and
 * one concept page) plus a written outputs/last-query.md artifact.
 */
async function makeFiledRepo(): Promise<{
  readonly dataRoot: string;
  readonly artifactPath: string;
}> {
  const dataRoot = await makeCommittedRepo();

  await writeFile(join(dataRoot, "wiki", "log.md"), "# Wiki Log\n");
  await mkdir(join(dataRoot, "wiki", "sources"), { recursive: true });
  await mkdir(join(dataRoot, "wiki", "concepts"), { recursive: true });
  await writeFile(
    join(dataRoot, "wiki", "sources", "retrieval-augmented-generation.md"),
    "---\ntype: source\n---\nRAG\n",
  );
  await writeFile(
    join(dataRoot, "wiki", "concepts", "chunking.md"),
    "---\ntype: concept\n---\nChunking\n",
  );
  await commitAll(dataRoot, "pages", [["wiki/log.md", "# Wiki Log\n"]]);

  const artifactPath = join(dataRoot, "outputs", "last-query.md");

  await mkdir(join(dataRoot, "outputs"), { recursive: true });
  await writeFile(artifactPath, renderQueryArtifact(ARTIFACT), "utf8");

  return { dataRoot, artifactPath };
}

describe("parseQueryArtifact strictness", () => {
  const okTimestamp = "2026-01-01T00:00:00Z";

  it("names the missing frontmatter block exactly", () => {
    expect(() => parseQueryArtifact("Just an answer.\n")).toThrow(
      "not a wiki-query artifact: no frontmatter block",
    );
  });

  it("names the unterminated frontmatter block exactly", () => {
    expect(() => parseQueryArtifact('---\nquestion: "q"\n')).toThrow(
      "not a wiki-query artifact: unterminated frontmatter block",
    );
  });

  it("names a malformed header line exactly", () => {
    expect(() => parseQueryArtifact(`---\ngarbage\n---\n\nA.\n`)).toThrow(
      'not a wiki-query artifact: malformed header line "garbage"',
    );
  });

  it("rejects a header line with a leading prefix", () => {
    expect(() =>
      parseQueryArtifact(`---\nxquestion: "q"\n---\n\nA.\n`),
    ).toThrow("not a wiki-query artifact: malformed header line");
  });

  it("rejects a non-string question value naming the missing header", () => {
    expect(() =>
      parseQueryArtifact(
        `---\nquestion: 42\ntimestamp: "${okTimestamp}"\npages: []\n---\n\nA.\n`,
      ),
    ).toThrow(
      "not a wiki-query artifact: missing question, timestamp, or pages header",
    );
  });

  it("rejects a non-string timestamp value naming the missing header", () => {
    expect(() =>
      parseQueryArtifact(
        '---\nquestion: "q"\ntimestamp: 42\npages: []\n---\n\nA.\n',
      ),
    ).toThrow(
      "not a wiki-query artifact: missing question, timestamp, or pages header",
    );
  });

  it("rejects a non-array pages value naming the missing header", () => {
    expect(() =>
      parseQueryArtifact(
        `---\nquestion: "q"\ntimestamp: "${okTimestamp}"\npages: "x"\n---\n\nA.\n`,
      ),
    ).toThrow(
      "not a wiki-query artifact: missing question, timestamp, or pages header",
    );
  });

  it("rejects a pages list with a non-string item naming the missing header", () => {
    expect(() =>
      parseQueryArtifact(
        `---\nquestion: "q"\ntimestamp: "${okTimestamp}"\npages: ["a", 5]\n---\n\nA.\n`,
      ),
    ).toThrow(
      "not a wiki-query artifact: missing question, timestamp, or pages header",
    );
  });

  it("names the missing question header when only timestamp and pages are present", () => {
    expect(() =>
      parseQueryArtifact(
        `---\ntimestamp: "${okTimestamp}"\npages: []\n---\n\nA.\n`,
      ),
    ).toThrow(
      "not a wiki-query artifact: missing question, timestamp, or pages header",
    );
  });

  it("names the missing timestamp header when only question and pages are present", () => {
    expect(() =>
      parseQueryArtifact('---\nquestion: "q"\npages: []\n---\n\nA.\n'),
    ).toThrow(
      "not a wiki-query artifact: missing question, timestamp, or pages header",
    );
  });

  it("names the missing pages header when only question and timestamp are present", () => {
    expect(() =>
      parseQueryArtifact(
        `---\nquestion: "q"\ntimestamp: "${okTimestamp}"\n---\n\nA.\n`,
      ),
    ).toThrow(
      "not a wiki-query artifact: missing question, timestamp, or pages header",
    );
  });

  it("names the invalid timestamp exactly", () => {
    expect(() =>
      parseQueryArtifact(
        renderQueryArtifact({ ...ARTIFACT, timestamp: "not-a-date" }),
      ),
    ).toThrow(
      'not a wiki-query artifact: timestamp "not-a-date" is not a date',
    );
  });

  it("names a broken JSON header value as malformed", () => {
    expect(() =>
      parseQueryArtifact("---\nquestion: [broken\n---\n\nA.\n"),
    ).toThrow(
      'not a wiki-query artifact: malformed header line "question: [broken"',
    );
  });

  it("strips exactly one blank line after the frontmatter block", () => {
    expect(
      parseQueryArtifact(
        `---\nquestion: "q"\ntimestamp: "${okTimestamp}"\npages: []\n---\n\n\nAnswer.`,
      ).answer,
    ).toBe("\nAnswer.");
  });

  it("throws an Error instance for non-artifact text", () => {
    let caught: unknown;

    try {
      parseQueryArtifact("nope");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
  });
});

describe("citedSourcePages ordering and empties", () => {
  it("returns no sources for an empty citation list", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-fl-"));

    tempDirs.push(dir);

    await mkdir(join(dir, "sources"), { recursive: true });
    await writeFile(
      join(dir, "sources", "a.md"),
      "---\ntype: source\n---\nA\n",
    );

    expect(await citedSourcePages(dir, [])).toEqual([]);
  });

  it("returns cited source pages sorted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-fl-"));

    tempDirs.push(dir);

    await mkdir(join(dir, "sources"), { recursive: true });
    await writeFile(
      join(dir, "sources", "zeta.md"),
      "---\ntype: source\n---\nZ\n",
    );
    await writeFile(
      join(dir, "sources", "alpha.md"),
      "---\ntype: source\n---\nA\n",
    );

    expect(await citedSourcePages(dir, ["zeta", "alpha"])).toEqual([
      "alpha",
      "zeta",
    ]);
  });
});

describe("slugForQuestion separator edges", () => {
  it("drops leading and trailing separator runs entirely", () => {
    expect(slugForQuestion("??? what next ???")).toBe("what-next");
  });
});

describe("templateQueryPage exact render", () => {
  it("renders the exact page for a sourced query", () => {
    expect(
      templateQueryPage(ARTIFACT, {
        created: "2026-08-21",
        updated: "2026-08-21",
        sources: ["alpha", "zeta"],
      }),
    ).toBe(
      [
        "---",
        `title: ${JSON.stringify(QUESTION)}`,
        "type: query",
        `question: ${JSON.stringify(QUESTION)}`,
        "created: 2026-08-21",
        "updated: 2026-08-21",
        "tags:",
        "  - query",
        "sources:",
        '  - "[[alpha]]"',
        '  - "[[zeta]]"',
        "---",
        "",
        `# ${QUESTION}`,
        "",
        ANSWER,
        "",
      ].join("\n"),
    );
  });

  it("renders the exact page for a sourceless query", () => {
    expect(
      templateQueryPage(ARTIFACT, {
        created: "2026-08-21",
        updated: "2026-08-21",
        sources: [],
      }),
    ).toBe(
      [
        "---",
        `title: ${JSON.stringify(QUESTION)}`,
        "type: query",
        `question: ${JSON.stringify(QUESTION)}`,
        "created: 2026-08-21",
        "updated: 2026-08-21",
        "tags:",
        "  - query",
        "sources: []",
        "---",
        "",
        `# ${QUESTION}`,
        "",
        ANSWER,
        "",
      ].join("\n"),
    );
  });
});

describe("indexEntryFor whitespace", () => {
  it("collapses inner whitespace runs and trims the question", () => {
    expect(indexEntryFor("x", "  a   b  ")).toBe("- [[x]] — a b");
  });
});

describe("appendIndexEntry newline edges", () => {
  it("appends the section when the index lacks a trailing newline", () => {
    expect(appendIndexEntry("# Wiki Index", "- e")).toBe(
      "# Wiki Index\n\n## Queries\n\n- e\n",
    );
  });

  it("creates the index with its heading when it is empty", () => {
    expect(appendIndexEntry("", "- e")).toBe(
      "# Wiki Index\n\n## Queries\n\n- e\n",
    );
  });
});

describe("driftWarning boundaries", () => {
  it("is undefined when commits never touched raw/ or wiki/", async () => {
    const dataRoot = await makeCommittedRepo();

    await rm(join(dataRoot, "wiki", "index.md"));
    await commitAll(dataRoot, "docs only", [["README.md", "# R\n"]]);

    expect(
      await driftWarning(dataRoot, process.env, "2026-08-20T10:00:00Z"),
    ).toBeUndefined();
  });

  it("is undefined when the last commit is exactly at the saved timestamp", async () => {
    const dataRoot = await makeCommittedRepo();

    await commitAll(
      dataRoot,
      "wiki edit",
      [["wiki/index.md", "# Index v2\n"]],
      "2026-08-20T10:00:00+00:00",
    );

    expect(
      await driftWarning(dataRoot, process.env, "2026-08-20T10:00:00Z"),
    ).toBeUndefined();
  });
});

describe("fileLastQuery file creation", () => {
  it("creates index.md and log.md with their headings when absent", async () => {
    const { dataRoot, artifactPath } = await makeFiledRepo();

    await rm(join(dataRoot, "wiki", "index.md"));
    await rm(join(dataRoot, "wiki", "log.md"));

    await fileLastQuery({
      artifactPath,
      dataRoot,
      now: () => new Date("2026-08-21T09:00:00Z"),
    });

    expect(await readFile(join(dataRoot, "wiki", "index.md"), "utf8")).toBe(
      `# Wiki Index\n\n## Queries\n\n- [[when-should-i-prefer-rag-over-fine-tuning]] — ${QUESTION}\n`,
    );
    expect(await readFile(join(dataRoot, "wiki", "log.md"), "utf8")).toBe(
      `# Wiki Log\n\n## [2026-08-21] query | ${QUESTION}\n`,
    );
  });

  it("appends the entry after a log without a trailing newline", async () => {
    const { dataRoot, artifactPath } = await makeFiledRepo();

    await writeFile(join(dataRoot, "wiki", "log.md"), "# Wiki Log");

    await fileLastQuery({
      artifactPath,
      dataRoot,
      now: () => new Date("2026-08-21T09:00:00Z"),
    });

    expect(await readFile(join(dataRoot, "wiki", "log.md"), "utf8")).toBe(
      `# Wiki Log\n\n## [2026-08-21] query | ${QUESTION}\n`,
    );
  });

  it("reports no progress when nothing drifted", async () => {
    const { dataRoot, artifactPath } = await makeFiledRepo();
    const messages: string[] = [];

    await fileLastQuery({
      artifactPath,
      dataRoot,
      now: () => new Date("2026-08-21T09:00:00Z"),
      onProgress: (message) => messages.push(message),
    });

    expect(messages).toEqual([]);
  });

  it("files as -999 when 998 pages share the slug", async () => {
    const { dataRoot, artifactPath } = await makeFiledRepo();
    const queriesDir = join(dataRoot, "wiki", "queries");

    await mkdir(queriesDir, { recursive: true });

    for (let attempt = 1; attempt <= 998; attempt += 1) {
      const suffix = attempt === 1 ? "" : `-${attempt}`;

      await writeFile(
        join(
          queriesDir,
          `when-should-i-prefer-rag-over-fine-tuning${suffix}.md`,
        ),
        "taken\n",
      );
    }

    const result = await fileLastQuery({
      artifactPath,
      dataRoot,
      now: () => new Date("2026-08-21T09:00:00Z"),
    });

    expect(result.pagePath).toBe(
      "wiki/queries/when-should-i-prefer-rag-over-fine-tuning-999.md",
    );
  });

  it("fails naming the count when 999 pages share the slug", async () => {
    const { dataRoot, artifactPath } = await makeFiledRepo();
    const queriesDir = join(dataRoot, "wiki", "queries");

    await mkdir(queriesDir, { recursive: true });

    for (let attempt = 1; attempt <= 999; attempt += 1) {
      const suffix = attempt === 1 ? "" : `-${attempt}`;

      await writeFile(
        join(
          queriesDir,
          `when-should-i-prefer-rag-over-fine-tuning${suffix}.md`,
        ),
        "taken\n",
      );
    }

    await expect(
      fileLastQuery({
        artifactPath,
        dataRoot,
        now: () => new Date("2026-08-21T09:00:00Z"),
      }),
    ).rejects.toThrow(
      'cannot file the query: 999 pages already share the slug "when-should-i-prefer-rag-over-fine-tuning"',
    );
  });
});

describe("citedSourcePages without a wiki", () => {
  it("returns no sources without touching a missing wiki directory", async () => {
    await expect(citedSourcePages("/no/such/wiki", [])).resolves.toEqual([]);
  });
});

describe("appendIndexEntry with a foreign heading", () => {
  it("keeps a non-standard top heading when appending the section", () => {
    expect(appendIndexEntry("# Other Heading", "- e")).toBe(
      "# Other Heading\n\n## Queries\n\n- e\n",
    );
  });
});

describe("fileLastQuery against an established wiki", () => {
  /** makeFiledRepo with an index ## Queries section and prior log entries. */
  async function makeEstablishedRepo() {
    const repo = await makeFiledRepo();

    await writeFile(
      join(repo.dataRoot, "wiki", "index.md"),
      [
        "# Wiki Index",
        "",
        "## Concepts",
        "",
        "<!-- concepts here -->",
        "",
        "## Queries",
        "",
        "<!-- Add filed query answers here -->",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(repo.dataRoot, "wiki", "log.md"),
      "# Wiki Log\n\n## [2026-08-01] ingest | RAG notes\n",
    );
    await commitAll(repo.dataRoot, "established", [["README.md", "# R\n"]]);

    return repo;
  }

  it("inserts the entry under the existing ## Queries heading and preserves the rest", async () => {
    const { dataRoot, artifactPath } = await makeEstablishedRepo();

    await fileLastQuery({
      artifactPath,
      dataRoot,
      now: () => new Date("2026-08-21T09:00:00Z"),
    });

    expect(await readFile(join(dataRoot, "wiki", "index.md"), "utf8")).toBe(
      [
        "# Wiki Index",
        "",
        "## Concepts",
        "",
        "<!-- concepts here -->",
        "",
        "## Queries",
        `- [[when-should-i-prefer-rag-over-fine-tuning]] — ${QUESTION}`,
        "",
        "<!-- Add filed query answers here -->",
        "",
      ].join("\n"),
    );
  });

  it("appends the log entry after the existing ones, preserving them", async () => {
    const { dataRoot, artifactPath } = await makeEstablishedRepo();

    await fileLastQuery({
      artifactPath,
      dataRoot,
      now: () => new Date("2026-08-21T09:00:00Z"),
    });

    expect(await readFile(join(dataRoot, "wiki", "log.md"), "utf8")).toBe(
      `# Wiki Log\n\n## [2026-08-01] ingest | RAG notes\n\n## [2026-08-21] query | ${QUESTION}\n`,
    );
  });

  it("adds exactly one separator newline after a log with no trailing newline", async () => {
    const { dataRoot, artifactPath } = await makeFiledRepo();

    await writeFile(join(dataRoot, "wiki", "log.md"), "# Wiki Log");

    await fileLastQuery({
      artifactPath,
      dataRoot,
      now: () => new Date("2026-08-21T09:00:00Z"),
    });

    expect(await readFile(join(dataRoot, "wiki", "log.md"), "utf8")).toBe(
      `# Wiki Log\n\n## [2026-08-21] query | ${QUESTION}\n`,
    );
  });

  it("keeps a log that starts with a blank line byte-exact before the entry", async () => {
    const { dataRoot, artifactPath } = await makeFiledRepo();

    await writeFile(join(dataRoot, "wiki", "log.md"), "\n# Wiki Log");

    await fileLastQuery({
      artifactPath,
      dataRoot,
      now: () => new Date("2026-08-21T09:00:00Z"),
    });

    expect(await readFile(join(dataRoot, "wiki", "log.md"), "utf8")).toBe(
      `\n# Wiki Log\n\n## [2026-08-21] query | ${QUESTION}\n`,
    );
  });
});

describe("driftWarning without wiki history", () => {
  it("is undefined when no commit ever touched raw/ or wiki/", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-fl-"));

    tempDirs.push(dir);

    await writeFile(join(dir, "README.md"), "# R\n");
    await run("git", ["init", "--quiet"], { cwd: dir });
    await commitAll(dir, "docs only", [["README.md", "# R\n"]]);

    expect(
      await driftWarning(dir, process.env, "2026-08-20T10:00:00Z"),
    ).toBeUndefined();
  });
});

describe("parseQueryArtifact hand-edited bodies", () => {
  it("keeps a body that starts directly after the frontmatter with no blank line", () => {
    expect(
      parseQueryArtifact(
        '---\nquestion: "q"\ntimestamp: "2026-01-01T00:00:00Z"\npages: []\n---\nA.\nB.',
      ).answer,
    ).toBe("A.\nB.");
  });
});
