import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  isAffordabilityError,
  runAgentTargets,
  spawnAgent,
} from "../../src/ingest/agent-run.ts";
import { codexRunner, runnerEnv } from "../../src/ingest/agent-runner.ts";

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

  it("survives a child that exits without consuming a large stdin prompt", async () => {
    let message = "";

    try {
      await spawnAgent(process.execPath, ["-e", "process.exit(3)"], {
        ...noOptions,
        stdin: "P".repeat(1024 * 1024),
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("agent exited with code 3");
  });

  it("keeps a stdout run's stdout when its argv carries a -o lookalike", async () => {
    const result = await spawnAgent(
      process.execPath,
      [
        "-e",
        "console.log('plain stdout')",
        "--",
        "-o",
        "/nonexistent-report-path",
      ],
      noOptions,
    );

    expect(result.stdout).toContain("plain stdout");
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

/** One codex-lane spawn against a stub that writes the -o report and
 *  exits: the managed home and report paths come back for assertion. */
async function runStubbedCodex(): Promise<{ home: string; report: string }> {
  const fixture = mkdtempSync(join(tmpdir(), "k-wiki-agent-run-"));
  const settings = {
    command: process.execPath,
    agent: "codex",
    model: "gpt-5.6-terra",
    reasoning: "high",
  } as const;
  const args = codexRunner.args(settings, "PROMPT", { root: fixture });
  const report = args[args.indexOf("-o") + 1];

  if (report === undefined) {
    throw new Error("codex argv carries no -o report path");
  }

  const env = runnerEnv(settings, {
    ...process.env,
    CODEX_HOME: join(fixture, "auth-home"),
    REPORT_PATH: report,
  });

  await spawnAgent(
    process.execPath,
    [
      "-e",
      'require("node:fs").writeFileSync(process.env.REPORT_PATH, "report")',
    ],
    {
      cwd: fixture,
      env,
      stdin: "PROMPT",
      reportPath: codexRunner.reportPath(args),
    },
  );

  return { home: env.CODEX_HOME ?? "", report };
}

describe("spawnAgent managed temp disposal", () => {
  it("removes the managed home once the run settles", async () => {
    const { home } = await runStubbedCodex();

    expect(existsSync(home)).toBe(false);
  });

  it("removes the report file once the report is read", async () => {
    const { report } = await runStubbedCodex();

    expect(existsSync(report)).toBe(false);
  });
});

describe("runAgentTargets launcher-provided agent path (issue #399)", () => {
  const settings = { command: "settings-pi", model: "M", reasoning: "low" };
  const baseOptions = {
    root: tmpdir(),
    timeoutMs: undefined,
    pre: { commit: "c", status: [], hashes: new Map(), contents: new Map() },
    onProgress: () => {},
  };

  it("spawns the launcher-provided absolute path instead of the bare settings command", async () => {
    const runAgent = vi.fn(
      async (_command: string, _args: readonly string[]) => ({
        stdout: "done",
        stderr: "",
      }),
    );

    await runAgentTargets(settings, "prompt", {
      ...baseOptions,
      environment: { KWIKI_AGENT_COMMAND: "/abs/resolved/pi" },
      runAgent,
    });

    expect(runAgent.mock.calls[0]?.[0]).toBe("/abs/resolved/pi");
  });

  it("keeps the settings command when the launcher provided no path", async () => {
    const runAgent = vi.fn(
      async (_command: string, _args: readonly string[]) => ({
        stdout: "done",
        stderr: "",
      }),
    );

    await runAgentTargets(settings, "prompt", {
      ...baseOptions,
      environment: {},
      runAgent,
    });

    expect(runAgent.mock.calls[0]?.[0]).toBe("settings-pi");
  });

  it("names the absolute path in the invoking-agent progress line", async () => {
    const lines: string[] = [];
    const runAgent = vi.fn(
      async (_command: string, _args: readonly string[]) => ({
        stdout: "done",
        stderr: "",
      }),
    );

    await runAgentTargets(settings, "prompt", {
      ...baseOptions,
      environment: { KWIKI_AGENT_COMMAND: "/abs/resolved/pi" },
      onProgress: (message: string) => lines.push(message),
      runAgent,
    });

    expect(lines.join("\n")).toContain(
      "invoking agent: /abs/resolved/pi --model M",
    );
  });
});

describe("isAffordabilityError", () => {
  it("matches the observed requires-more-credits rejection", () => {
    expect(
      isAffordabilityError(
        new Error(
          "agent pi exited with code 1: This request requires more credits … You requested up to 231240 tokens, but can only afford 82166",
        ),
      ),
    ).toBe(true);
  });

  it("matches an HTTP 402 rejection", () => {
    expect(
      isAffordabilityError(
        new Error("agent exited with code 1: 402 Payment Required"),
      ),
    ).toBe(true);
  });

  it("rejects an unrelated failure", () => {
    expect(
      isAffordabilityError(new Error("agent pi timed out after 1800 seconds")),
    ).toBe(false);
  });
});

describe("runAgentTargets onTargetFailure (issue #408)", () => {
  const settings = {
    command: "settings-pi",
    model: "M",
    reasoning: "low",
    targets: [
      { provider: "openrouter", model: "kimi" },
      { provider: "anthropic", model: "opus" },
    ],
  };
  const baseOptions = {
    root: tmpdir(),
    timeoutMs: undefined,
    pre: { commit: "c", status: [], hashes: new Map(), contents: new Map() },
    onProgress: () => {},
    environment: {},
  };

  it("reports each failed target attempt with its raw error and index before the fallback", async () => {
    const failures: unknown[] = [];
    const runAgent = vi.fn(async (_command, args) => {
      if (args.includes("kimi")) {
        throw new Error("This request requires more credits");
      }

      return { stdout: "done", stderr: "" };
    });

    const { mkdtemp } = await import("node:fs/promises");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const root = await mkdtemp(join(tmpdir(), "k-wiki-targets-"));

    await promisify(execFile)("git", ["init", "--quiet"], { cwd: root });

    await runAgentTargets(settings, "prompt", {
      ...baseOptions,
      root,
      runAgent,
      onTargetFailure: (target, error, index) => {
        failures.push([target, error, index]);
      },
    });

    expect(failures).toEqual([
      [
        { provider: "openrouter", model: "kimi" },
        new Error("This request requires more credits"),
        0,
      ],
    ]);
  });

  it("reports nothing when the first target succeeds", async () => {
    const failures: unknown[] = [];
    const runAgent = vi.fn(async () => ({ stdout: "done", stderr: "" }));

    await runAgentTargets(settings, "prompt", {
      ...baseOptions,
      runAgent,
      onTargetFailure: (target, error) => {
        failures.push([target, error]);
      },
    });

    expect(failures).toEqual([]);
  });
});
