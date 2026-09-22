---
name: quota
description: "Make agent work quota-aware with quota-axi. Use before subagent fan-outs, no-mistakes gate pushes, mutation runs, or other heavy work; when the user asks whether they can run agents, may hit rate limits, needs provider setup, wants model advice, or asks why a provider quota is unreadable. Check projected exhaustion and provider concentration before work starts, then stay quiet when healthy."
---

# Quota awareness

Use `quota-axi` as evidence only. It reports local quota data; it does not
route requests or choose a provider or model. This skill owns the policy
below. Never print, request, copy, or place credential values in the
conversation. Tell the user where to authenticate, then verify with a fresh
non-secret read.

## Calibration — edit these lines when the user's preferences change

- Effective remaining floor: **20%**.
- Do not start new work estimated above **30 minutes** when finite runway
  (`usableRunwaySeconds` in `exhaustion[]`) is below **1 hour**.
- Spread work whenever **2 or more** children or a child fan-out plus a gate
  pipeline will run concurrently.
- Reserve premium quota for review and gate phases; use commodity capacity for
  bulk implementation, tests, and mechanical work unless the user chooses
  otherwise.

## Locate the CLI

Run `command -v quota-axi` first. If it is available, use that executable and
read `quota-axi --help` for current flags instead of copying CLI syntax here.

If it is unavailable, check that Node is at least 22.19. Use
`npx -y quota-axi` for the documented no-install path. Offer
`npm install -g quota-axi` only when the user wants a persistent install. For
upgrades, point to `quota-axi update --check` and `quota-axi update`. Do not
invent a binary path or flags.

## Quiet pre-flight

Before a heavy commitment, read the default TOON report. Use `--json` only
when structured parsing is needed. Inspect `quota[]`, `exhaustion[]`, and
`attention[]`; use `models --sort runway` only for a model-choice decision.
Pair the reading with `herdr agent list` when Herdr is available, so the report
reflects both running agents and remaining capacity.

Estimate the task duration conservatively. The report states runway as a
status: `through_reset` reaches the next reset, while `exhausted_now` and
`projected_exhaustion` carry the finite duration as `usableRunwaySeconds` and
`projectedExhaustedAt` in `exhaustion[]`. A healthy target has effective
remaining at or above the floor, `through_reset` runway or finite runway
beyond the estimate, no exhausted or attention-blocked scope, and enough
independent headroom to spread concurrent work. When all relevant scopes are
healthy, proceed silently: no report line, advice, or interruption.

Ask before starting when a target scope is `exhausted_now`, its
`exhaustion[]` runway is shorter than the estimate, or effective remaining is
below the floor. This is a hard stop, not advice to continue: ask the user
for a decision before launch and do not start until they choose an
alternative or explicitly approve it.

For every hard condition, state the estimate beside the reported runway
(`through_reset`, or the `usableRunwaySeconds` and `projectedExhaustedAt`
from `exhaustion[]`) and the effective remaining beside the 20% floor, even
when one condition already blocks the work. Name the reset time when present and end with an explicit
question: **"Pre-start decision required: choose wait for reset, a healthy
user-approved provider, reduced work, serialization, or explicit approval."**
Do not replace that question with a passive recommendation to wait. Never
silently start work on an exhausted or attention-blocked provider.

## Spread concurrent work

For two or more concurrent children, do not place all work on one provider
scope when alternatives have headroom. Use each scope's `spendPriority` and
effective remaining to assign work across scopes. Keep this mechanical spread
silent when it is clean.

When headroom is fragmented or only one healthy scope exists, serialize work
or ask the user to approve concentration. Say which scope is constrained and
why. A fan-out plus a no-mistakes pipeline counts as concurrent work.

## Give model advice, not routing

Read the per-scope `spendPriority` signal in `quota[]` and
`quota-axi models --sort runway`.
Interpret them using the calibration: premium capacity is for review, design,
and gate work; commodity capacity is for bulk implementation and routine test
work. Explain the trade-off and ask before choosing a lower-quality model for
quality-sensitive work. Do not modify a router, provider configuration, or
credentials.

## Fleet health and configuration

Run `quota-axi auth --json` to produce a usable-fleet versus nominal-fleet
inventory. A provider is usable when at least one source is `available`; a
provider is blocked when no source is available. Treat `missing`, `invalid`,
`expired`, `skipped`, and `error` as findings. Summarize only on fleet
degradation or when the user asks; link each blocked provider to its next step
in [credential remedies](references/credential-remedies.md).

Setup is user-invoked at any time: "set up provider A", "I acquired a
subscription", or "add subscriptions" starts the matching provider flow. For
an empty fleet, ask which subscriptions to configure, then guide and verify
one provider at a time. After every agent-checkable step, rerun
`quota-axi auth --json` and confirm that the source became `available` before
moving on.

Human-only steps, such as a browser sign-in or a Keychain approval, need one
exact action at a time. If the user says "I'll do this myself", output the
remaining provider checklist and stop. Do not re-prompt, poll, or ask for a
secret.

## Boundaries

This skill neither routes or proxies requests nor switches providers. It never
handles secrets, changes provider credentials, globalizes itself, or creates a
scheduled digest. Use fixtures and mocked CLI output for evals; never use live
quota or live auth data as eval input.
