/** The value-taking flags in `flags`, each with its value and the
 *  argument indexes it consumed (a missing final value surfaces as
 *  undefined and fails validation). Shared by the wiki-ingest and
 *  wiki-sync CLIs. */
export function readFlagValues(
  flags: readonly string[],
  args: readonly string[],
): {
  values: Map<string, string | undefined>;
  consumed: Set<number>;
} {
  const values = new Map<string, string | undefined>();
  const consumed = new Set<number>();

  for (const flag of flags) {
    const index = args.indexOf(flag);

    if (index !== -1) {
      values.set(flag, args[index + 1]);
      consumed.add(index);
      consumed.add(index + 1);
    }
  }

  return { values, consumed };
}

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
