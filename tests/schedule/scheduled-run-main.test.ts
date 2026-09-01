import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../../src/schedule/scheduled-run.ts";

/**
 * main()'s config-path resolution with the config loader mocked: the
 * no-positional default must resolve to the repo's sync.json, a
 * config without dataRoot must fail loud with exit 1, and the
 * --outputs/--timeout value flags must parse as flags — not positionals.
 * The scheduled log is redirected to a temp file so no run ever
 * touches the real ~/Library/Logs.
 */

const { loadSyncConfig } = vi.hoisted(() => ({
  loadSyncConfig: vi.fn(),
}));

vi.mock("../../src/sync/config.ts", () => ({ loadSyncConfig }));

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

afterEach(() => {
  loadSyncConfig.mockReset();
});

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "k-wiki-sched-main-"));

  tempDirs.push(dir);

  return dir;
}

/** Run main() with argv stubbed, the log redirected, console captured. */
async function runMain(
  args: readonly string[],
): Promise<{ out: string; err: string; exitCode: string | undefined }> {
  const dir = await tempHome();
  const argv = process.argv;
  const logPath = process.env.KWIKI_SCHEDULED_LOG;
  const out: string[] = [];
  const err: string[] = [];

  process.argv = [...argv.slice(0, 2), ...args];
  process.env.KWIKI_SCHEDULED_LOG = join(dir, "run.log");
  process.exitCode = undefined;

  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...parts: unknown[]) => out.push(parts.join(" ")));
  const errorSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...parts: unknown[]) => err.push(parts.join(" ")));

  try {
    await main();
  } finally {
    process.argv = argv;

    if (logPath === undefined) {
      delete process.env.KWIKI_SCHEDULED_LOG;
    } else {
      process.env.KWIKI_SCHEDULED_LOG = logPath;
    }

    logSpy.mockRestore();
    errorSpy.mockRestore();
  }

  return {
    out: out.join("\n"),
    err: err.join("\n"),
    exitCode: process.exitCode,
  };
}

describe("scheduled-run main config resolution", () => {
  it("loads the repo's sync.json when no positional is given", async () => {
    const dir = await tempHome();

    loadSyncConfig.mockResolvedValue({ dataRoot: dir });

    await runMain([]);

    expect(loadSyncConfig.mock.calls[0]?.[0]).toMatch(/sync\.json$/);
  });

  it("runs its cycle against the loaded data root", async () => {
    const dir = await tempHome();

    loadSyncConfig.mockResolvedValue({ dataRoot: dir });

    const { exitCode, err } = await runMain([]);

    expect(`${exitCode}|${err}`).toMatch(/^1\|/);
  });

  it("exits 1 with a fail-loud message when the config has no dataRoot", async () => {
    await tempHome();

    loadSyncConfig.mockResolvedValue({});

    const { err, exitCode } = await runMain([]);

    expect(exitCode).toBe(1);
    expect(err).toContain("no dataRoot");
  });

  it("accepts --outputs and --timeout as value flags, not unknown options", async () => {
    const dir = await tempHome();

    loadSyncConfig.mockResolvedValue({ dataRoot: dir });

    const { err } = await runMain([
      "--outputs",
      join(dir, "outputs"),
      "--timeout",
      "5",
    ]);

    expect(err).not.toContain("unknown option");
  });
});
