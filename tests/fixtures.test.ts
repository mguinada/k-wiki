import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
	fixtureFilePaths,
	generateFixtureVault,
	VAULT_NAME,
} from "../src/fixtures/generate.ts";

const snapshotVaultRoot = fileURLToPath(
	new URL("./fixtures/Documents", import.meta.url),
);

const tempDirs: string[] = [];

afterAll(async () => {
	await Promise.all(
		tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

async function makeTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "k-wiki-fixtures-"));
	tempDirs.push(dir);
	return dir;
}

/** Recursively collect POSIX-style relative file paths under root. */
async function collectFiles(root: string, prefix = ""): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		if (entry.isDirectory()) {
			files.push(...(await collectFiles(join(root, entry.name), rel)));
		} else if (entry.isFile()) {
			files.push(rel);
		}
	}
	return files.sort();
}

/** Assert two trees have the same relative paths and byte-identical files. */
async function expectTreesEqual(
	actualRoot: string,
	expectedRoot: string,
): Promise<void> {
	const [actual, expected] = await Promise.all([
		collectFiles(actualRoot),
		collectFiles(expectedRoot),
	]);
	expect(actual).toEqual(expected);
	for (const rel of actual) {
		const [actualBytes, expectedBytes] = await Promise.all([
			readFile(join(actualRoot, ...rel.split("/"))),
			readFile(join(expectedRoot, ...rel.split("/"))),
		]);
		expect(actualBytes.equals(expectedBytes), `file differs: ${rel}`).toBe(
			true,
		);
	}
}

/** Assert a note's frontmatter block contains the given key: value line. */
async function expectFrontmatter(
	vaultRoot: string,
	relPath: string,
	line: string,
): Promise<void> {
	const text = await readFile(join(vaultRoot, ...relPath.split("/")), "utf8");
	expect(text.startsWith("---\n"), `${relPath} has frontmatter`).toBe(true);
	const end = text.indexOf("\n---\n", 4);
	expect(end, `${relPath} closes its frontmatter`).toBeGreaterThan(0);
	const frontmatter = text.slice(4, end);
	expect(frontmatter, `${relPath} frontmatter contains "${line}"`).toContain(
		line,
	);
}

describe("fixture vault generator", () => {
	it("writes the vault under a target dir named like the real vault", async () => {
		const target = await makeTempDir();
		const vaultRoot = await generateFixtureVault(target);
		expect(vaultRoot).toBe(join(target, VAULT_NAME));
		const vaultStat = await stat(vaultRoot);
		expect(vaultStat.isDirectory()).toBe(true);
	});

	it("creates exactly the planned case matrix of files", async () => {
		const target = await makeTempDir();
		const vaultRoot = await generateFixtureVault(target);
		expect(await collectFiles(vaultRoot)).toEqual(fixtureFilePaths());
		expect(fixtureFilePaths()).toEqual([
			".DS_Store",
			".obsidian/app.json",
			".trash/deleted.md",
			"AI/RAG.md",
			"AI/llms/attention-is-all-you-need.md",
			"AI/rag-evaluation-notes.md",
			"Inbox/parking-lot.md",
			"Projects/house-renovation.md",
			"Scratch/temp-research.md",
		]);
	});

	it("selects two wiki:true notes at different nesting depths", async () => {
		const target = await makeTempDir();
		const vaultRoot = await generateFixtureVault(target);
		await expectFrontmatter(vaultRoot, "AI/RAG.md", "wiki: true");
		await expectFrontmatter(
			vaultRoot,
			"AI/llms/attention-is-all-you-need.md",
			"wiki: true",
		);
		const depth = (rel: string) => rel.split("/").length - 1;
		expect(depth("AI/RAG.md")).not.toBe(
			depth("AI/llms/attention-is-all-you-need.md"),
		);
	});

	it("seeds the hash-change and removal case notes with wiki:true", async () => {
		const target = await makeTempDir();
		const vaultRoot = await generateFixtureVault(target);
		await expectFrontmatter(
			vaultRoot,
			"AI/rag-evaluation-notes.md",
			"wiki: true",
		);
		await expectFrontmatter(
			vaultRoot,
			"Scratch/temp-research.md",
			"wiki: true",
		);
	});

	it("excludes one note with wiki:false and one without frontmatter", async () => {
		const target = await makeTempDir();
		const vaultRoot = await generateFixtureVault(target);
		await expectFrontmatter(
			vaultRoot,
			"Projects/house-renovation.md",
			"wiki: false",
		);
		const noFrontmatter = await readFile(
			join(vaultRoot, "Inbox/parking-lot.md"),
			"utf8",
		);
		expect(noFrontmatter.startsWith("---")).toBe(false);
	});

	it("plants noise that sync must skip", async () => {
		const target = await makeTempDir();
		const vaultRoot = await generateFixtureVault(target);
		const appJson = JSON.parse(
			await readFile(join(vaultRoot, ".obsidian/app.json"), "utf8"),
		);
		expect(appJson).toBeTypeOf("object");
		await expectFrontmatter(vaultRoot, ".trash/deleted.md", "wiki: true");
		const dsStore = await readFile(join(vaultRoot, ".DS_Store"));
		expect(dsStore.length).toBeGreaterThan(0);
	});

	it("is idempotent: two runs produce byte-identical trees", async () => {
		const first = await makeTempDir();
		const second = await makeTempDir();
		await generateFixtureVault(first);
		await generateFixtureVault(second);
		await expectTreesEqual(join(first, VAULT_NAME), join(second, VAULT_NAME));
	});

	it("matches the committed snapshot under tests/fixtures", async () => {
		const target = await makeTempDir();
		await generateFixtureVault(target);
		await expectTreesEqual(join(target, VAULT_NAME), snapshotVaultRoot);
	});
});
