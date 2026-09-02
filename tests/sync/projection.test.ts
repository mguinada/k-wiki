import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createColors } from "picocolors";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { pathExists } from "../../src/cli/shared.ts";
import { VAULT_NAME } from "../../src/fixtures/generate.ts";
import {
  colorizeError,
  colorizeProgress,
  compileIncludePattern,
  createSyncProgressSink,
  formatDryRunReport,
  formatReport,
  listNamespaceDirs,
  pruneEmptyDirs,
  reportColors,
  type SyncReport,
  type VaultDryRunReport,
  type VaultSyncReport,
} from "../../src/sync/projection.ts";
import { SELECTED_PATHS } from "../e2e/helpers.ts";

/** projection unit tests (issue #250): the shared sync library — the
 *  include pattern language, the report/progress rendering, and the
 *  progress sink presentation both adapters render through. */

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
}, 120_000);

describe("listNamespaceDirs", () => {
  it("lists a symlinked namespace directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-projection-"));

    tempDirs.push(dir);
    await mkdir(join(dir, "notes"));
    await mkdir(join(dir, "elsewhere"));
    await symlink(join(dir, "elsewhere"), join(dir, "notes", "Linked"));

    expect(await listNamespaceDirs(join(dir, "notes"))).toEqual(["Linked"]);
  });

  it("returns an empty list when the notes root is absent", async () => {
    expect(await listNamespaceDirs(join(tmpdir(), "k-wiki-absent"))).toEqual(
      [],
    );
  });

  it("rethrows a read error that is not a missing directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-projection-"));

    tempDirs.push(dir);

    const filePath = join(dir, "notes.txt");

    await writeFile(filePath, "not a directory\n");

    await expect(listNamespaceDirs(filePath)).rejects.toMatchObject({
      code: "ENOTDIR",
    });
  });
});

describe("compileIncludePattern", () => {
  it("matches an exact path pattern at that path", () => {
    const pattern = compileIncludePattern("README.md");

    expect(pattern.test("README.md")).toBe(true);
  });

  it("does not match an exact path pattern deeper in the tree", () => {
    const pattern = compileIncludePattern("README.md");

    expect(pattern.test("docs/README.md")).toBe(false);
  });

  it("does not match a filename that merely starts with the pattern", () => {
    const pattern = compileIncludePattern("README.md");

    expect(pattern.test("README.md2")).toBe(false);
  });

  it("treats regex metacharacters in a pattern as literals", () => {
    const pattern = compileIncludePattern("package.json");

    expect(pattern.test("package.json")).toBe(true);
  });

  it("does not let a literal dot match a substituted character", () => {
    const pattern = compileIncludePattern("package.json");

    expect(pattern.test("packageXjson")).toBe(false);
  });

  it("matches a single star inside one path segment", () => {
    const pattern = compileIncludePattern("docs/*.md");

    expect(pattern.test("docs/a.md")).toBe(true);
  });

  it("does not let a single star cross into deeper segments", () => {
    const pattern = compileIncludePattern("docs/*.md");

    expect(pattern.test("docs/sub/a.md")).toBe(false);
  });

  it("does not let a single star change the literal segment", () => {
    const pattern = compileIncludePattern("docs/*.md");

    expect(pattern.test("docsX/a.md")).toBe(false);
  });

  it("matches a double star across zero path segments", () => {
    const pattern = compileIncludePattern("src/**/*.ts");

    expect(pattern.test("src/a.ts")).toBe(true);
  });

  it("matches a double star across several path segments", () => {
    const pattern = compileIncludePattern("src/**/*.ts");

    expect(pattern.test("src/x/y/a.ts")).toBe(true);
  });

  it("does not let a double star change the literal segment", () => {
    const pattern = compileIncludePattern("src/**/*.ts");

    expect(pattern.test("srcx/a.ts")).toBe(false);
  });

  it("matches any path for a bare double-star pattern", () => {
    const pattern = compileIncludePattern("**");

    expect(pattern.test("deep/path/file.md")).toBe(true);
  });

  it("matches a leading double star at the top level", () => {
    const pattern = compileIncludePattern("**/*.md");

    expect(pattern.test("a.md")).toBe(true);
  });

  it("matches a leading double star at any depth", () => {
    const pattern = compileIncludePattern("**/*.md");

    expect(pattern.test("x/y/a.md")).toBe(true);
  });

  it("matches a trailing double star directly below the prefix", () => {
    const pattern = compileIncludePattern("docs/**");

    expect(pattern.test("docs/a.md")).toBe(true);
  });

  it("matches a trailing double star at deeper nesting", () => {
    const pattern = compileIncludePattern("docs/**");

    expect(pattern.test("docs/x/b.ts")).toBe(true);
  });

  it("does not let a trailing double star change the prefix segment", () => {
    const pattern = compileIncludePattern("docs/**");

    expect(pattern.test("docsX/a.md")).toBe(false);
  });
});

