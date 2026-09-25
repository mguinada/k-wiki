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
    const bullet = help.slice(
      help.indexOf("Shared-writer mode:"),
      help.indexOf("- No origin:"),
    );

    expect(bullet).not.toContain("pull --rebase");
  });
});
