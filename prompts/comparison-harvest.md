One-shot harvest of comparison pages (trial, k-wiki#66).

Scan every wiki source page (wiki/sources/) and concept page
(wiki/concepts/) for explicit contrasts between **named approaches**
where both sides are grounded in cited sources.

Follow wiki/AGENTS.md exactly.

The bar is conservative. A comparison page is warranted only when
**two or more sources explicitly contrast the named approaches**: a
source names approach X, names approach Y, and sets them against each
other in its own text. Implicit tension between sources is
contradiction material, not a comparison page. Never invent a contrast
the sources do not make.

For every qualifying contrast:

1. Create or extend a page under wiki/comparisons/ (naming: `x-vs-y.md`).
2. Use the wiki/AGENTS.md frontmatter: type `comparison`, `sources`
   listing every cited source path, canonical tags, required fields.
3. Ground every row of the comparison in cited source text; keep every
   claim traceable to a source.
4. Preserve disagreements about which side wins as CONTRADICTION
   callouts; do not resolve them.
5. Link to at least two related pages.
6. Extend an existing comparison page instead of creating a
   near-duplicate; do not duplicate a contrast already carried by a
   concept page unless it earns its own page under the rule above.

Update index.md.
Revise overview.md only if the harvest changes the overall picture.
Append `## [YYYY-MM-DD] harvest | Comparison harvest (trial)` to log.md.

Do not modify raw/.
Do not modify the original source vault.
Do not modify wiki/AGENTS.md.
Do not rewrite unrelated wiki pages.

Save the report to `outputs/comparison-harvest-<YYYY-MM-DD>.md` and
end with:
- every comparison created or extended, with the two or more sources
  that explicitly contrast and the sentence in each that does the
  contrasting;
- candidates considered and rejected, with the reason (no explicit
  contrast, one-sided, tension-not-contrast);
- the check-links result (run `npm run check-links -- <wiki-dir>` from
  the code-repo checkout).
