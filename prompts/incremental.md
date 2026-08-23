You are maintaining a structured knowledge wiki.

Process only the source files changed since the previous ingestion.

Follow wiki/AGENTS.md exactly.

Second brain: when the data repo root holds the `.second-brain`
marker, this wiki is a second brain. Read
`wiki/second-brain/profile.md` before processing the changed
sources, and update it when they reveal changes to goals, projects,
or preferences. Without the marker this wiki is a domain wiki:
create no profile and no second-brain pages, and use no
`[[<vault>/<page>]]` cross-wiki links. The marker is operator-owned:
never create, edit, or remove it.

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
lacks it. When a note is renamed, update its raw path in the kept
source page's `origin` and in every `sources` entry that cites it.

Do not regenerate unrelated pages.
Do not modify raw/.
Do not modify the original source vault.

Update index.md, revise overview.md if the overall picture changed, and
append a concise entry to log.md.

Revisit any `status: needs-review` pages that the new sources touch:
corroborate → raise status and confidence; contradict → add or update a
`CONTRADICTION` callout; unrelated → leave flagged.

At the end, report:
- sources processed;
- pages created;
- pages updated;
- claims removed as superseded;
- new load-bearing claims with no second source (claim + page + source);
- contradictions detected;
- unresolved questions.
