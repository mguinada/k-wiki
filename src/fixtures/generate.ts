import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cliFail } from "../cli/colors.ts";
import { refuseDirectExecution } from "../cli/is-main.ts";
import { parseArgs } from "../cli/shell.ts";

/**
 * Synthetic Obsidian vault fixture generator.
 *
 * Produces a deterministic fake vault (known bytes, no timestamps, no
 * randomness) covering every selection, change, and noise case the sync
 * layer must handle. Run via `npm run fixtures -- <target-dir>`; the vault
 * is written to `<target-dir>/Documents/` so path handling mirrors the real
 * vault's shape. A checked-in copy lives at tests/fixtures/Documents.
 */

/** Realistic vault name so path handling in tests stays honest. */
export const VAULT_NAME = "Documents";

interface FixtureFile {
  /** POSIX-style path relative to the vault root. */
  readonly path: string;
  readonly content: string | Uint8Array;
}

const RAG_NOTE = `---
tags:
  - AI
  - retrieval
wiki: true
---

# Retrieval-Augmented Generation

Notes on RAG: retrieve passages, augment the prompt, generate grounded
answers.

## Why retrieval

Parametric knowledge goes stale and hallucinates; retrieved passages pin
the model to current, citable sources.
`;

const ATTENTION_NOTE = `---
tags:
  - AI
  - transformers
source: https://arxiv.org/abs/1706.03762
wiki: true
---

# Attention Is All You Need

Paper notes: self-attention replaces recurrence; positional encodings
restore order information; multi-head attention attends to different
representation subspaces.
`;

/** Hash-change case: sync tests edit this note's content between runs. */
const RAG_EVALUATION_NOTE = `---
tags:
  - AI
  - evaluation
wiki: true
---

# RAG evaluation notes

Working notes on faithfulness and answer-relevance metrics. This note is
edited between sync runs to exercise hash-change detection.
`;

/** Removal case: sync tests delete this note or flip its flag between runs. */
const TEMP_RESEARCH_NOTE = `---
tags:
  - scratch
wiki: true
---

# Temp research

Ephemeral note. This note is deleted or unflagged between sync runs to
exercise removal detection.
`;

/** Excluded: explicit opt-out. */
const PRIVATE_PROJECT_NOTE = `---
tags:
  - personal
wiki: false
---

# House renovation

Private project tracking. Must stay out of the wiki.
`;

/** Ingested under opt-out: no frontmatter means nothing blocks it. */
const NO_FRONTMATTER_NOTE = `# Parking lot

Unsorted clippings with no frontmatter. Sync must skip this note.
`;

/** Noise: trashed note, flagged, but sync must never descend into .trash. */
const TRASHED_NOTE = `---
wiki: true
---

# Old scratch note

Deleted from the vault. Sync must never pick this up from .trash.
`;

/** Ingested: flag present but blank (the opt-out rule ingests it). */
const BLANK_FLAG_NOTE = `---
tags:
  - inbox
wiki:
---

# Quick idea

One-liner captured on the go. A blank flag value must not block the
note.
`;

/** Ingested: quoted flag, as the Obsidian web clipper writes it. */
const CLIPPED_NOTE = `---
source: https://example.com/rag-overview
wiki: "true"
---

# Clipped overview

Web clipper output. A Text property quotes its value; a quoted value
counts like an unquoted one.
`;

/** Excluded: quoted block, as the web clipper writes it. */
const PRIVATE_CLIPPED_NOTE = `---
source: https://example.com/private
wiki: "false"
---

# Private clipping

Clipped private material. The quoted block must keep it out of the
wiki.
`;

/** Noise: macOS Finder metadata (Bud1 magic header, fixed bytes). */
const DS_STORE_BYTES = new Uint8Array([
  0x00, 0x00, 0x00, 0x01, 0x42, 0x75, 0x64, 0x31,
]);

/** Noise: Obsidian settings. */
const OBSIDIAN_APP_JSON = `{
  "alwaysUpdateLinks": true,
  "newFileFolderPath": "Inbox",
  "useMarkdownLinks": false
}
`;

/** Sorted by path so writes and CLI output are deterministic. */
const FILES: readonly FixtureFile[] = [
  { path: ".DS_Store", content: DS_STORE_BYTES },
  { path: ".obsidian/app.json", content: OBSIDIAN_APP_JSON },
  { path: ".trash/deleted.md", content: TRASHED_NOTE },
  { path: "AI/RAG.md", content: RAG_NOTE },
  { path: "AI/llms/attention-is-all-you-need.md", content: ATTENTION_NOTE },
  { path: "AI/rag-evaluation-notes.md", content: RAG_EVALUATION_NOTE },
  { path: "Inbox/clipped-note.md", content: CLIPPED_NOTE },
  { path: "Inbox/parking-lot.md", content: NO_FRONTMATTER_NOTE },
  { path: "Inbox/quick-idea.md", content: BLANK_FLAG_NOTE },
  { path: "Projects/house-renovation.md", content: PRIVATE_PROJECT_NOTE },
  { path: "Projects/private-clipped.md", content: PRIVATE_CLIPPED_NOTE },
  { path: "Scratch/temp-research.md", content: TEMP_RESEARCH_NOTE },
];

/** Every fixture path, relative to the vault root, POSIX-style, sorted. */
export function fixtureFilePaths(): string[] {
  return FILES.map((file) => file.path);
}

/**
 * Write the synthetic vault to `<targetDir>/Documents/` and return the
 * absolute vault root. Existing files are overwritten; output is
 * deterministic, so repeated runs are byte-identical.
 */
export async function generateFixtureVault(targetDir: string): Promise<string> {
  const vaultRoot = join(targetDir, VAULT_NAME);

  for (const file of FILES) {
    const absolute = join(vaultRoot, ...file.path.split("/"));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, file.content);
  }

  return vaultRoot;
}

/** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
const HELP = `Usage: fixtures [-h | --help] <target-dir>

Write the synthetic Obsidian test vault to <target-dir>/Documents —
deterministic bytes, no timestamps; the snapshot copy lives at
tests/fixtures/Documents.

  -h, --help      Print this help and exit; no side effects.
  <target-dir>    Destination directory for the Documents/ vault.`;

export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);

    return;
  }

  const parsed = parseArgs(args, {
    positionals: {
      max: 1,
      error: (_arg, count) =>
        `expected at most one <target-dir> argument, got ${count}`,
    },
  });

  if (parsed.error !== undefined) {
    cliFail("fixtures", parsed.error);

    return;
  }

  const targetDir = parsed.positional[0];

  if (targetDir === undefined) {
    console.error("Usage: npm run fixtures -- <target-dir>");
    process.exitCode = 1;
    return;
  }

  const vaultRoot = await generateFixtureVault(targetDir);

  for (const path of fixtureFilePaths()) {
    console.log(`${VAULT_NAME}/${path}`);
  }

  console.log(`Fixture vault written to ${vaultRoot}`);
}

/* v8 ignore next: covered only under direct `node src/fixtures/generate.ts` runs */
refuseDirectExecution(import.meta.url, "generate", "dev");