describe("compileIncludePattern multi-segment literals", () => {
  it("matches a two-segment exact pattern at that path", () => {
    const pattern = compileIncludePattern("docs/guide.md");

    expect(pattern.test("docs/guide.md")).toBe(true);
  });

  it("does not let a two-segment exact pattern flatten into one segment", () => {
    const pattern = compileIncludePattern("docs/guide.md");

    expect(pattern.test("docsguide.md")).toBe(false);
  });

  it("does not let a two-segment exact pattern match a longer extension", () => {
    const pattern = compileIncludePattern("docs/guide.md");

    expect(pattern.test("docs/guide.mdx")).toBe(false);
  });
});

describe("createSyncProgressSink", () => {
  const colorize = (text: string) => `[${text}]`;

  function makeSink(animated: boolean) {
    const written: string[] = [];
    const lines: string[] = [];
    const sink = createSyncProgressSink(
      (text) => written.push(text),
      (text) => lines.push(text),
      animated,
      colorize,
    );

    return { sink, written, lines };
  }

  const heartbeat = {
    kind: "heartbeat",
    text: `vault "${VAULT_NAME}": 1/9 read, 1 selected`,
  } as const;

  it("appends plain lines when not animated", () => {
    const { sink, written } = makeSink(false);

    sink.render(heartbeat);

    expect(written).toEqual([]);
  });

  it("appends the rendered line to the log when not animated", () => {
    const { sink, lines } = makeSink(false);

    sink.render(heartbeat);

    expect(lines).toEqual([`[vault "${VAULT_NAME}": 1/9 read, 1 selected]`]);
  });

  it("keeps heartbeats on the animated line", () => {
    const { sink, written } = makeSink(true);

    sink.render(heartbeat);

    expect(written).toEqual([
      `\r⠋ [vault "${VAULT_NAME}": 1/9 read, 1 selected]`,
    ]);
  });

  it("keeps scan heartbeats on the animated line", () => {
    const { sink, written } = makeSink(true);

    sink.render({
      kind: "heartbeat",
      text: `vault "${VAULT_NAME}": scanning (0s, 1000 dirs)`,
    });

    expect(written[0]).toMatch(/^\r⠋ \[.*scanning \(0s, 1000 dirs\)\]$/);
  });

  it("scrolls events on the animated sink", () => {
    const { sink, written } = makeSink(true);

    sink.render({
      kind: "event",
      text: `vault "${VAULT_NAME}": scanning /some/root`,
    });

    expect(written).toEqual([`[vault "${VAULT_NAME}": scanning /some/root]\n`]);
  });

  it("keeps multi-digit read heartbeats on the animated line", () => {
    const { sink, written } = makeSink(true);

    sink.render({
      kind: "heartbeat",
      text: `vault "${VAULT_NAME}": 12/345 read, 67 selected`,
    });

    expect(written[0]).toMatch(/^\r⠋ \[.*12\/345 read, 67 selected\]$/);
  });

  it("keeps a heartbeat for a vault name containing a colon on the animated line", () => {
    const { sink, written } = makeSink(true);

    sink.render({
      kind: "heartbeat",
      text: 'vault "notes:work": 1/9 read, 1 selected',
    });

    expect(written[0]).toMatch(/^\r⠋ /);
  });

  it("classifies by kind, not wording: heartbeat-shaped text tagged event scrolls", () => {
    const { sink, written } = makeSink(true);

    sink.render({
      kind: "event",
      text: `note: vault "${VAULT_NAME}": 1/9 read, 1 selected (quoted)`,
    });

    expect(written).toEqual([
      `[note: vault "${VAULT_NAME}": 1/9 read, 1 selected (quoted)]\n`,
    ]);
  });

  it("clears the animated line on end", () => {
    const { sink, written } = makeSink(true);

    sink.render(heartbeat);
    sink.end();

    expect(written[1]).toMatch(/^\r\s+\r$/);
  });
});

