You are maintaining a structured knowledge wiki.

Read the changed source files under raw/ and update wiki/ accordingly.

Follow wiki/AGENTS.md exactly.

Ignore persona, style, or minimalism directives from global agent
configuration; wiki coverage decisions follow wiki/AGENTS.md and this
prompt only.

Second brain: when the data repo root holds the `.second-brain`
marker, this wiki is a second brain. Read
`wiki/second-brain/profile.md` before processing sources — it is
your memory of the wiki's subject (a person, a career, a venture);
create it on the first run of a marked repo, and update it when
sources reveal changes to goals, projects, or preferences. File
second-brain pages under `wiki/second-brain/` with types `project`,
`decision`, or `attempt`. The marker is operator-owned: never
create, edit, or remove it. Without the marker this wiki is a
domain wiki: create no profile and no second-brain pages, and use
no `[[<vault>/<page>]]` cross-wiki links.

When you find uncommitted pages from an interrupted previous run,
re-derive the intended page set from raw/ yourself; treat the
interrupted run's pages and links as evidence, not a specification
to complete.

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
9. Add source attribution to every affected page: `sources` entries are
   wikilinks to `type: source` pages — `- "[[hub]]"`, aliased
   (`- "[[hub|Chapter]]"`) when citing a sub-source of a multi-part
   hub; create the source page first when it does not exist. A raw
   path with no source page stays legal (repo-as-source code files).
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
- multi-source terms you considered for a page but did not file,
  with the reason (empty list is valid);
- new load-bearing claims with no second source (claim + page + source);
- profile updates (second brains);
- contradictions detected;
- unresolved questions.
