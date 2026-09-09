/**
 * Synthetic Obsidian vault fixture generator.
 *
 * Produces a deterministic fake vault (known bytes, no timestamps, no
 * randomness) covering every selection, change, and noise case the sync
 * layer must handle. Run via `npm run fixtures -- <target-dir>`; the vault
 * is written to `<target-dir>/Documents/` so path handling mirrors the real
 * vault's shape. A checked-in copy lives at tests/fixtures/Documents.
 * The vault's bytes and paths are built at call time, not as
 * module-scope tables (issue #354): module-init data is static to
 * Stryker's per-test coverage — each of its mutants re-runs the whole
 * suite — while builder bodies run inside covering tests.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cliFail } from "../cli/colors.ts";
import { refuseDirectExecution } from "../cli/is-main.ts";
import { parseArgs } from "../cli/shell.ts";

/** Realistic vault name so path handling in tests stays honest. */
export function vaultName(): string {
  return "Documents";
}

interface FixtureFile {
  /** POSIX-style path relative to the vault root. */
  readonly path: string;
  readonly content: string | Uint8Array;
}

/** The fixture files — note contents and paths — built at call time
 *  (issue #354: module-init data is mutation-static). Sorted by path
 *  so writes and CLI output are deterministic. */
function fixtureFiles(): readonly FixtureFile[] {
  const ragNote = `---
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

  const attentionNote = `---
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
  const ragEvaluationNote = `---
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
  const tempResearchNote = `---
tags:
  - scratch
wiki: true
---

# Temp research

Ephemeral note. This note is deleted or unflagged between sync runs to
exercise removal detection.
`;

  /** Excluded: explicit opt-out. */
  const privateProjectNote = `---
tags:
  - personal
wiki: false
---

# House renovation

Private project tracking. Must stay out of the wiki.
`;

  /** Ingested under opt-out: no frontmatter means nothing blocks it. */
  const noFrontmatterNote = `# Parking lot

Unsorted clippings with no frontmatter. Sync must skip this note.
`;

  /** Noise: trashed note, flagged, but sync must never descend into .trash. */
  const trashedNote = `---
wiki: true
---

# Old scratch note

Deleted from the vault. Sync must never pick this up from .trash.
`;

  /** Ingested: flag present but blank (the opt-out rule ingests it). */
  const blankFlagNote = `---
tags:
  - inbox
wiki:
---

# Quick idea

One-liner captured on the go. A blank flag value must not block the
note.
`;

  /** Ingested: quoted flag, as the Obsidian web clipper writes it. */
  const clippedNote = `---
source: https://example.com/rag-overview
wiki: "true"
---

# Clipped overview

Web clipper output. A Text property quotes its value; a quoted value
counts like an unquoted one.
`;

  /** Excluded: quoted block, as the web clipper writes it. */
  const privateClippedNote = `---
source: https://example.com/private
wiki: "false"
---

# Private clipping

Clipped private material. The quoted block must keep it out of the
wiki.
`;

  /** Noise: macOS Finder metadata (Bud1 magic header, fixed bytes). */
  const dsStoreBytes = new Uint8Array([
    0x00, 0x00, 0x00, 0x01, 0x42, 0x75, 0x64, 0x31,
  ]);

  /** Noise: Obsidian settings. */
  const obsidianAppJson = `{
  "alwaysUpdateLinks": true,
  "newFileFolderPath": "Inbox",
  "useMarkdownLinks": false
}
`;

  return [
    { path: ".DS_Store", content: dsStoreBytes },
    { path: ".obsidian/app.json", content: obsidianAppJson },
    { path: ".trash/deleted.md", content: trashedNote },
    { path: "AI/RAG.md", content: ragNote },
    { path: "AI/llms/attention-is-all-you-need.md", content: attentionNote },
    { path: "AI/rag-evaluation-notes.md", content: ragEvaluationNote },
    { path: "Inbox/clipped-note.md", content: clippedNote },
    { path: "Inbox/parking-lot.md", content: noFrontmatterNote },
    { path: "Inbox/quick-idea.md", content: blankFlagNote },
    { path: "Projects/house-renovation.md", content: privateProjectNote },
    { path: "Projects/private-clipped.md", content: privateClippedNote },
    { path: "Scratch/temp-research.md", content: tempResearchNote },
  ];
}

/** Every fixture path, relative to the vault root, POSIX-style, sorted. */
export function fixtureFilePaths(): string[] {
  return fixtureFiles().map((file) => file.path);
}

/**
 * Write the synthetic vault to `<targetDir>/Documents/` and return the
 * absolute vault root. Existing files are overwritten; output is
 * deterministic, so repeated runs are byte-identical.
 */
export async function generateFixtureVault(targetDir: string): Promise<string> {
  const vaultRoot = join(targetDir, vaultName());

  for (const file of fixtureFiles()) {
    const absolute = join(vaultRoot, ...file.path.split("/"));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, file.content);
  }

  return vaultRoot;
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    /** Help text: every switch, argument, and default (AGENTS.md CLI rule). */
    const help = `Usage: fixtures [-h | --help] <target-dir>

Write the synthetic Obsidian test vault to <target-dir>/Documents —
deterministic bytes, no timestamps; the snapshot copy lives at
tests/fixtures/Documents.

  -h, --help      Print this help and exit; no side effects.
  <target-dir>    Destination directory for the Documents/ vault.`;

    console.log(help);

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
    console.log(`${vaultName()}/${path}`);
  }

  console.log(`Fixture vault written to ${vaultRoot}`);
}

/* v8 ignore next: covered only under direct `node src/fixtures/generate.ts` runs */
refuseDirectExecution(import.meta.url, "generate", "dev");
