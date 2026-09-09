/**
 * Shared flag-argument helpers: the byte-identical usage-error and
 * value-reading rules every CLI applies to the common flags —
 * timeout, date, int flags, the value-flag bundle, and the k-wiki
 * dispatcher's raw-argv value reads — so no CLI drifts from the
 * shell's contract. Pure validators; the shell (cli/shell.ts) owns
 * argv scanning.
 */

/** Usage error for an invalid `--timeout` value, undefined when it
 *  is valid. `undefined` counts as invalid: the caller must only
 *  invoke this for a `--timeout` that was actually passed (keep the
 *  error string byte-identical; tests pin it across CLIs). */
export function timeoutArgError(
  timeout: string | undefined,
): string | undefined {
  if (timeout === undefined || !/^[1-9][0-9]*$/.test(timeout)) {
    return "--timeout needs a positive integer number of seconds";
  }

  return undefined;
}

/** The `--date` flag's value (today when the flag is absent,
 *  undefined when it ends argv), plus the argument indexes it
 *  consumed so the value is never read as a positional. Shared by
 *  the migration scripts. */
export function readDateFlag(args: readonly string[]): {
  date: string | undefined;
  consumed: ReadonlySet<number>;
} {
  const dateIndex = args.indexOf("--date");

  return {
    date:
      dateIndex === -1
        ? new Date().toISOString().slice(0, 10)
        : args[dateIndex + 1],
    consumed: new Set<number>(
      dateIndex === -1 ? [] : [dateIndex, dateIndex + 1],
    ),
  };
}

/** Whether a `--date` value is calendar-shaped (YYYY-MM-DD). */
export function isIsoDate(value: string | undefined): value is string {
  return value !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** The value of one flag among raw args: the two-token form
 *  (`--checkout <path>`, `-w <name>`) or the inline long form
 *  (`--flag=value`). Scans left to right, stops at a bare `--`,
 *  matches whole tokens only — a positional containing the flag
 *  text never matches, and a repeated occurrence overrides — the
 *  parseArgs rule (a repeated flag's last value wins), so every
 *  flag the k-wiki dispatcher reads names the value the run
 *  resolves. Undefined when absent. */
export function lastFlagValueFrom(
  args: readonly string[],
  tokens: ReadonlySet<string>,
  inlinePrefix: string,
): string | undefined {
  let value: string | undefined;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";

    if (arg === "--") {
      return value;
    }

    if (tokens.has(arg)) {
      value = args[index + 1];
    } else if (arg.startsWith(inlinePrefix)) {
      value = arg.slice(inlinePrefix.length);
    }
  }

  return value;
}

/** Usage error for an int-valued flag, undefined when it is valid.
 *  `undefined` counts as invalid: the caller must only invoke this
 *  for a flag that was actually passed. Shared by the mutation
 *  CLIs' --index/--total/--expect validation — keep the error string
 *  byte-identical; tests pin it across those CLIs. */
export function intFlagError(
  flag: string,
  value: string | undefined,
): string | undefined {
  if (value === undefined || !Number.isInteger(Number(value))) {
    return `${flag} requires an integer value`;
  }

  return undefined;
}

/** The first usage error among the CLI flag values, or undefined
 *  when they are valid: every path flag needs a value (`--timeout`
 *  excepted), optional `--sources` values must all be present, and
 *  `--timeout` a positive integer number of seconds. Shared by the
 *  wiki-ingest, wiki-query, and wiki-sync CLIs — keep the error
 *  strings byte-identical; tests pin them. */
export function flagValueError(
  values: ReadonlyMap<string, string | undefined>,
  sourcesRaw?: readonly (string | undefined)[],
): string | undefined {
  for (const [flag, value] of values) {
    if (flag === "--timeout") {
      continue;
    }

    if (value === undefined) {
      return `${flag} needs a path value`;
    }
  }

  if (sourcesRaw?.some((value) => value === undefined)) {
    return "--sources needs a path value";
  }

  if (values.has("--timeout")) {
    return timeoutArgError(values.get("--timeout"));
  }

  return undefined;
}
