/**
 * The wiki log writer (guide §12): wiki/log.md's audit trail is
 * prepend-only — every meaningful run inserts its entry directly
 * under the log's standing preamble, so the log reads newest-first
 * down to oldest. One canonical writer for every caller (queries,
 * promotion, the migration scripts, the sandbox epilogue, the
 * inverter); pure string surgery, no I/O — the callers own when and
 * where the bytes land.
 */

/** Prepend one audit entry to wiki/log.md content: the entry lands
 *  directly above the first existing entry — under the `# Wiki Log`
 *  header when one stands there, after frontmatter and standing
 *  comments when the log opens with them (never above frontmatter).
 *  The header is created only when the log is absent; the entries
 *  below stay untouched, and a blank line separates the new entry
 *  from what follows (guide §12). */
export function prependWikiLog(prior: string, entry: string): string {
  const trimmed = entry.replace(/\n+$/, "");
  const firstEntry = /^## \[/m.exec(prior);

  if (firstEntry !== null) {
    const rest = prior.slice(firstEntry.index);

    return `${prior.slice(0, firstEntry.index)}${trimmed}\n\n${rest.endsWith("\n") ? rest : `${rest}\n`}`;
  }

  if (prior === "") {
    return `# Wiki Log\n\n${trimmed}\n`;
  }

  const normalized = prior.endsWith("\n") ? prior : `${prior}\n`;
  const headerEnd = normalized.indexOf("# Wiki Log\n");

  if (headerEnd === -1) {
    return `# Wiki Log\n\n${trimmed}\n\n${normalized}`;
  }

  const split = headerEnd + "# Wiki Log\n".length;

  return `${normalized.slice(0, split)}\n${trimmed}\n${normalized.slice(split)}`;
}
