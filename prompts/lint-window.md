Audit the wiki pages listed at the end of this message for quality
problems.

This is a windowed audit: the listed pages — those changed since the
last audit plus the pages that link to them — are the audit's scope.
Work only on them; do not rewrite pages outside the window; pages
outside the window keep their last audited state until a full sweep.

The deterministic worklists embedded below are candidates with
evidence, not verdicts: judge each one; the scan is already done.

Check the listed pages for:

1. Unsupported claims.
2. Missing source attribution.
3. Contradictory claims (between listed pages, and between a listed
   page and anything it cites).
4. Duplicate pages (see the duplicate-title candidates).
5. Orphan pages (see the orphan candidates).
6. Missing or invalid Obsidian frontmatter (see the field misses).
7. Non-canonical or inconsistent wiki tags (see the tag inventory).
8. Stale or obsolete claims.
9. Incorrect page types.
10. Missing important relationships between listed pages.
11. Index entries for the listed pages (see the index misses and the
    dangling index entries).
12. Wiki pages that contain excessive filler.
13. Single-source pages (see the list; judge each against the
    corroboration lifecycle).
14. `sources` entries that point at non-source pages (see the edges)
    — each is an error.
15. Pages that should carry `status: needs-review` under the
    corroboration lifecycle but do not.

Do not make speculative corrections.
Never modify wiki/AGENTS.md.

Fix clear mechanical problems automatically.
Report ambiguous problems instead of guessing.

Save the report to `outputs/lint-<YYYY-MM-DD>.md`.

Prepend significant findings to `log.md`: insert each entry as the
new topmost entry — below the `# Wiki Log` header and any standing
comment — leaving the older entries untouched.
