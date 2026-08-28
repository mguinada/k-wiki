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

/** The first usage error among the CLI flag values, or undefined
 *  when they are valid: every path flag needs a value (`--timeout`
 *  excepted), optional `--sources` values must all be present, and
 *  `--timeout` a positive integer number of seconds. Shared by the
 *  wiki-ingest, wiki-query, and wiki-sync CLIs — keep the error
 *  strings byte-identical; tests pin them. */
export function flagValueError(
  values: Map<string, string | undefined>,
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
