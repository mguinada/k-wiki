import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Synthetic Obsidian vault fixture generator.
 *
 * Produces a deterministic fake vault (known bytes, no timestamps, no
 * randomness) covering every selection, change, and noise case the sync
 * layer must handle. Run via `npm run fixtures -- <target-dir>`; the vault
 * is written to `<target-dir>/Documents/` so path handling mirrors the real
 * vault's shape. A checked-in copy lives at tests/fixtures/Documents.
 */

/** Mirrors the real vault's name so path handling stays honest. */
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

/** Excluded: no frontmatter at all. */
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
	{ path: "Inbox/parking-lot.md", content: NO_FRONTMATTER_NOTE },
	{ path: "Projects/house-renovation.md", content: PRIVATE_PROJECT_NOTE },
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

export async function main(): Promise<void> {
	const targetDir = process.argv[2];

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

/* v8 ignore next: import guard — distinguishes direct execution from
   import; not exercisable in-process by construction */
const isMain =
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href;

/* v8 ignore next: covered only under `node src/fixtures/generate.ts` */
if (isMain) {
	await main();
}
