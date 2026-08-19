import type { ExcludeExpression } from "./config.ts";

/**
 * Selection rule for one note (issue #32): a note is blocked only when
 * its opening frontmatter block contains a top-level `<key>: false`
 * line. Everything else — including notes without frontmatter — is
 * selected; flag-like lines in the note body never block.
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

/** True when the note's frontmatter does not block it from the wiki. */
export function isSelectedNote(
  content: string,
  exclude: ExcludeExpression,
): boolean {
  const block = frontmatterBlock(content);

  if (block === undefined) {
    return true;
  }

  // Interpolation is safe only while parseExclude (config.ts) restricts
  // the key to [A-Za-z][A-Za-z0-9_-]* — no regex metacharacters — and
  // pins the value to the literal "false". Quoted values ("false",
  // 'false') match because the Obsidian web clipper writes Text
  // properties quoted.
  const pattern = new RegExp(
    `^${exclude.key}:[ \\t]*["']?${exclude.value}["']?[ \\t]*$`,
    "m",
  );

  return !pattern.test(block);
}
