import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { spawnAgent } from "../../src/ingest/agent-run.ts";

describe("spawnAgent", () => {
  const noOptions = { cwd: tmpdir(), env: process.env };

  it("resolves the captured stdout of a successful child", async () => {
    const result = await spawnAgent(
      process.execPath,
      ["-e", "console.log('agent says hi')"],
      noOptions,
    );

    expect(result.stdout).toContain("agent says hi");
  });

  it("rejects naming the exit code of a failing child", async () => {
    await expect(
      spawnAgent(process.execPath, ["-e", "process.exit(7)"], noOptions),
    ).rejects.toThrow("exited with code 7");
  });

  it("rejects when the command cannot start", async () => {
    await expect(
      spawnAgent("no-such-agent-command", [], noOptions),
    ).rejects.toThrow("could not start");
  });

  it("captures stderr of a successful child", async () => {
    const result = await spawnAgent(
      process.execPath,
      ["-e", "console.error('noise')"],
      noOptions,
    );

    expect(result.stderr).toContain("noise");
  });

  it("drops the head of a long agent stderr, keeping the end", async () => {
    const filler = "y".repeat(1200);
    let message = "";

    try {
      await spawnAgent(
        process.execPath,
        [
          "-e",
          `console.error("HEAD-MARK ${filler} END-MARK"); process.exit(5)`,
        ],
        noOptions,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe(
      `agent exited with code 5: ${"y".repeat(490)} END-MARK`,
    );
  });

  it("kills and fails an agent that exceeds its timeout", async () => {
    let message = "";

    try {
      await spawnAgent(
        process.execPath,
        ["-e", "setTimeout(() => {}, 30000)"],
        {
          ...noOptions,
          timeoutMs: 150,
        },
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/^agent .* timed out after 1 second$/);
  });

  it("reports a multi-second timeout in plural", async () => {
    let message = "";

    try {
      await spawnAgent(
        process.execPath,
        ["-e", "setTimeout(() => {}, 30000)"],
        {
          ...noOptions,
          timeoutMs: 1500,
        },
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/^agent .* timed out after 2 seconds$/);
  });

  it("kills and fails an agent that floods past the output cap", async () => {
    await expect(
      spawnAgent(
        process.execPath,
        ["-e", "process.stdout.write('z'.repeat(17 * 1024 * 1024))"],
        noOptions,
      ),
    ).rejects.toThrow("killed with SIGKILL");
  });

  it("collects output exactly at the cap without killing", async () => {
    const result = await spawnAgent(
      process.execPath,
      ["-e", "process.stdout.write('z'.repeat(16 * 1024 * 1024))"],
      noOptions,
    );

    expect(result.stdout).toHaveLength(16 * 1024 * 1024);
  });

  it("closes the agent stdin instead of leaving an open pipe", async () => {
    const result = await spawnAgent(
      process.execPath,
      [
        "-e",
        "process.stdin.resume(); process.stdin.on('end', () => console.log('stdin-eof')); process.stdin.on('data', () => {});",
      ],
      noOptions,
    );

    expect(result.stdout).toContain("stdin-eof");
  });

  it("clears the run timeout once the child settles", async () => {
    vi.useFakeTimers();

    try {
      await spawnAgent(process.execPath, ["-e", ""], noOptions);

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the run timeout when the child fails to start", async () => {
    vi.useFakeTimers();

    try {
      await spawnAgent("no-such-agent-command", [], noOptions).catch(
        () => undefined,
      );

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
