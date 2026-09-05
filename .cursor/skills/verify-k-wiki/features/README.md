# k-wiki verification map

This directory is the maintained source for verifying the user-facing
behavior of the k-wiki pipeline CLIs. Read the index before driving,
then use the matching feature file as the recipe. Setup, isolation,
and evidence conventions live in [`../SKILL.md`](../SKILL.md) — this
map only covers features.

## Baseline preconditions

- Checkout prepared per SKILL.md Launch (`npm install`, doctor exit 0).
- A scratch workspace `$S` with fixture vault and temp `sync.json`
  (SKILL.md Drive step 1) — no `dataRoot` in the config; the explicit
  `<raw-dir>` argument is the isolation.
- LLM-path features additionally need the temp data repo `$D` with
  `settings.yml` naming the stub agent (Drive step 3).
- Never run a `bin/` CLI bare: bare defaults are the user's real vault
  and real data repo.

## Driving conventions

- Treat commands as literal; keep flags and quoted paths unchanged.
- Capture command + exit code + written files + (where relevant)
  `git -C "$D" log` — a bare exit 0 is not a proof.
- Re-run read-only guardrails (`bin/check-*`) as separate commands to
  verify side effects.
- The stub agent is the only mock; it sits on the production
  `settings.yml` `command:` boundary.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph, then
exactly four H2 sections in this order: `Sub-features`, `How to get
to it (user POV)`, `Driving it with the CLI harness` (starting with
`Preconditions:`), and `Gotchas`.

## Index

| Feature | File | Surface |
|---|---|---|
| Vault sync (vault → `raw/`) | [vault-sync.md](vault-sync.md) | `bin/sync-vault` |
| Wiki ingest (`raw/` → `wiki/`) | [wiki-ingest.md](wiki-ingest.md) | `bin/wiki-ingest` |
| Full cycle | [wiki-cycle.md](wiki-cycle.md) | `bin/wiki-sync` |
| Guardrail checks | [guardrail-checks.md](guardrail-checks.md) | `bin/check-raw`, `check-links`, `check-provenance`, `check-fidelity` |
| Wiki query | [wiki-query.md](wiki-query.md) | `bin/wiki-query`, `bin/k-wiki` |
