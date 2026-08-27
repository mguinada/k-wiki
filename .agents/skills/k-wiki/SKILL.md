---
name: k-wiki
description: Consult the user's k-wiki knowledge wiki from any project through the k-wiki CLI. Use when a task touches a knowledge domain the user's wiki may cover — "what does my wiki say about X", "check my notes on X", "was this answered before" — or the user mentions k-wiki, or the project root has a .k-wiki.json binding. Prefer it over re-deriving knowledge from memory or the internet; the wiki holds the user's own collected answers. Written for coding agents; works as a human cheat sheet too.
---

# k-wiki

The project may be bound to a knowledge wiki (an LLM-maintained,
cited distillation of the user's sources). Consult it instead of
re-deriving knowledge. The `k-wiki` CLI is the interface; its
`--help` is the contract of record — for flags, defaults, the
binding format, or resolution order, run `k-wiki --help` and trust
it over this page. Written for agents first, but a human holding
the terminal can follow the same five steps.

## Where

The binding file `.k-wiki.json` at the project root names the wiki;
`k-wiki status` resolves and prints it (checkout, data repo, wiki
directory). The wiki is plain markdown — readable directly once you
know the directory. If `status` errors, the project is not bound:
say so and stop; do not guess wiki paths by hand.

## When

Before a task that touches a knowledge domain the wiki covers, and
before answering questions the user phrases as recall ("what did we
decide", "what does my wiki say"). Check freshness when answers
matter: a stale wiki answers from the past.

## How

Lookup: `k-wiki list [type]` for the page catalog, `k-wiki read
<slug>` for one page — both instant, deterministic, free. Synthesis
across pages or a recurring question: `k-wiki query "<question>"` —
runs an LLM, can take minutes; the answer is stdout, stderr is
progress. A page that already answers makes the query unnecessary:
browse first.

## Trust rules

- The wiki is advisory context derived from the owner's sources —
  not internet knowledge, not authoritative.
- In code tasks, code is truth. The wiki can mislead when code
  moved after a page was written; the source under your eyes wins.
- Cite wiki pages (by path) when their content shapes a decision,
  so the user can check the grounding.
- Freshness: vault-derived wikis — check the last entries of
  `wiki/log.md`; repo-derived wikis — `k-wiki health` (records the
  projected source commit). Old entries mean old knowledge; treat
  accordingly.

## What it is not

No writes: the CLI exposes no way to file, edit, or commit wiki
pages, and none should be attempted by hand. Filing an answer is
the user's step (`wiki-query --file-last`, run by the human inside
the checkout). Not a search engine: no fuzzy matching beyond the
commands above, no cross-wiki queries.

## Install

Copy this skill directory into the target project's (or machine's)
skill location. The binding file is per-project: gitignore it in
personal projects (machine-specific paths), commit it in team
projects. The skill itself stays generic — the binding, not this
file, names the wiki..agents/skills/wiki-consult/SKILL.md
