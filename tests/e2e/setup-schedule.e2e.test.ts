import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { pathExists } from "../../src/cli/shared.ts";
import { repoRoot, runCli } from "./helpers.ts";

/**
 * setup-schedule e2e: the plist emitters as real child processes.
 * Only `--print` runs for the happy path — install and uninstall
 * touch the operator's launchd state and stay unit-tested against
 * an injected launcher and a temp home. The interval plist pins the
 * registration the schedule has always had; the calendar plist
 * (issue #359) pins the weekly full-lint sweep's label, trigger,
 * and --lint-full argument. The origin-guard runs (issue #361)
 * reproduce the incident as real child processes: a runnable repo
 * copy under a .stryker-tmp path and a real linked worktree both
 * refuse, writing nothing into the temp HOME.
 */

const run = promisify(execFile);

const SETUP_SCRIPT = `${repoRoot}/bin/setup-schedule`;

describe("setup-schedule e2e", () => {
  it("prints the interval plist with the label and the node invocation", async () => {
    const result = await runCli(SETUP_SCRIPT, ["--print"]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("com.kwiki.scheduled-run");
    expect(result.out).toContain("<key>StartInterval</key>");
    expect(result.out).toContain("<integer>1800</integer>");
    expect(result.out).not.toContain("--lint-full");
    expect(result.err).toBe("");
  });

  it("prints the weekly sweep plist with a calendar trigger and --lint-full", async () => {
    const result = await runCli(SETUP_SCRIPT, ["--calendar", "--print"]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("com.kwiki.scheduled-lint");
    expect(result.out).toContain("<key>StartCalendarInterval</key>");
    expect(result.out).toContain("<integer>0</integer>");
    expect(result.out).toContain("<integer>3</integer>");
    expect(result.out).toContain("<string>--lint-full</string>");
    expect(result.err).toBe("");
  });

  it("honors --weekly-at in the calendar plist", async () => {
    const result = await runCli(SETUP_SCRIPT, [
      "--calendar",
      "--weekly-at",
      "sat-04:30",
      "--print",
    ]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("<integer>6</integer>");
    expect(result.out).toContain("<integer>4</integer>");
    expect(result.out).toContain("<integer>30</integer>");
  });

  it("rejects --weekly-at without --calendar", async () => {
    const result = await runCli(SETUP_SCRIPT, ["--weekly-at", "sun-03:00"]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("--weekly-at needs --calendar");
  });

  it("refuses install from a .stryker-tmp sandbox copy: exit 1, the refusal, nothing written", async () => {
    const scratch = join(repoRoot, ".e2e-tmp", `stryker-${Date.now()}`);
    const sandbox = join(scratch, ".stryker-tmp", "sandbox-e2e");
    const home = await mkdtemp(join(tmpdir(), "k-wiki-e2e-sandbox-home-"));

    try {
      // The incident's shape: a runnable repo copy living under a
      // .stryker-tmp path, node_modules shared by symlink.
      await mkdir(scratch, { recursive: true });
      await cp(join(repoRoot, "src"), join(sandbox, "src"), {
        recursive: true,
      });
      await cp(join(repoRoot, "bin"), join(sandbox, "bin"), {
        recursive: true,
      });
      await cp(join(repoRoot, "package.json"), join(sandbox, "package.json"));
      await run("ln", [
        "-s",
        join(repoRoot, "node_modules"),
        join(sandbox, "node_modules"),
      ]);

      const result = await runCli(join(sandbox, "bin", "setup-schedule"), [], {
        env: { HOME: home },
      });

      expect(result.code).toBe(1);
      expect(result.err).toContain("Stryker sandbox");
      expect(result.err).toContain("k-wiki setup-schedule");
      expect(await pathExists(join(home, "Library"))).toBe(false);
    } finally {
      await rm(scratch, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("refuses install from a real linked worktree the same way", async () => {
    const branch = `e2e/origin-guard-${Date.now()}`;
    const worktree = join(repoRoot, ".e2e-tmp", `worktree-${Date.now()}`);
    const home = await mkdtemp(join(tmpdir(), "k-wiki-e2e-worktree-home-"));

    try {
      await run("git", ["worktree", "add", worktree, "-b", branch, "HEAD"]);

      // The worktree checks out HEAD — the committed tree, which may
      // not carry this change yet. Overlay the working src/ and bin/
      // so the child runs the code under test; the git-dir topology
      // (what the guard probes) is the worktree's own.
      await cp(join(repoRoot, "src"), join(worktree, "src"), {
        recursive: true,
      });
      await cp(join(repoRoot, "bin"), join(worktree, "bin"), {
        recursive: true,
      });

      const result = await runCli(join(worktree, "bin", "setup-schedule"), [], {
        env: { HOME: home },
      });

      expect(result.code).toBe(1);
      expect(result.err).toContain("linked worktree");
      expect(result.err).toContain("k-wiki setup-schedule");
      expect(await pathExists(join(home, "Library"))).toBe(false);
    } finally {
      await run("git", ["worktree", "remove", "--force", worktree]).catch(
        () => undefined,
      );
      await run("git", ["branch", "-D", branch]).catch(() => undefined);
      await rm(home, { recursive: true, force: true });
    }
  });
});