describe("formatReport source nouns", () => {
  it("labels a repo source with the repo noun, not vault", () => {
    const report: SyncReport = {
      sources: [
        {
          kind: "repo",
          name: "k-wiki",
          commit: "a1b2c3d4e5f6a7b8",
          candidates: 12,
          selected: 7,
          copied: ["src/a.ts"],
          unchanged: [],
          removed: [],
        },
      ],
      prunedNamespaces: [],
    };

    expect(formatReport(report).split("\n")[0]).toBe(
      'repo "k-wiki": 7 selected, 1 copied, 0 unchanged, 0 removed',
    );
  });

  it("aggregates the summary across vault and repo sources", () => {
    const report: SyncReport = {
      sources: [
        {
          kind: "vault",
          name: VAULT_NAME,
          candidates: 0,
          selected: 1,
          copied: ["a.md"],
          unchanged: [],
          removed: [],
        },
        {
          kind: "repo",
          name: "k-wiki",
          commit: "a1b2c3d4e5f6a7b8",
          candidates: 0,
          selected: 1,
          copied: ["src/a.ts"],
          unchanged: [],
          removed: [],
        },
      ],
      prunedNamespaces: [],
    };

    expect(formatReport(report).split("\n").at(-1)).toBe(
      "sync complete: 2 copied, 0 removed",
    );
  });
});

describe("formatReport all-blocked hint", () => {
  const allBlocked: VaultSyncReport = {
    kind: "vault",
    name: VAULT_NAME,
    candidates: 9,
    selected: 0,
    copied: [],
    unchanged: [],
    removed: [],
  };

  function reportOf(
    vault: VaultSyncReport,
    prunedNamespaces: readonly string[] = [],
  ): SyncReport {
    return { sources: [vault], prunedNamespaces };
  }

  it("appends the hint when every candidate is blocked", () => {
    expect(formatReport(reportOf(allBlocked)).split("\n")[0]).toBe(
      `vault "${VAULT_NAME}": 0 selected, 0 copied, 0 unchanged, 0 removed (9 candidates, all blocked)`,
    );
  });

  it("omits the hint when the vault has no candidates", () => {
    const report: VaultSyncReport = { ...allBlocked, candidates: 0 };

    expect(formatReport(reportOf(report)).split("\n")[0]).toBe(
      `vault "${VAULT_NAME}": 0 selected, 0 copied, 0 unchanged, 0 removed`,
    );
  });

  it("omits the hint when candidates were ingested", () => {
    const report: VaultSyncReport = {
      ...allBlocked,
      selected: 1,
      copied: ["a.md"],
    };

    expect(formatReport(reportOf(report)).split("\n")[0]).toBe(
      `vault "${VAULT_NAME}": 1 selected, 1 copied, 0 unchanged, 0 removed`,
    );
  });

  it("keeps the no-changes summary when nothing was pruned", () => {
    expect(formatReport(reportOf(allBlocked)).split("\n").at(-1)).toBe(
      "sync complete: no changes",
    );
  });

  it("appends the formatted duration to the summary", () => {
    const report: SyncReport = { ...reportOf(allBlocked), elapsedMs: 1200 };

    expect(formatReport(report).split("\n").at(-1)).toBe(
      "sync complete: no changes (1s)",
    );
  });

  it("appends a zero-second duration when the run is sub-second", () => {
    const report: SyncReport = { ...reportOf(allBlocked), elapsedMs: 100 };

    expect(formatReport(report).split("\n").at(-1)).toBe(
      "sync complete: no changes (0s)",
    );
  });
});

