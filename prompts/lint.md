Audit the wiki for quality problems.

This is a full audit: every page, every check — including the global
report-only checks at the end of the list. The deterministic
worklists embedded below are candidates with evidence, not verdicts:
judge each one; the scan is already done.

Check for:

1. Unsupported claims.
2. Missing source attribution.
3. Contradictory claims.
4. Duplicate pages.
5. Orphan pages.
6. Missing or invalid Obsidian frontmatter.
7. Missing required frontmatter fields.
8. Non-canonical or inconsistent wiki tags.
9. Stale or obsolete claims.
10. Incorrect page types.
11. Missing important relationships.
12. Index entries missing from the wiki.
13. Wiki pages that contain excessive filler.
14. Single-source pages: list every page whose `sources` has exactly
    one entry.
15. `sources` entries that point at non-source pages (type other than
    `source`) — each is an error.
16. Pages that should carry `status: needs-review` under the
    corroboration lifecycle but do not.
17. Missing comparison where sources explicitly contrast named
    approaches (report, do not auto-create).
18. Unfiled multi-source concepts: for each concept named
    substantively in two or more source pages but having no
    concept/comparison page, report it (term + source pages). Report
    only — never auto-create.

Do not make speculative corrections.
Never modify wiki/AGENTS.md.

Fix clear mechanical problems automatically.
Report ambiguous problems instead of guessing.

Save the report to `outputs/lint-<YYYY-MM-DD>-full.md`.

Prepend significant findings to `log.md`: insert each entry as the
new topmost entry — below the `# Wiki Log` header and any standing
comment — leaving the older entries untouched.
