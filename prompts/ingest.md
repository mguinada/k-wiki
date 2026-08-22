You are maintaining a structured knowledge wiki.

Read the changed source files under raw/ and update wiki/ accordingly.

Follow wiki/AGENTS.md exactly.

For each changed source:

1. Understand the complete source.
2. Identify concepts, entities, topics, comparisons, and relationships.
3. When two or more sources explicitly contrast named approaches, file a
   comparison page (or extend an existing one).
4. Inspect the existing wiki before creating pages.
5. Update existing pages when appropriate.
6. Create new pages only when justified.
7. Record `origin: raw/notes/<vault>/<path>` in the frontmatter of every
   source page you create, and add it to any source page you touch that
   lacks it.
8. Add source attribution to every affected page.
9. Add appropriate wikilinks.
10. Preserve contradictions and uncertainty.
11. Do not invent facts.
12. Update index.md.
13. Revise overview.md if the source changes the overall picture.
14. Append a concise operation summary to log.md.

Do not modify raw/.
Do not modify the original source vault.
Do not rewrite unrelated wiki pages.

At the end, report:
- sources processed;
- pages created;
- pages updated;
- contradictions detected;
- unresolved questions.
