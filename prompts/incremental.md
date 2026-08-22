You are maintaining a structured knowledge wiki.

Process only the source files changed since the previous ingestion.

Follow wiki/AGENTS.md exactly.

First inspect the existing wiki pages related to those sources.

Determine whether the changes require:
- new pages;
- updates;
- relationship/link changes;
- removal of obsolete claims;
- contradiction handling;
- retitles (a renamed note keeps its source page and citations).

When two or more sources explicitly contrast named approaches, file a
comparison page (or extend an existing one).

Make the smallest set of changes necessary.

Record `origin: raw/notes/<vault>/<path>` in the frontmatter of every
source page you create, and add it to any source page you touch that
lacks it.

Do not regenerate unrelated pages.
Do not modify raw/.
Do not modify the original source vault.

Update index.md, revise overview.md if the overall picture changed, and
append a concise entry to log.md.

At the end, report:
- sources processed;
- pages created;
- pages updated;
- claims removed as superseded;
- contradictions detected;
- unresolved questions.
