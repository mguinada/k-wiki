import { tmpdir } from "node:os";
import { createColors } from "picocolors";
import { describe, expect, it, vi } from "vitest";
import {
  createAgentProgressSink,
  spawnAgent,
} from "../../src/ingest/agent-run.ts";

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

describe("createAgentProgressSink", () => {
  const tones = {
    dim: (text: string) => `<${text}>`,
    yellow: (text: string) => `[${text}]`,
  };
  const ingestPrefix = "wiki-ingest: agent still running";

  function makeSink(animated: boolean) {
    const written: string[] = [];
    const lines: string[] = [];
    const sink = createAgentProgressSink(
      (text) => written.push(text),
      (text) => lines.push(text),
      animated,
      tones,
      ingestPrefix,
    );

    return { sink, written, lines };
  }

  it("requires the heartbeat prefix argument", () => {
    // @ts-expect-error heartbeatPrefix has no consumer-specific default
    createAgentProgressSink(() => {}, () => {}, false, tones);
  });

  it("keeps the animated channel quiet when not animated", () => {
    const { sink, written } = makeSink(false);

    sink.render("wiki-ingest: agent finished");

    expect(written).toEqual([]);
  });

  it("appends plain lines when not animated", () => {
    const { sink, lines } = makeSink(false);

    sink.render("wiki-ingest: agent finished");

    expect(lines).toEqual(["<wiki-ingest: agent finished>"]);
  });

  it("renders a WARNING-severity message yellow, not dim, when not animated", () => {
    const { sink, lines } = makeSink(false);

    sink.render("wiki-ingest: WARNING — snapshot is foreign");

    expect(lines).toEqual(["[wiki-ingest: WARNING — snapshot is foreign]"]);
  });

  it("renders a WARNING-severity message yellow on the animated sink", () => {
    const { sink, written } = makeSink(true);

    sink.render("wiki-ingest: WARNING — snapshot is foreign");

    expect(written).toEqual(["[wiki-ingest: WARNING — snapshot is foreign]\n"]);
  });

  it("renders a WARNING-severity message plain under NO_COLOR", () => {
    const lines: string[] = [];
    const sink = createAgentProgressSink(
      () => {},
      (text) => lines.push(text),
      false,
      createColors(false),
      ingestPrefix,
    );

    sink.render("wiki-ingest: WARNING — snapshot is foreign");

    expect(lines).toEqual(["wiki-ingest: WARNING — snapshot is foreign"]);
  });

  it("keeps heartbeat messages on the animated line", () => {
    const { sink, written } = makeSink(true);

    sink.render("wiki-ingest: agent still running (2m07s)");

    expect(written).toEqual(["\r⠋ <wiki-ingest: agent still running (2m07s)>"]);
  });

  it("scrolls non-heartbeat messages as events on the animated sink", () => {
    const { sink, written } = makeSink(true);

    sink.render("wiki-ingest: agent finished");

    expect(written).toEqual(["<wiki-ingest: agent finished>\n"]);
  });

  it("clears the animated line on end", () => {
    const { sink, written } = makeSink(true);

    sink.render("wiki-ingest: agent still running (0s)");
    sink.end();

    expect(written[1]).toMatch(/^\r\s+\r$/);
  });

  it("does nothing on end when not animated", () => {
    const { sink, written } = makeSink(false);

    sink.end();

    expect(written).toEqual([]);
  });

  it("keeps the scroll lines empty on end when not animated", () => {
    const { sink, lines } = makeSink(false);

    sink.end();

    expect(lines).toEqual([]);
  });
});
