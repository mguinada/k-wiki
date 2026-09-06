/**
 * The sandbox stamp surface (issue #336): the deterministic epilogue
 * values written into `wiki/sandbox/` pages after a gated agent run —
 * `via: agent` (authorship: the pipeline wrote it, the caller cannot
 * forge it) and `expires:` (the date-level TTL stamp, 7-day floor,
 * decision 8) — plus the `wiki/log.md` audit entry every sandbox
 * commit appends. Pure string surgery, no I/O: the epilogue in
 * sandbox-run.ts owns when and where these land. The `via:`/`expires:`
 * key semantics are documented here (landed docs, the implementation
 * guide's sandbox section), not in `wiki/AGENTS.md`: the wiki
 * contract governs the reviewed wiki surface, while these keys are a
 * pipeline-mechanical surface the reaper (issue #338) and the citation
 * wall's standing lint (issue #339) read.
 */

/** The sandbox namespace's directory name inside the wiki tree:
 *  the root every walker excludes (issue #338) and the reaper
 *  sweeps. */
export const SANDBOX_ROOT = "sandbox";

/** The sandbox namespace inside the data repo's wiki tree. */
export const SANDBOX_DIR = `wiki/${SANDBOX_ROOT}`;

/** The TTL floor (decision 8): a sandbox note expires at least this
 *  many whole days after its run — same-day reaping kills active
 *  notes, so the floor is enforced at stamp time. */
export const SANDBOX_TTL_DAYS = 7;

/** The run's `via:` stamp value: the epilogue writes it, the caller
 *  cannot. */
export const SANDBOX_VIA = "agent";

/** The expiry date stamp: 7 whole days out, date-level (the wiki's
 *  `YYYY-MM-DD` convention). Always computed from the run's clock —
 *  never accepted from input — so the floor cannot be dodged. */
export function expiresOn(now: () => Date): string {
  return new Date(now().getTime() + SANDBOX_TTL_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** True for a frontmatter line the epilogue owns: a top-level `via:`
 *  or `expires:` key. Indented lines are list or nested content, not
 *  stamps. */
function isStampLine(line: string): boolean {
  return /^(via|expires):/.test(line);
}

/** Stamp one sandbox page's text deterministically: any caller-supplied
 *  `via:`/`expires:` lines are removed wherever they sit in the
 *  frontmatter block (stamp authority — the epilogue overwrites, edge
 *  4), and the pipeline's stamps are appended as the block's last
 *  keys. A page without a complete frontmatter block gets one. */
export function stampSandboxPage(text: string, expires: string): string {
  const lines = text.split(/\r?\n/);
  const stamps = [`via: ${SANDBOX_VIA}`, `expires: ${expires}`];
  const closing = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  const stamped =
    closing === -1
      ? ["---", ...stamps, "---", "", ...lines]
      : [
          ...lines.slice(0, 1),
          ...lines.slice(1, closing).filter((line) => !isStampLine(line)),
          ...stamps,
          ...lines.slice(closing),
        ];

  return stamped.join("\n");
}

/** The `wiki/log.md` audit entry one sandbox commit appends: the
 *  contract's parseable header (`## [YYYY-MM-DD] sandbox | <slug>`)
 *  plus a body naming the committed pages and the expiry the reaper
 *  will act on. */
export function sandboxLogEntry(input: {
  readonly date: string;
  readonly slug: string;
  readonly expires: string;
  readonly pages: readonly string[];
}): string {
  return [
    `## [${input.date}] sandbox | ${input.slug}`,
    "",
    `Agent sandbox run committed ${input.pages.join(", ")}; expires ${input.expires}.`,
    "",
  ].join("\n");
}

/** The repo-relative target path of one run's sandbox note: the slug
 *  is the note's identity, so it derives the path and nothing else
 *  may. */
export function sandboxNotePath(slug: string): string {
  return `${SANDBOX_DIR}/${slug}.md`;
}
