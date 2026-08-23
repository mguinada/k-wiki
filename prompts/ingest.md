You are maintaining a structured knowledge wiki.

Read the changed source files under raw/ and update wiki/ accordingly.

Follow wiki/AGENTS.md exactly.

Second brain: read `wiki/second-brain/profile.md` before processing
sources when it exists — it is your memory of the wiki's subject (a
person, a career, a venture). Create it on the first run when the
sources are one subject's own material (project notes, decisions,
attempts), and update it when sources reveal changes to goals,
projects, or preferences. File second-brain pages under
`wiki/second-brain/` with types `project`, `decision`, or `attempt`.

For each changed source:

1. Understand the complete source.
2. Identify concepts, entities, topics, comparisons, and relationships.
3. When two or more sources explicitly contrast named approaches, file a
   comparison page (or extend an existing one).
4. Inspect the existing wiki before creating pages.
5. Update existing pages when appropriate.
6. Create new pages only when justified.
7. Every page you create or rewrite must carry the required frontmatter
   fields (`title`, `type`, `created`, `updated`, `tags`) — including
   `index.md` and `overview.md`, which the skeleton ships bare; a run
   that writes either without frontmatter is auto-reverted.
8. Record `origin: raw/notes/<vault>/<path>` in the frontmatter of every
   source page you create, and add it to any source page you touch that
   lacks it.
9. Add source attribution to every affected page.
10. Add appropriate wikilinks.
11. Preserve contradictions and uncertainty.
12. Do not invent facts.
13. Update index.md.
14. Revise overview.md if the source changes the overall picture.
15. Revisit any `status: needs-review` pages that the new sources touch:
    corroborate → raise status and confidence; contradict → add or update
    a `CONTRADICTION` callout; unrelated → leave flagged.
16. Append a concise operation summary to log.md.

Do not modify raw/.
Do not modify the original source vault.
Do not rewrite unrelated wiki pages.

At the end, report:
- sources processed;
- pages created;
- pages updated;
- new load-bearing claims with no second source (claim + page + source);
- profile updates (second brains);
- contradictions detected;
- unresolved questions.
