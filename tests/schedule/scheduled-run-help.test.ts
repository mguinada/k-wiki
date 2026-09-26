import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

let help: string;

beforeAll(() => {
  help = execFileSync(
    process.execPath,
    [join(repoRoot, "bin", "scheduled-run"), "--help"],
    { encoding: "utf8" },
  );
});

/** The help slice between two required anchors; a renamed or
 *  reordered anchor fails loud instead of yielding an empty slice. */
function betweenAnchors(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end);

  if (from === -1 || to === -1 || to < from) {
    throw new Error(
      `help anchors missing or unordered: ${JSON.stringify(start)}, ${JSON.stringify(end)}`,
    );
  }

  return text.slice(from, to);
}

describe("scheduled-run help (printed by the launcher)", () => {
  it("documents the shared-writer delegation", () => {
    expect(help).toContain("shared-writer");
  });

  it("documents the shared-writer no-push rule", () => {
    expect(help).toContain("no pull, no push");
  });

  it("documents that a scheduled run can never confirm removals", () => {
    expect(help).toContain("--removal-receipt");
  });

  it("documents that a scheduled run never expunges", () => {
    expect(help).toContain("never expunges");
  });

  it("keeps the local push-rejection retry documentation", () => {
    expect(help).toContain("gets one pull --rebase + retry");
  });

  it("documents the conflicted-rebase recovery of the without-marker path", () => {
    expect(help).toContain(
      "the next tick aborts it (git rebase --abort before",
    );
  });

  it("documents the log-path override", () => {
    expect(help).toContain("KWIKI_SCHEDULED_LOG overrides");
  });

  it("claims no pull --rebase recovery in the shared-writer bullet", () => {
    const bullet = betweenAnchors(help, "Shared-writer mode:", "- No origin:");

    expect(bullet).not.toContain("pull --rebase");
  });

  it("documents the bounded auto-recovery of a recorded fix surface", () => {
    const bullet = betweenAnchors(
      help,
      "Shared-writer failure recovery",
      "- No origin:",
    );

    expect(bullet).toContain("three consecutive refused ticks");
  });

  it("documents the permanent abort of auto-recovery on a mismatch", () => {
    const bullet = betweenAnchors(
      help,
      "Shared-writer failure recovery",
      "- No origin:",
    );

    expect(bullet).toContain("aborts auto-recovery permanently");
  });

  it("documents the recover-fix-surface verb as the immediate path", () => {
    const bullet = betweenAnchors(
      help,
      "Shared-writer failure recovery",
      "- No origin:",
    );

    expect(bullet).toContain("recover-fix-surface");
  });
});
