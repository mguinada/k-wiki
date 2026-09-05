# Wiki query

Asking the built wiki one question headless: `wiki-query` prints the
answer and saves it for review; `--file-last` files the reviewed
answer. `bin/k-wiki` is the agent-facing front door from any project
(`query`, `status`, `list`, `read`, `health`), bound via
`.k-wiki.json`.

## Sub-features

- `query-answer`: stage 1 prints the answer, writes nothing under
  `wiki/`, saves the artifact for review.
- `query-file-last`: stage 2 deterministically files the last
  reviewed answer.
- `k-wiki-binding`: `bin/k-wiki` resolves the bound instance from any
  cwd and exposes read-only `status` / `list` / `read` / `health`.

## How to get to it (user POV)

- `bin/wiki-query [--file-last] <question>` from the checkout root.
- From any project with a `.k-wiki.json` binding: `bin/k-wiki query
  "<question>"`, `bin/k-wiki status`, `bin/k-wiki list`, `bin/k-wiki
  read <slug>`, `bin/k-wiki health`.

## Driving it with the CLI harness

Preconditions:

- Temp data repo `$D` with at least one successful ingest (SKILL.md
  Drive steps 1–4) and stub `settings.yml`.

- **Stage 1 answer.** Run `bin/wiki-query --settings "$D/settings.yml" --outputs "$S/outputs" "What is in the wiki?"`. Exit 0; stdout holds the stub's answer line; the artifact exists under `$S/outputs/` (last-query); no new file appeared under `$D/wiki` (`find "$D/wiki" -type f` unchanged) — stage 1 is answer-only.
- **What the agent saw.** The stub recorded the composed prompt at `$D/outputs/stub-prompt.txt`; it contains the question and the answer-only mode line. This is the evidence that the question reached the agent path.
- **Rogue answer reverted.** To prove the answer-only guardrail, point `command:` at a variant that also writes `$D/wiki/concepts/rogue.md` (plain `writeFile` then `console.log("An answer.")`). Re-run: the query still succeeds/exits per guardrail design and `rogue.md` does not survive (`test ! -f "$D/wiki/concepts/rogue.md"`); restore the standard stub.
- **k-wiki read-only surface.** In a temp project dir, write `{"wikiDir": "<abs $D/wiki>", "rawDir": "<abs $D/raw>"}` to `.k-wiki.json` (field names per `bin/k-wiki status` output on this checkout — it prints the binding it resolved). Run `node <repo>/bin/k-wiki status`, `… list`, `… read stub`, `… health` from that dir: each exits 0 and names the temp instance, proving the binding resolves without touching the user's real instance.
- **Proof.** Command lines, stdout, exit codes, the saved query artifact, and the unchanged `$D/wiki` listing, into `$EV`.

## Gotchas

- `wiki-query` defaults to the repo's real `settings.yml` — always
  pass `--settings` with the temp file, as everywhere else.
- The stub discriminates query prompts by content; if the recorded
  prompt lacks the expected mode line, suspect the wrapper, not the
  stub.
- `--file-last` mutates the wiki; drive it only after reading the
  digest-filing contract (`wiki/AGENTS.md` queries section) — the
  simple stub answer may not satisfy the filing format.
