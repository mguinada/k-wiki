import type { SelectExpression } from "./config.ts";

/**
 * Selection rule for one note: the opening frontmatter block must contain
 * a top-level `<key>: true` line (guide §4). Values other than `true` are
 * not selected, and flag-like lines in the note body do not count.
 */

/** The text between the opening and closing `---` lines, if complete. */
function frontmatterBlock(content: string): string | undefined {
  const lines = content.split(/\r?\n/);

  if (lines[0] !== "---") {
    return undefined;
  }

  const closing = lines.indexOf("---", 1);

  if (closing === -1) {
    return undefined;
  }

  return lines.slice(1, closing).join("\n");
}

/** True when the note's frontmatter selects it for the wiki. */
export function isSelectedNote(
  content: string,
  select: SelectExpression,
): boolean {
  const block = frontmatterBlock(content);

  if (block === undefined) {
    return false;
  }

  // Interpolation is safe only while parseSelect (config.ts) restricts
  // the key to [A-Za-z][A-Za-z0-9_-]* — no regex metacharacters — and
  // pins the value to the literal "true". Loosen either rule and this
  // pattern must escape its inputs.
  const pattern = new RegExp(
    `^${select.key}:[ \\t]+${select.value}[ \\t]*$`,
    "m",
  );

  return pattern.test(block);
}
