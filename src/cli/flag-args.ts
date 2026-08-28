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

  const timeoutArg = values.get("--timeout");

  if (
    values.has("--timeout") &&
    (timeoutArg === undefined || !/^[1-9][0-9]*$/.test(timeoutArg))
  ) {
    return "--timeout needs a positive integer number of seconds";
  }

  return undefined;
}