describe("pruneEmptyDirs", () => {
  it("removes the emptied directories below the stop root", async () => {
    const root = await mkdtemp(join(tmpdir(), "k-wiki-prune-"));
    tempDirs.push(root);
    const leaf = join(root, "notes", "Vault", "Sub", "Leaf.md");

    await mkdir(dirname(leaf), { recursive: true });
    await writeFile(leaf, "");
    await rm(leaf);

    await pruneEmptyDirs(dirname(leaf), join(root, "notes", "Vault"));

    expect(await pathExists(join(root, "notes", "Vault", "Sub"))).toBe(false);
  });

  it("keeps the stop root itself", async () => {
    const root = await mkdtemp(join(tmpdir(), "k-wiki-prune-"));
    tempDirs.push(root);
    const leaf = join(root, "notes", "Vault", "Sub", "Leaf.md");

    await mkdir(dirname(leaf), { recursive: true });
    await writeFile(leaf, "");
    await rm(leaf);

    await pruneEmptyDirs(dirname(leaf), join(root, "notes", "Vault"));

    expect(await pathExists(join(root, "notes", "Vault"))).toBe(true);
  });

  it("removes the empty directory it was pointed at", async () => {
    const root = await mkdtemp(join(tmpdir(), "k-wiki-prune-"));
    tempDirs.push(root);
    const kept = join(root, "ns", "Sub", "Kept");
    const pruned = join(root, "ns", "Sub", "Gone");

    await mkdir(kept, { recursive: true });
    await mkdir(pruned, { recursive: true });

    await pruneEmptyDirs(pruned, join(root, "ns"));

    expect(await pathExists(pruned)).toBe(false);
  });

  it("stops at a directory that still holds entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "k-wiki-prune-"));
    tempDirs.push(root);
    const shared = join(root, "ns", "Sub");
    const kept = join(root, "ns", "Sub", "Kept");
    const pruned = join(root, "ns", "Sub", "Gone");

    await mkdir(kept, { recursive: true });
    await mkdir(pruned, { recursive: true });

    await pruneEmptyDirs(pruned, join(root, "ns"));

    expect(await pathExists(shared)).toBe(true);
  });
});

describe("formatReport pruned namespaces", () => {
  const unchanged: VaultSyncReport = {
    kind: "vault",
    name: VAULT_NAME,
    candidates: 6,
    selected: 4,
    copied: [],
    unchanged: SELECTED_PATHS,
    removed: [],
  };

  it("lists each pruned namespace with a minus sign", () => {
    const report: SyncReport = {
      sources: [unchanged],
      prunedNamespaces: ["Retired"],
    };

    expect(formatReport(report)).toContain(
      "  - Retired/ (stale namespace, not configured)",
    );
  });

  it("counts a pruned namespace in the summary instead of reporting no changes", () => {
    const report: SyncReport = {
      sources: [unchanged],
      prunedNamespaces: ["Retired"],
    };

    expect(formatReport(report).split("\n").at(-1)).toBe(
      "sync complete: 0 copied, 0 removed, 1 namespace pruned",
    );
  });

  it("pluralizes the prune count for several namespaces", () => {
    const report: SyncReport = {
      sources: [],
      prunedNamespaces: ["Old", "Retired"],
    };

    expect(formatReport(report).split("\n").at(-1)).toBe(
      "sync complete: 0 copied, 0 removed, 2 namespaces pruned",
    );
  });
});

