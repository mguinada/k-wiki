You are maintaining a structured knowledge wiki.

One or more synced source notes were deleted from the vault. Expunge
their influence: no claim, concept, entity, comparison, or filed query
may rest on material whose only support was a removed note, directly or
indirectly.

Follow wiki/AGENTS.md exactly, including its Expungement section.

The changed-source list below may also carry added, edited, or renamed
sources (`+`, `~`, `→`). When it does, the incremental prompt is
appended below: ingest those sources in the same run, exactly as an
incremental run would.

The removed notes, their last synced content, and the deterministic
direct set of affected pages are appended below. The direct set is a
lower bound, not a boundary: also search the wiki full text for the
removed notes' distinctive terms, and follow `related` links and body
wikilinks in reverse from every affected page.

For every affected page, re-derive it from its remaining sources — do
not surgically delete content:
- claims supported only by a removed note die;
- independently supported claims survive;
- confidence drops where support thinned;
- a CONTRADICTION callout that lost one side is dissolved, not preserved;
- a page left without sources, or demoted to a stub, is deleted;
- a filed query under queries/ that cites a removed note is expunged the
  same way — the queries layer is preserved, its citing pages are not.

Repair links to deleted pages, update index.md, revise overview.md, and
append one entry to log.md in the format
`## [YYYY-MM-DD] expunge | <title>`.

Threshold escape hatch: when the affected set exceeds roughly one third
of the wiki, stop the surgical pass and execute the rebuild procedure
from the contract instead (restore queries/ from git afterwards, then
expunge it). Report the threshold decision either way.

No tombstone pages: the wiki reflects the current raw/ only; the
retraction record lives in log.md and git history.

Do not modify raw/.
Do not modify the original source vault.
Do not rewrite pages outside the affected set and the pages of the
added, edited, or renamed sources.

At the end, report:
- claims removed as unsourced;
- pages deleted;
- pages updated;
- contradictions dissolved;
- queries expunged;
- the threshold decision (surgical pass or full rebuild). When you
  executed a full rebuild, include exactly this line:
  **Threshold exceeded — full rebuild executed; expect a large diff covering the whole wiki.**
