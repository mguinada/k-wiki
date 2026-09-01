# Baseline contrast (deterministic, LLM baseline blocked)

The discriminating assertion for the rollup eval is b1: After D must
carry the LIVE instrument's fresh values. The epic's own doc-time
rollup row values (cross-domain edges 35, env signatures 50, parseArgs
copies 9) are what an agent working from the epic body alone would
copy; against the fresh instrument (52 / 50 / 10) the b1 checker fails
that output on two of four counters (35 != 52, 9 != 10) while the
with-skill output passes 4/4. The files >500 row (11) does not
discriminate; env signatures (50) coincides with fresh output this
checkpoint.

For the audit eval, an epic-only agent has no procedural contract to
check all three invariants (slice map, wiring, per-issue recording)
against live gh state; the with-skill run's 18-issue table with
state+PR per issue and a violations list is the asserted shape.
