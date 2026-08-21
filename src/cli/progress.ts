/**
 * Terminal progress presentation shared by the long-running CLIs:
 * plain events scroll up, one live status line (spinner frame +
 * sentence) is rewritten in place, and every write goes through an
 * injected sink so tests never need a TTY. Braille frames only; the
 * caller gates animation on `stderr.isTTY && !NO_COLOR`.
 */

/** Braille spinner frames, in animation order. */
export const SPINNER_FRAMES = [
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
