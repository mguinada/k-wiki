# Guardrail checks

The read-only plumbing that audits a built wiki and its projection:
`check-raw` (projection coherence), `check-links` (wikilinks
resolve), `check-provenance` (sources entries live), `check-fidelity`
(quoted tokens trace to origins; titles match file names). The
ingest/cycle guardrails invoke them; operators run them standalone.

## Sub-features

- `check-raw-coherence`: every `raw/notes/<vault>/` file matches its
  manifest sha-256; no orphans, no missing entries; repo-sourced
  projections are freshness-checked (`--fail-on-stale`).
- `check-links-resolve`: every `[[wikilink]]` and heading anchor
  under `wiki/` resolves.
- `check-provenance-live`: every `sources` entry resolves (wikilink,
  anchored hub citation, or uncovered raw path).
- `check-fidelity-true`: every machine-checkable token a source page
  quotes appears in its `origin` file; titles kebab-case to file
  names.

## How to get to it (user POV)

- Run each `bin/check-*` with explicit directories — the defaults are
  the repo's skeleton trees, not the data repo: an operator passes
  `~/Lab/<data-repo>/wiki` (and `/raw`) explicitly.

## Driving it with the CLI harness

Preconditions:

- A built temp data repo: SKILL.md Drive steps 1–4 through one
  successful ingest (or cycle), so `$D/wiki` holds the stub's pages.

- **Healthy pass.** Run each in turn: `node bin/check-raw "$D/raw"`; `node bin/check-links "$D/wiki"`; `node bin/check-provenance "$D/wiki" "$D/raw"`; `node bin/check-fidelity "$D/wiki" "$D/raw"`. Each exits 0.
- **Broken link caught.** Append `see [[no-such-page]]` to `$D/wiki/concepts/stub.md`; run `node bin/check-links "$D/wiki"`. Exit 1 and one `file:line -> [[no-such-page]]` line on stdout; revert the edit.
- **Dead provenance caught.** Change the `origin:` path in `$D/wiki/sources/stub-source.md` to a nonexistent file; `check-provenance` and/or `check-fidelity` exit 1 naming the page; revert.
- **Raw incoherence caught.** Append a byte to a file under `$D/raw/notes/Documents/`; `node bin/check-raw "$D/raw"` exits 1 naming the mismatched file; revert (or re-run sync to re-project).
- **Proof.** Command lines, exit codes, and the problem lines each checker printed, into `$EV`.

## Gotchas

- All four are read-only — safe to run against any tree, including
  the repo's own skeleton (healthy-empty exit 0).
- Arguments are directories in the data repo, not the scratch
  workspace; passing `$S/raw` instead of `$D/raw` audits an unbuilt
  projection.
- Exit 1 output is the contract: one line per problem, repo-relative
  paths. Anything else on stdout in a failing run is a bug.
