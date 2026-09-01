/**
 * Terminal progress presentation shared by the long-running CLIs:
 * plain events scroll up, one live status line (spinner frame +
 * sentence) is rewritten in place, and every write goes through an
 * injected sink so tests never need a TTY. Braille frames only; the
 * caller gates animation on `stderr.isTTY && !NO_COLOR`.
 */

/** Braille spinner frames, in animation order. */
const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Elapsed milliseconds as `47s`, `2m07s`, or `1h02m03s`. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h${pad2(minutes)}m${pad2(seconds)}s`;
  }

  return `${minutes}m${pad2(seconds)}s`;
}

export interface StatusLine {
  /** Show `text` on the live line; writes are throttled per frame. */
  update(text: string): void;
  /** Erase the live line and return to the left margin; idempotent. */
  stop(): void;
}

/**
 * One `\r`-rewritten line. Only the padding discipline keeps the
 * display clean: each render pads to the longest line drawn so far,
 * and stop blanks exactly that width.
 */
export function createStatusLine(
  write: (text: string) => void,
  frameMs = 100,
): StatusLine {
  let frame = 0;
  let width = 0;
  let lastWrite = 0;
  let active = false;

  return {
    update(text: string) {
      const now = Date.now();

      if (active && now - lastWrite < frameMs) {
        return;
      }

      lastWrite = now;
      active = true;

      const line = `${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} ${text}`;

      write(`\r${line.padEnd(width)}`);
      width = Math.max(width, line.length);
      frame++;
    },
    stop() {
      if (!active) {
        return;
      }

      write(`\r${" ".repeat(width)}\r`);
      active = false;
      width = 0;
      frame = 0;
    },
  };
}

export interface ProgressRenderer {
  /** A scrolling event line; clears the live line first. */
  event(message: string): void;
  /** A live status sentence; shown on the animated line. */
  live(message: string): void;
  /** Clear the live line; call before stdout output or an error. */
  end(): void;
}

/** Events scroll; live sentences share one animated line. */
export function createProgressRenderer(
  write: (text: string) => void,
  frameMs?: number,
): ProgressRenderer {
  let line: StatusLine | null = null;

  return {
    event(message: string) {
      line?.stop();
      line = null;
      write(`${message}\n`);
    },
    live(message: string) {
      line ??= createStatusLine(write, frameMs);
      line.update(message);
    },
    end() {
      line?.stop();
      line = null;
    },
  };
}

/** The CLI color policy's warning severity: a progress message
 *  carrying the WARNING tag renders yellow at the render boundary
 *  (docs/references/colors.md). */
export function isWarning(message: string): boolean {
  return message.includes("WARNING");
}

/** Interval for the progress-sink liveness line while the agent
 *  runs; the wording is each consumer's heartbeat prefix. */
export const HEARTBEAT_MS = 60_000;

/** A stderr progress surface: plain lines, or one animated line. */
export interface ProgressSink {
  render(message: string): void;
  end(): void;
}

export interface ProgressTones {
  /** Routine progress lines. */
  readonly dim: (text: string) => string;
  /** WARNING-severity lines. */
  readonly yellow: (text: string) => string;
}

/**
 * The stderr presentation for one agent-driven run: agent heartbeats
 * keep one animated line (spinner + clock) on a TTY; every other
 * message scrolls. Non-animated runs append plain lines only.
 * Severity is detected here, at the render boundary: WARNING messages
 * render yellow, everything else dim.
 */
export function createAgentProgressSink(
  write: (text: string) => void,
  writeLine: (text: string) => void,
  animated: boolean,
  tones: ProgressTones,
  heartbeatPrefix: string | readonly string[],
): ProgressSink {
  const prefixes =
    typeof heartbeatPrefix === "string" ? [heartbeatPrefix] : heartbeatPrefix;
  const styled = (message: string) =>
    isWarning(message) ? tones.yellow(message) : tones.dim(message);

  if (!animated) {
    return {
      render: (message) => writeLine(styled(message)),
      end: () => {},
    };
  }

  const renderer = createProgressRenderer(write);

  return {
    render: (message) => {
      if (prefixes.some((prefix) => message.startsWith(prefix))) {
        renderer.live(styled(message));
      } else {
        renderer.event(styled(message));
      }
    },
    end: () => renderer.end(),
  };
}
