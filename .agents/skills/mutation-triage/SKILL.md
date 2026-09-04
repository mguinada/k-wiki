---
name: mutation-triage
description: "Triage StrykerJS mutation-testing survivors: extract surviving and uncovered mutants from reports/mutation/mutation.json, kill each with a new or stronger test, or record its adjudication in the equivalent-mutant registry (`.mutants-registry.json`, edited in the PR), then re-run the scoped mutation to confirm. Use after `npm run mutation:changed` (or `npm run mutation`) reports survived or no-coverage mutants, or when the user says 'triage the survivors', 'triage the full mutation run', 'run mutation across all of src', 'handle the surviving mutants', or asks why tests did not catch a mutant. Do NOT use for running mutation testing itself (the dev-loop run is optional since issue #208; CI auto-files survivors into the rolling issue) or for disabling mutators."
---

# Mutation Triage

Act on surviving mutants from a mutation run. A survivor means no test
can tell the faulty code from the correct code; a no-coverage mutant
means no test even reaches the line — the worse signal. Triage is part
of the advisory workflow in AGENTS.md, never a gate.

## Procedure

1. **Produce the JSON report.** Scope follows the user's request: the
   diff-scoped run is the default; use `--full` when the user asks for
   a full run across all source ("full mutation", "everything",
   "all of src"). If `reports/mutation/mutation.json` is fresh enough
   for that scope, reuse it. Incremental mode makes both fast. Both
   commands print the actionable mutants (Survived and NoCoverage) at
   the end of the run; re-list the last report any time with
   `node dev/mutation-survivors.ts`.

2. **Read the actionable list.** It is already printed — one line per
   mutant: status, `file:line`, mutator. For the diff of one mutant
   (original → replacement), open `reports/mutation/mutation.html` or
   read the source line named there.

3. **Triage each mutant.** Read the mutated code with enough context,
   then decide — make every kill/equivalent decision and write every
   killing test first, as one batch, before any re-run:

   - **Kill** — write one test that fails against the mutant. Repo
     rules apply: exactly one expectation per `it`, the `it` name
     states the fact verified, tests read synthetic fixtures only.
     Prefer killing a group of survivors with one behavior-level test
     over one assertion per mutant.
   - **Equivalent** — the mutant changes the code without changing
     observable behavior (typical: mutated log text, reordered
     side-effect-free calls). Do not chase it. Record it in the
     equivalent-mutant registry, `.mutants-registry.json` at the repo
     root, **in your PR**: run `npm run mutation:survivors -- --ids`
     for the mutant's identity, then add an entry keyed by that id
     with `bucket: "equivalent"`, a one-line justification, the PR
     link, and the date. `bucket: "artifact"` is for measurement
     artifacts (plausibly killable) — never mix the two. PR review of
     the registry diff is the human-judgment gate; a receipt-less
     entry fails the unit suite. This record (or a `// Stryker
     disable` for a location that should never be mutated at all,
     with its written PR-body justification) is the only accepted
     escape valve.

4. **Verify the batch — one run.** Do not re-run after each individual
   fix. Re-run the same command from step 1 once, after the batch.
   Every newly killed mutant must show `Killed`; survivors left must
   all be the equivalents you recorded (the survivors printer filters
   recorded entries and counts them separately). If the run reports
   still-survived mutants whose killing test was already written,
   strengthen that test and re-run once more — repeat in batched
   rounds until only recorded equivalents remain.

5. **Report** a table: mutant → killed-by-test or equivalent + reason,
   plus the before/after mutation score.

## Constraints

- Never weaken an existing test to make a kill cheaper.
- Never write tests that assert on mutant internals (e.g. snapshotting
  code text); assert on observable behavior of the exported API.
- Log hygiene: test input is the synthetic fixture vault; the real
  vault is never test input.
- The gates (`npm run typecheck`, `npm run lint`, `npm test`) must
  stay green after new tests.
