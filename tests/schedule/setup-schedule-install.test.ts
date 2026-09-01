import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LAUNCHD_LABEL, main } from "../../src/schedule/setup-schedule.ts";

/**
 * The install path over a mocked launchctl: the plist lands in the
 * temp home's LaunchAgents dir with mode 0644, --print emits no
 * trailing blank line, and a failing launchctl invocation fails loud
 * with the command named. main()'s home is ALWAYS a temp dir — the
 * real ~/Library/LaunchAgents must never be touched.
 */

const execFile = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();

  return { ...actual, execFile };
});

const tempDirs: string[] = [];

/** launchctl succeeding: resolve whatever callback position promisify used. */
function succeedLaunchctl(...callArgs: unknown[]): undefined {
  const callback = callArgs[callArgs.length - 1] as (
    error: Error | null,
    result?: { stdout: string },
  ) => void;

  callback(null, { stdout: "" });

  return undefined;
}

beforeEach(() => {
  execFile.mockReset();
  execFile.mockImplementation(succeedLaunchctl);
  process.exitCode = undefined;
});

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "k-wiki-setup-install-"));

  tempDirs.push(dir);

  return dir;
}

/** Run main() with argv stubbed, a temp home, console captured. */
async function runMain(
  args: readonly string[],
  platform: NodeJS.Platform = "darwin",
  home: string = "",
): Promise<{ out: string; err: string; exitCode: string | undefined }> {
  const argv = process.argv;
  const out: string[] = [];
  const err: string[] = [];
  const runHome = home === "" ? await tempHome() : home;

  process.argv = [...argv.slice(0, 2), ...args];
  process.exitCode = undefined;

  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...parts: unknown[]) => out.push(parts.join(" ")));
  const errorSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...parts: unknown[]) => err.push(parts.join(" ")));

  try {
    await main(args, platform, undefined, runHome);
  } finally {
    process.argv = argv;
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }

  return {
    out: out.join("\n"),
    err: err.join("\n"),
    exitCode: process.exitCode,
  };
}

describe("setup-schedule install", () => {
  it("writes the plist with mode 0644", async () => {
    const home = await tempHome();

    await runMain([], "darwin", home);

    const info = await stat(
      join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
    );

    expect(info.mode & 0o777).toBe(0o644);
  });

  it("prints no trailing blank line for --print", async () => {
    const { out } = await runMain(["--print"], "linux");

    expect(out.endsWith("</plist>")).toBe(true);
  });

  it("fails loud, naming the launchctl command, when loading fails", async () => {
    const home = await tempHome();

    execFile.mockImplementation((...callArgs: unknown[]) => {
      const args = callArgs[1] as readonly string[];
      const callback = callArgs[callArgs.length - 1] as (
        error: Error | null,
        result?: { stdout: string },
      ) => void;

      if (args[0] === "bootstrap") {
        callback(new Error("Bootstrap failed: 5"));

        return undefined;
      }

      callback(null, { stdout: "" });

      return undefined;
    });

    const failure = runMain([], "darwin", home);

    await expect(failure).rejects.toThrow("launchctl bootstrap");
    await expect(failure).rejects.toThrow("failed — Bootstrap failed: 5");
  });

  it("reads back the installed plist", async () => {
    const home = await tempHome();

    await runMain([], "darwin", home);

    const plist = await readFile(
      join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
      "utf8",
    );

    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
  });
});
