import { describe, expect, it } from "vitest";
import { assertNoBlockingChanges } from "../../src/sync/committed-tree.ts";

/**
 * committed-tree guard unit tests (issues #74, #312): which
 * working-tree states block a SHA-grounded repo projection, pinned
 * against the exact porcelain lines git emits. Tracked changes
 * always block; untracked entries block only when the include
 * allowlist could select them. Real-git behavior — the dirty-source
 * refusal, untracked-scratch tolerance, and untracked-selectable
 * refusal through the actual CLI — is covered by the sync-repo e2e
 * suite.
 */

const ROOT = "/source";

/** The meta instance's allowlist (sync-meta.json): literal root
 *  files, one-level wildcards, and a `**` under a literal root. */
const META_ALLOWLIST = [
  "README.md",
  "AGENTS.md",
  "wiki/AGENTS.md",
  "package.json",
  "docs/*.md",
  "prompts/*.md",
  "src/**/*.ts",
];

function guard(porcelain: string, include: readonly string[] = META_ALLOWLIST) {
  return () => assertNoBlockingChanges(porcelain, ROOT, include);
}

describe("assertNoBlockingChanges untracked tolerance (issue #312)", () => {
  it("passes a clean porcelain", () => {
    expect(guard("")()).toBeUndefined();
  });

  it("passes untracked root-level scratch the allowlist cannot select", () => {
    expect(guard("?? eli5-report.html\n")()).toBeUndefined();
  });

  it("passes an untracked collapsed directory no pattern can reach", () => {
    expect(guard("?? managed_context/\n")()).toBeUndefined();
  });

  it("refuses an untracked file the allowlist can select, naming it", () => {
    expect(guard("?? docs/x.md\n")).toThrow(
      /untracked-selectable: docs\/x\.md/,
    );
  });

  it("refuses an untracked collapsed directory a pattern descends into", () => {
    expect(guard("?? src/newmod/\n")).toThrow(
      /untracked-selectable: src\/newmod/,
    );
  });

  it("refuses any untracked entry when a pattern has no literal root", () => {
    expect(guard("?? eli5-report.html\n", ["README.md", "**/*.md"])).toThrow(
      /uncommitted changes/,
    );
  });

  it("refuses a tracked modification, naming the file", () => {
    expect(guard(" M README.md\n")).toThrow(/tracked: README\.md/);
  });

  it("refuses a staged rename as a tracked change", () => {
    expect(guard("R  docs/a.md -> docs/b.md\n")).toThrow(
      /tracked: docs\/a\.md -> docs\/b\.md/,
    );
  });

  it("names tracked and untracked-selectable paths in one refusal", () => {
    expect(guard(" M README.md\n?? docs/x.md\n")).toThrow(
      /tracked: README\.md; untracked-selectable: docs\/x\.md/,
    );
  });

  it("strips git's quoting from a selectable untracked path", () => {
    expect(guard('?? "docs/note file.md"\n')).toThrow(
      /untracked-selectable: docs\/note file\.md/,
    );
  });

  it("passes untracked node_modules at the walk root", () => {
    expect(
      guard("?? node_modules/\n", ["README.md", "*.ts"])(),
    ).toBeUndefined();
  });

  it("refuses an untracked skipped-root dir an exact-file pattern names", () => {
    expect(
      guard("?? node_modules/\n", ["README.md", "node_modules/pkg/README.md"]),
    ).toThrow(/untracked-selectable: node_modules/);
  });

  it("refuses an untracked skipped-root dir a walk-root pattern covers", () => {
    expect(
      guard("?? node_modules/\n", ["README.md", "node_modules/**/*.md"]),
    ).toThrow(/untracked-selectable: node_modules/);
  });

  it("refuses an untracked file named node_modules a wildcard selects", () => {
    expect(guard("?? node_modules\n", ["**"])).toThrow(
      /untracked-selectable: node_modules/,
    );
  });

  it("caps the blocking paths listed in the failure message", () => {
    const porcelain = Array.from(
      { length: 7 },
      (_, index) => `?? docs/u${index}.md\n`,
    ).join("");

    expect(guard(porcelain)).toThrow(/\+2 more/);
  });
});
