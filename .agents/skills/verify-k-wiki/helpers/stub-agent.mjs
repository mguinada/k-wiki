#!/usr/bin/env node
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Verification stub agent for k-wiki (adapted from tests/e2e). It is
 * named in a temp settings.yml via `command:` and receives the exact
 * argv the real agent CLI would. It records the composed prompt and
 * argv under <cwd>/outputs/ so a verification run can assert what the
 * agent actually saw, then behaves like the real agent:
 * - query prompts ("answering questions"): answer plainly via stdout,
 *   write nothing under wiki/ (stage-1 answer-only contract);
 * - expunge prompts ("deleted from the vault"): remove the seeded
 *   pages for the deleted note;
 * - ingest/lint prompts: write contract-frontmatter wiki pages so the
 *   post-run guardrails pass.
 * Exits 3 when the --print payload is missing — the wrapper must pass
 * the prompt.
 */
const index = process.argv.indexOf("--print");
const prompt = index === -1 ? undefined : process.argv[index + 1];

if (prompt === undefined || prompt === "") {
  process.exit(3);
}

await mkdir(join(process.cwd(), "outputs"), { recursive: true });
await writeFile(join(process.cwd(), "outputs", "stub-prompt.txt"), prompt);
await writeFile(
  join(process.cwd(), "outputs", "stub-argv.txt"),
  process.argv.slice(2).join("\n"),
);

if (prompt.includes("answering questions")) {
  console.log(
    "stub agent: answer-only run; the wiki pages were not consulted, " +
      "but the prompt and this line prove the query path end to end.",
  );
  process.exit(0);
}

await mkdir(join(process.cwd(), "wiki", "concepts"), { recursive: true });
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
    "origin: raw/notes/Documents/Scratch/temp-research.md",
    "sources:",
    '  - "[[stub-source]]"',
    "---",
    "",
    "hub body",
    "",
  ].join("\n"),
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
  ].join("\n"),
);

const INDEX_FRONTMATTER = [
  "---",
  'title: "Index"',
  "type: topic",
  "created: 2026-08-20",
  "updated: 2026-08-20",
  "tags:",
  "  - llm",
];

if (prompt.includes("deleted from the vault")) {
  await rm(join(process.cwd(), "wiki", "sources", "stub-source.md"));
  await rm(join(process.cwd(), "wiki", "concepts", "stub.md"));
  await writeFile(
    join(process.cwd(), "wiki", "index.md"),
    [...INDEX_FRONTMATTER, "---", "", "# Index v3", ""].join("\n"),
  );
} else {
  await writeFile(
    join(process.cwd(), "wiki", "index.md"),
    [
      ...INDEX_FRONTMATTER,
      "sources:",
      '  - "[[stub-source]]"',
      "---",
      "",
      "# Index v2",
      "",
    ].join("\n"),
  );
}
console.log(
  prompt.includes("deleted from the vault")
    ? "stub agent: expunge run; claims removed"
    : "stub agent: sources processed; no contradictions; no unresolved questions",
);
