import { flagValueError } from "./flag-args.ts";

/**
 * The shared CLI shell (issue #254): one argv parser every CLI
 * consumes, replacing the ~10 hand-rolled parsers it collapsed. The
 * rules are the ones the surviving CLIs already shared — value flags
 * consume the next argument or an inline `--flag=value`, unknown
 * options are rejected with the flag named, positionals collect under
 * a per-CLI count rule — so the
 * unknown-arg policy is one policy, not one per CLI (finding D-11).
 * Help stays with each CLI's main: the shell parses, never prints.
 */

/** What one CLI accepts: its value flags, boolean flags, and the
 *  positional count rule with its overflow message. */
export interface CliSpec {
  /** Value-taking flags (`--settings <path>`); each consumes the next
   *  argument as its value, or takes it inline (`--settings=path`).
   *  A missing final value stays undefined — validation catches it.
   *  A repeated flag's last value wins. */
  readonly value?: readonly string[];
  /** Boolean flags, present or absent. */
  readonly boolean?: readonly string[];
  /** Reject positionals beyond `max`, reporting them through
   *  `error` with the offending argument and the actual count. */
  readonly positionals?: {
    readonly max: number;
    readonly error: (arg: string, count: number) => string;
  };
}

/** One parsed command line: flag values, boolean flags, positionals,
 *  and the first usage error (undefined when argv is valid). */
export interface ParsedCli {
  readonly values: ReadonlyMap<string, string | undefined>;
  readonly flags: ReadonlySet<string>;
  readonly positional: readonly string[];
  readonly error: string | undefined;
}

/** The usage error for a positional beyond the spec's maximum,
 *  undefined while the count stays within it. */
function positionalOverflowError(
  spec: CliSpec,
  arg: string,
  count: number,
): string | undefined {
  const rule = spec.positionals;

  if (rule === undefined || count <= rule.max) {
    return undefined;
  }

  return rule.error(arg, count);
}

/** The inline `--flag=value` form of a value flag, as the
 *  [flag, value] pair to record, undefined when `arg` is not one. */
function inlineValue(
  arg: string,
  valueFlags: ReadonlySet<string>,
): readonly [string, string] | undefined {
  const equals = arg.indexOf("=");

  if (
    arg.startsWith("-") &&
    equals !== -1 &&
    valueFlags.has(arg.slice(0, equals))
  ) {
    return [arg.slice(0, equals), arg.slice(equals + 1)];
  }

  return undefined;
}

/** Split argv per the spec: value flags, boolean flags, positionals.
 *  The first usage error — an unknown option, or a positional beyond
 *  the maximum — stops the parse and is the result's `error`. An
 *  absent array entry reads as no argument. */
export function parseArgs(
  args: readonly (string | undefined)[],
  spec: CliSpec = {},
): ParsedCli {
  const valueFlags = new Set(spec.value ?? []);
  const booleanFlags = new Set(spec.boolean ?? []);
  const values = new Map<string, string | undefined>();
  const flags = new Set<string>();
  const positional: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    if (arg === undefined) {
      continue;
    }

    if (booleanFlags.has(arg)) {
      flags.add(arg);

      continue;
    }

    if (valueFlags.has(arg)) {
      values.set(arg, args[index + 1]);
      index++;

      continue;
    }

    const inline = inlineValue(arg, valueFlags);

    if (inline !== undefined) {
      values.set(inline[0], inline[1]);

      continue;
    }

    if (arg.startsWith("-")) {
      return {
        values,
        flags,
        positional,
        error: `unknown option ${JSON.stringify(arg)}`,
      };
    }

    positional.push(arg);

    const overflow = positionalOverflowError(spec, arg, positional.length);

    if (overflow !== undefined) {
      return { values, flags, positional, error: overflow };
    }
  }

  return { values, flags, positional, error: undefined };
}

/** The agent-run flag set — `--settings`, `--outputs`, `--timeout` —
 *  as one parsed-and-validated result object, derived once at the
 *  CLI boundary (finding RF-2): consuming CLIs read these fields,
 *  never the raw flag map. Validation is `flagValueError`'s, so the
 *  error strings stay byte-identical to the ones tests pin across
 *  CLIs; sibling path flags (such as `--raw-dir`) validate with it
 *  too. */
export interface AgentRunFlags {
  readonly settings: string | undefined;
  readonly outputs: string | undefined;
  readonly timeoutMs: number | undefined;
  /** The first flag-set usage error, undefined when valid. */
  readonly error: string | undefined;
}

/** Derive the agent-run flag set from parsed values, validating them
 *  once: paths present, `--timeout` a positive integer in seconds. */
export function agentRunFlags(
  values: ReadonlyMap<string, string | undefined>,
): AgentRunFlags {
  const error = flagValueError(values);

  if (error !== undefined) {
    return {
      settings: undefined,
      outputs: undefined,
      timeoutMs: undefined,
      error,
    };
  }

  const timeout = values.get("--timeout");

  return {
    settings: values.get("--settings"),
    outputs: values.get("--outputs"),
    timeoutMs: timeout === undefined ? undefined : Number(timeout) * 1000,
    error: undefined,
  };
}

/** Parse the argv shape wiki-sync and scheduled-run share: the
 *  agent-run flag set plus at most the `<config>` and `<raw-dir>`
 *  positionals (the wrapper forwards everything verbatim, so the two
 *  CLIs must accept exactly the same command line). */
export function parseSyncRunArgs(args: readonly string[]): ParsedCli {
  return parseArgs(args, {
    value: ["--settings", "--outputs", "--timeout"],
    positionals: {
      max: 2,
      error: (_arg, count) =>
        `expected at most two arguments (<config> and <raw-dir>), got ${count}`,
    },
  });
}
