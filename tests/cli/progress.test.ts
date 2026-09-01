import { createColors } from "picocolors";
import { describe, expect, it, vi } from "vitest";
import {
  createAgentProgressSink,
  createProgressRenderer,
  createStatusLine,
  formatDuration,
  stderrSink,
} from "../../src/cli/progress.ts";

describe("formatDuration", () => {
  it("formats zero as 0s", () => {
    expect(formatDuration(0)).toBe("0s");
  });

  it("formats sub-minute durations in seconds", () => {
    expect(formatDuration(47_000)).toBe("47s");
  });

  it("formats minutes with zero-padded seconds", () => {
    expect(formatDuration(127_000)).toBe("2m07s");
  });

  it("switches to minute format exactly at sixty seconds", () => {
    expect(formatDuration(60_000)).toBe("1m00s");
  });

  it("keeps second format one tick below sixty seconds", () => {
    expect(formatDuration(59_999)).toBe("59s");
  });

  it("formats whole minutes without seconds noise", () => {
    expect(formatDuration(120_000)).toBe("2m00s");
  });

  it("formats hours with padded minutes and seconds", () => {
    expect(formatDuration(3_723_000)).toBe("1h02m03s");
  });
});

describe("createStatusLine", () => {
  it("writes the first frame and text on the first update", () => {
    const written: string[] = [];
    const line = createStatusLine((text) => written.push(text));

    line.update("agent still running (2m07s)");

    expect(written).toEqual(["\r⠋ agent still running (2m07s)"]);
  });

  it("advances the frame on a later update", async () => {
    const written: string[] = [];
    const line = createStatusLine((text) => written.push(text), 5);

    line.update("one");
    await new Promise((resolve) => setTimeout(resolve, 20));
    line.update("two");

    expect(written[1]).toMatch(/^\r⠙ two$/);
  });

  it("throttles updates inside one frame interval to one write", () => {
    const written: string[] = [];
    const line = createStatusLine((text) => written.push(text), 60_000);

    line.update("one");
    line.update("two");

    expect(written).toEqual(["\r⠋ one"]);
  });

  it("renders again exactly one frame interval after the last write", () => {
    vi.useFakeTimers();

    try {
      const written: string[] = [];
      const line = createStatusLine((text) => written.push(text), 1000);

      line.update("one");
      vi.setSystemTime(Date.now() + 1000);
      line.update("two");

      expect(written).toEqual(["\r⠋ one", "\r⠙ two"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pads a shorter update over the remains of a longer one", async () => {
    const written: string[] = [];
    const line = createStatusLine((text) => written.push(text), 5);

    line.update("a very long status sentence");
    await new Promise((resolve) => setTimeout(resolve, 20));
    line.update("short");

    expect(written[1]).toBe(
      "\r⠙ short".padEnd("\r⠋ a very long status sentence".length),
    );
  });

  it("clears the line back to the left margin on stop", async () => {
    const written: string[] = [];
    const line = createStatusLine((text) => written.push(text), 5);

    line.update("status text");
    line.stop();

    expect(written[1]).toBe(`\r${" ".repeat("⠋ status text".length)}\r`);
  });

  it("makes stop a no-op when nothing was written", () => {
    const written: string[] = [];
    const line = createStatusLine((text) => written.push(text));

    line.stop();

    expect(written).toEqual([]);
  });

  it("restarts cleanly after a stop", () => {
    const written: string[] = [];
    const line = createStatusLine((text) => written.push(text), 60_000);

    line.update("first");
    line.stop();
    line.update("second");

    expect(written[2]).toBe("\r⠋ second");
  });
});

describe("createProgressRenderer", () => {
  it("writes events as whole lines", () => {
    const written: string[] = [];
    const renderer = createProgressRenderer((text) => written.push(text));

    renderer.event("wiki-ingest: raw dir /tmp/raw");

    expect(written).toEqual(["wiki-ingest: raw dir /tmp/raw\n"]);
  });

  it("clears a live line before an event lands under it", async () => {
    const written: string[] = [];
    const renderer = createProgressRenderer((text) => written.push(text), 5);

    renderer.live("running (1s)");
    renderer.event("agent finished");

    expect(written[0]).toBe("\r⠋ running (1s)");
  });

  it("clears the live line when an event lands", async () => {
    const written: string[] = [];
    const renderer = createProgressRenderer((text) => written.push(text), 5);

    renderer.live("running (1s)");
    renderer.event("agent finished");

    expect(written[1]).toMatch(/^\r\s+\r$/);
  });

  it("prints the event after clearing the live line", async () => {
    const written: string[] = [];
    const renderer = createProgressRenderer((text) => written.push(text), 5);

    renderer.live("running (1s)");
    renderer.event("agent finished");

    expect(written[2]).toBe("agent finished\n");
  });

  it("routes consecutive live messages onto one line", async () => {
    const written: string[] = [];
    const renderer = createProgressRenderer((text) => written.push(text), 5);

    renderer.live("running (1s)");
    await new Promise((resolve) => setTimeout(resolve, 20));
    renderer.live("running (2s)");

    expect(written).toHaveLength(2);
  });

  it("redraws the live line with the newest frame", async () => {
    const written: string[] = [];
    const renderer = createProgressRenderer((text) => written.push(text), 5);

    renderer.live("running (1s)");
    await new Promise((resolve) => setTimeout(resolve, 20));
    renderer.live("running (2s)");

    expect(written[1]).toMatch(/^\r⠙ running \(2s\)$/);
  });

  it("end clears a live line without printing anything", () => {
    const written: string[] = [];
    const renderer = createProgressRenderer((text) => written.push(text));

    renderer.live("running (1s)");
    renderer.end();

    expect(written[1]).toMatch(/^\r\s+\r$/);
  });

  it("end is a no-op with no live line", () => {
    const written: string[] = [];
    const renderer = createProgressRenderer((text) => written.push(text));

    renderer.end();

    expect(written).toEqual([]);
  });

  it("live messages after an event animate again from a cleared line", () => {
    const written: string[] = [];
    const renderer = createProgressRenderer((text) => written.push(text));

    renderer.live("running (1s)");
    renderer.event("phase two");
    renderer.live("running (2s)");

    expect(written).toEqual([
      "\r⠋ running (1s)",
      expect.stringMatching(/^\r\s+\r$/),
      "phase two\n",
      "\r⠋ running (2s)",
    ]);
  });

  it("does not write the console at construction", () => {
    const write = vi.fn();
    const renderer = createProgressRenderer(write);

    expect(renderer).toBeDefined();
  });

  it("leaves the console untouched at construction", () => {
    const write = vi.fn();
    createProgressRenderer(write);

    expect(write).not.toHaveBeenCalled();
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
    createAgentProgressSink(
      () => {},
      () => {},
      false,
      tones,
    );
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

describe("stderrSink", () => {
  /** Force `process.stderr.isTTY`; returns the restore function. */
  function forceTty(tty: boolean): () => void {
    const priorValue = process.stderr.isTTY;

    Object.defineProperty(process.stderr, "isTTY", {
      value: tty,
      configurable: true,
    });

    return () =>
      Object.defineProperty(process.stderr, "isTTY", {
        value: priorValue,
        configurable: true,
      });
  }

  it("builds a plain-line sink when stderr is not a TTY", () => {
    const restore = forceTty(false);
    const lines: string[] = [];
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((text) => lines.push(String(text)));

    try {
      const { sink, animated } = stderrSink("pfx:");

      sink.render("pfx: agent still running (0s)");

      expect(animated).toBe(false);
      expect(lines[0]).toContain("pfx: agent still running (0s)");
      expect(lines[0]).not.toContain("\r");
    } finally {
      errorSpy.mockRestore();
      restore();
    }
  });

  it("builds an animated sink when stderr is a TTY with color on", () => {
    const restore = forceTty(true);
    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((text) => {
        writes.push(String(text));

        return true;
      });
    const priorNoColor = process.env.NO_COLOR;

    delete process.env.NO_COLOR;

    try {
      const { sink, animated } = stderrSink("pfx:");

      sink.render("pfx: agent still running (0s)");

      expect(animated).toBe(true);
      expect(writes[0]?.startsWith("\r⠋")).toBe(true);
      expect(writes[0]).toContain("pfx: agent still running (0s)");
    } finally {
      writeSpy.mockRestore();
      restore();

      if (priorNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = priorNoColor;
      }
    }
  });

  it("builds a plain non-animated sink under NO_COLOR", () => {
    const restore = forceTty(true);
    const lines: string[] = [];
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((text) => lines.push(String(text)));
    const priorNoColor = process.env.NO_COLOR;

    process.env.NO_COLOR = "1";

    try {
      const { sink, animated } = stderrSink("pfx:");

      sink.render("pfx: agent still running (0s)");

      expect(animated).toBe(false);
      expect(lines).toEqual(["pfx: agent still running (0s)"]);
    } finally {
      errorSpy.mockRestore();
      restore();

      if (priorNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = priorNoColor;
      }
    }
  });
});
