Audit the wiki for quality problems.

Check for:

1. Unsupported claims.
2. Missing source attribution.
3. Contradictory claims.
4. Duplicate pages.
5. Orphan pages.
6. Broken wikilinks.
7. Missing or invalid Obsidian frontmatter.
8. Missing required frontmatter fields.
9. Non-canonical or inconsistent wiki tags.
10. Stale or obsolete claims.
11. Incorrect page types.
12. Missing important relationships.
13. Index entries missing from the wiki.
14. Wiki pages that contain excessive filler.
15. Missing comparison where sources explicitly contrast named approaches
    (report, do not auto-create).
16. Single-source pages: list every page whose `sources` has exactly one entry.
17. `sources` entries that point at non-source pages (type other than `source`)
    — each is an error.
18. Pages that should carry `status: needs-review` under the corroboration
    lifecycle but do not.
19. Cross-wiki links: a slashed `[[<vault>/<page>]]` target no available
    domain wiki has, or any cross-wiki link inside a domain wiki.
20. Unfiled multi-source concepts: for each concept named substantively
    in two or more source pages but having no concept/comparison page,
    report it (term + source pages). Report only — never auto-create.
21. Citation fidelity: for every source page, re-verify its relational
    statements against the page's `origin` file under `raw/` — which
    file, container, flag, or command owns which behavior. A token can
    exist in the origin while the containment is wrong. Fix clear
    misquotes; report ambiguous ones instead of guessing.

Do not make speculative corrections.
Never modify wiki/AGENTS.md.

Fix clear mechanical problems automatically.
Report ambiguous problems instead of guessing.

Save the report to `outputs/lint-<YYYY-MM-DD>.md`.

Append significant findings to log.md.