describe("formatDryRunReport", () => {
  it("renders the would-ingest list with a nothing-written summary", () => {
    expect(
      formatDryRunReport([
        { vault: VAULT_NAME, candidates: 9, wouldIngest: ["AI/RAG.md"] },
      ]),
    ).toBe(
      [
        `vault "${VAULT_NAME}": 1 of 9 candidates would be ingested`,
        "  + AI/RAG.md",
        "dry-run complete: nothing written",
      ].join("\n"),
    );
  });
});

describe("colorized output", () => {
  const pc = createColors(true);

  function reportOf(
    vault: Partial<VaultSyncReport> = {},
    prunedNamespaces: readonly string[] = [],
  ): SyncReport {
    return {
      sources: [
        {
          kind: "vault",
          name: VAULT_NAME,
          candidates: 0,
          selected: 0,
          copied: [],
          unchanged: [],
          removed: [],
          ...vault,
        },
      ],
      prunedNamespaces,
    };
  }

  it("colors copied paths green", () => {
    expect(formatReport(reportOf({ copied: ["AI/RAG.md"] }), pc)).toContain(
      `  + ${pc.green("AI/RAG.md")}`,
    );
  });

  it("colors removed paths red", () => {
    expect(formatReport(reportOf({ removed: ["AI/RAG.md"] }), pc)).toContain(
      `  - ${pc.red("AI/RAG.md")}`,
    );
  });

  it("colors vault names bold in report lines", () => {
    expect(formatReport(reportOf(), pc).split("\n")[0]).toBe(
      `vault ${pc.bold(`"${VAULT_NAME}"`)}: 0 selected, 0 copied, 0 unchanged, 0 removed`,
    );
  });

  it("dims the no-changes summary", () => {
    expect(formatReport(reportOf(), pc).split("\n").at(-1)).toBe(
      pc.dim("sync complete: no changes"),
    );
  });

  it("colors a copy-only summary green", () => {
    const report = reportOf({ copied: ["a.md", "b.md", "c.md", "d.md"] });

    expect(formatReport(report, pc).split("\n").at(-1)).toBe(
      pc.green("sync complete: 4 copied, 0 removed"),
    );
  });

  it("colors a summary with removals red", () => {
    const report = reportOf({ removed: ["a.md"] });

    expect(formatReport(report, pc).split("\n").at(-1)).toBe(
      pc.red("sync complete: 0 copied, 1 removed"),
    );
  });

  it("colors a prune-only summary red", () => {
    const report = reportOf({}, ["Retired"]);

    expect(formatReport(report, pc).split("\n").at(-1)).toBe(
      pc.red("sync complete: 0 copied, 0 removed, 1 namespace pruned"),
    );
  });

  it("colors pruned namespace lines red", () => {
    const report = reportOf({}, ["Retired"]);

    expect(formatReport(report, pc)).toContain(
      `  - ${pc.red("Retired/ (stale namespace, not configured)")}`,
    );
  });

  it("colors a pruned namespace summary red for several namespaces", () => {
    const report = reportOf({}, ["Old", "Retired"]);

    expect(formatReport(report, pc).split("\n").at(-1)).toBe(
      pc.red("sync complete: 0 copied, 0 removed, 2 namespaces pruned"),
    );
  });

  it("colors errors red", () => {
    expect(colorizeError("sync-vault: boom")).toBe(pc.red("sync-vault: boom"));
  });

  it("colors vault names bold in progress messages", () => {
    expect(colorizeProgress(`vault "${VAULT_NAME}": 6 candidates`)).toBe(
      `vault ${pc.bold(`"${VAULT_NAME}"`)}: 6 candidates`,
    );
  });

  it("colors a WARNING-severity progress message yellow", () => {
    expect(
      colorizeProgress("sync-vault: WARNING — config drift detected"),
    ).toBe(pc.yellow("sync-vault: WARNING — config drift detected"));
  });

  it("colors a WARNING message yellow even when it names a vault", () => {
    const message = `vault "${VAULT_NAME}": WARNING — drift detected`;

    expect(colorizeProgress(message)).toBe(pc.yellow(message));
  });

  it("leaves progress messages without a vault name plain", () => {
    expect(colorizeProgress("sync-vault: raw dir /tmp/raw")).toBe(
      "sync-vault: raw dir /tmp/raw",
    );
  });

  it("does not bold a vault name embedded mid-message", () => {
    expect(colorizeProgress('echo vault "X": done')).toBe(
      'echo vault "X": done',
    );
  });

  it("does not bold an undefined vault label embedded mid-message", () => {
    expect(colorizeProgress('echo vault "undefined": done')).toBe(
      'echo vault "undefined": done',
    );
  });

  it("colors a dry-run header bold and its paths green", () => {
    const reports: readonly VaultDryRunReport[] = [
      { vault: VAULT_NAME, candidates: 9, wouldIngest: ["AI/RAG.md"] },
    ];

    expect(formatDryRunReport(reports, pc)).toBe(
      [
        `vault ${pc.bold(`"${VAULT_NAME}"`)}: 1 of 9 candidates would be ingested`,
        `  + ${pc.green("AI/RAG.md")}`,
        "dry-run complete: nothing written",
      ].join("\n"),
    );
  });

  it("leaves the dry-run completion line plain", () => {
    const reports: readonly VaultDryRunReport[] = [
      { vault: VAULT_NAME, candidates: 0, wouldIngest: [] },
    ];

    expect(formatDryRunReport(reports, pc).split("\n").at(-1)).toBe(
      "dry-run complete: nothing written",
    );
  });

  it("appends the formatted duration to the dry-run summary", () => {
    const reports: readonly VaultDryRunReport[] = [
      { vault: VAULT_NAME, candidates: 9, wouldIngest: ["AI/RAG.md"] },
    ];

    expect(formatDryRunReport(reports, pc, 65000).split("\n").at(-1)).toBe(
      "dry-run complete: nothing written (1m05s)",
    );
  });

  it("colors a summary without a removed count green", () => {
    const report = reportOf({ copied: ["a.md"] });

    expect(formatReport(report, pc).split("\n").at(-1)).toBe(
      pc.green("sync complete: 1 copied, 0 removed"),
    );
  });

  it("colors a multi-digit-removal summary red", () => {
    const report = reportOf({
      removed: Array.from({ length: 10 }, (_, i) => `${i}.md`),
    });

    expect(formatReport(report, pc).split("\n").at(-1)).toBe(
      pc.red("sync complete: 0 copied, 10 removed"),
    );
  });

  describe("NO_COLOR", () => {
    const original = process.env.NO_COLOR;

    afterEach(() => {
      if (original === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = original;
      }
    });

    it("strips report color", () => {
      process.env.NO_COLOR = "1";

      expect(reportColors().green("AI/RAG.md")).toBe("AI/RAG.md");
    });

    it("strips progress color", () => {
      process.env.NO_COLOR = "1";

      expect(colorizeProgress(`vault "${VAULT_NAME}": 6 candidates`)).toBe(
        `vault "${VAULT_NAME}": 6 candidates`,
      );
    });

    it("strips WARNING color", () => {
      process.env.NO_COLOR = "1";

      expect(
        colorizeProgress("sync-vault: WARNING — config drift detected"),
      ).toBe("sync-vault: WARNING — config drift detected");
    });

    it("strips error color", () => {
      process.env.NO_COLOR = "1";

      expect(colorizeError("sync-vault: boom")).toBe("sync-vault: boom");
    });
  });
});
