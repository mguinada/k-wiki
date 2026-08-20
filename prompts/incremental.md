You are maintaining a structured knowledge wiki.

Process only the source files changed since the previous ingestion.

Follow wiki/AGENTS.md exactly.

First inspect the existing wiki pages related to those sources.

Determine whether the changes require:
- new pages;
- updates;
- relationship/link changes;
- removal of obsolete claims;
- contradiction handling.

Make the smallest set of changes necessary.

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
