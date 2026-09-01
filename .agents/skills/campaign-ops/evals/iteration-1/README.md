# Iteration 1 eval results (2026-09-01)

With-skill runs: 4/4 assertions pass on both evals (grading JSON
files alongside). Baseline LLM runs were blocked — no subagent model
spawnable in the authoring session (fresh-context natives fail the
model registry filter; codex-exec is rate-limited; claude-code OAuth
expired). The deterministic baseline contrast (the epic's doc-time
values vs the live instrument) is recorded in baseline-contrast.md:
an epic-only rollup draft fails the fresh-values assertion on two of
four counters. Full run artifacts and the static review viewer:
/tmp/k-wiki-campaign-ops-workspace/ (session-temporary).
