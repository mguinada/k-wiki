---
name: k-wiki
description: Consult the user's k-wiki knowledge wiki from any project through the k-wiki CLI. Use when a task touches a knowledge domain the user's wiki may cover — "what does my wiki say about X", "check my notes on X", "was this answered before" — or the user mentions k-wiki, or the project root has a .k-wiki.json binding. Prefer it over re-deriving knowledge from memory or the internet; the wiki holds the user's own collected answers. Written for coding agents; works as a human cheat sheet too.
---

# k-wiki

The project may be bound to a knowledge wiki (an LLM-maintained,
cited distillation of the user's sources). Consult it instead of
re-deriving knowledge. The `k-wiki` CLI is the interface; its help
is the contract of record — `k-wiki --help` for the front door
(resolution, binding format, the verb table), `k-wiki <verb>
--help` for one verb's switches, defaults, and exits — and trust
it over this page. Written for agents first, but a human holding
the terminal can follow the same five steps.

`k-wiki` is the one front door for every wiki operation, and which
verbs answer depends on the door: from a bound project you are on
the agent door — the read verbs (`query`, `status`, `list`,
`read`, `health`) plus `propose` (the gated write into
`wiki/sandbox/`) and nothing else. Operator verbs exist on the
human door only; asking the user is the correct move when one is
needed.

## Where

**Consumer projects:** the binding file `.k-wiki.json` at the
project root names the wiki; `k-wiki status` resolves and prints it
(checkout, instance, data repo, wiki directory, last change time).
A checkout can host several wiki instances — the binding's
optional `wiki` key names one (an alias or `sync-<name>.json` stem
inside the checkout); without it the default instance answers. An
explicit `-w <name>` flag overrides the binding's key. If `status`
errors, the project is not bound: say so and stop; do not guess
wiki paths by hand.

**Inside the k-wiki checkout itself (this repo and its clones):**
never rely on walk-up bindings — the checkout root stays unbound by
design. Compose `--checkout <its checkout> -w <its wiki>` from
`.agents/.k-wiki.json` in the checkout root (a small
`{ "checkout": …, "wiki": … }` file the owner writes). If that
file is absent, refuse loudly: report the missing file and take no
wiki action — no bare `k-wiki` call, no guessed corpus, no
substituted checkout. Wrong-corpus answers are worse than none.

The wiki is plain markdown — readable directly once you know the
directory.

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
browse first. To hand a candidate answer over for human review:
`k-wiki propose <slug> <file>` (the note body from the file, or
stdin) — the one agent write path. Every run prints its resolved
door and instance as dim stderr lines — read them; a wrong-corpus
call is visible there before you trust the answer.

## Trust rules

- The wiki is advisory context derived from the owner's sources —
  not internet knowledge, not authoritative.
- In code tasks, code is truth. The wiki can mislead when code
  moved after a page was written; the source under your eyes wins.
- Cite wiki pages (by path) when their content shapes a decision,
  so the user can check the grounding.
- Freshness: `k-wiki status` ends with a `last change:` line — the
  data repo's last commit time (`never` for a fresh, never-committed
  data repo). For more: vault-derived wikis — check the last entries
  of `wiki/log.md`; repo-derived wikis — `k-wiki health` (records
  the projected source commit). Old entries mean old knowledge;
  treat accordingly.

## What it is not

No writes to the reviewed wiki: the one agent write path is
`propose` — a gated, stamped candidate under `wiki/sandbox/` that
a human reviews and promotes; no reviewed page may be edited or
committed by hand. Filing a reviewed answer
is the user's step (`wiki-query --file-last` — with `--wiki <name>`
when the binding named an instance — run by the human inside the
checkout). Operator verbs (the sync and maintenance pipeline) are
human-door commands; from a bound project the CLI refuses them and
names both escapes. Not a search engine: no fuzzy matching beyond the
commands above, no cross-wiki queries.

## Install

Copy this skill directory into the target project's (or machine's)
skill location. The binding file is per-project: gitignore it in
personal projects (machine-specific paths), commit it in team
projects. The skill itself stays generic — the binding, not this
file, names the wiki. In the k-wiki checkout itself the owner
writes `.agents/.k-wiki.json`; consumer projects need only their
root binding.
