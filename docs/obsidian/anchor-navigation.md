# Obsidian anchor navigation — client clunkiness, tracked

Status: active reference. Last verified 2026-08-31 (Obsidian 1.x
current at time of writing).

The wiki's anchored citations (`[[hub#Chapter]]` in frontmatter
`sources` and body prose) carry addresses the repo's lints guarantee:
`check-provenance` and `check-links` (issue #235) enforce that every
anchor lands on a target heading **byte-identically**. That guarantee
covers the *address*, not Obsidian's *behavior* when you click it.
Obsidian's client has three documented quirks that make anchored
navigation feel clunky. None of them indicate a wiki-data defect; all
of them are worth knowing before filing one.

## 1. Click sometimes lands at the note top instead of the heading

A long-standing Obsidian bug family: clicking a heading link opens
the target note, the view flickers, and the scroll lands at the top.

- [Internal note link to heading / block reference jumps back to top
  of page](https://forum.obsidian.md/t/internal-note-link-to-heading-block-reference-jumps-back-to-top-of-page/16152)
  — "95% of the time it leaves you at the TOP of the note … 100%
  reproducible" for that reporter.
- [Clicking on a wikilink style Heading Link doesn't always scroll to
  that heading when linked tabs are open](https://forum.obsidian.md/t/clicking-on-a-wikilink-style-heading-link-doesnt-always-scroll-to-that-heading-when-linked-tabs-are-open/66122)
  — linked panes amplify it ("around 90% of the time it just
  flickers and leaves me at the very top").
- [Clicking on a wikilink style Heading Link doesn't scroll to that
  particular Heading](https://forum.obsidian.md/t/clicking-on-a-wikilink-style-heading-link-doesn-t-scroll-to-that-particular-heading/76397)
- [Links to internal headings do not jump to heading
  line](https://forum.obsidian.md/t/links-to-internal-headings-do-not-jump-to-heading-line/42310)

Mode matters: Reading View is the worst-reported surface — links go
to the note but not the heading there, while Live Preview behaves
([Links not working properly](https://forum.obsidian.md/t/links-not-working-properly/79916)).
Test anchored navigation in Live Preview before concluding a link is
broken.

## 2. Links "warm up" — the metadata cache resolves asynchronously

Obsidian resolves link subpaths (`#heading`) against its
**MetadataCache**, which re-indexes changed files asynchronously
([MetadataCache and link resolution](https://deepwiki.com/obsidianmd/obsidian-api/2.4-metadatacache-and-link-resolution)).
Until a changed file's cache entry is resolved, an anchored click
into it opens the note without scrolling — then starts working
"later", with no change to the file. That is the warm-up lag.

This wiki's operations amplify it: `wiki-ingest` runs, scoped
re-ingests, and git checkouts rewrite wiki files **externally** while
Obsidian may be open on the data repo. Every external write
invalidates that file's cache entry and re-queues resolution; until
the vault settles, anchored navigation into freshly written files is
flaky. An open Obsidian is also an external writer itself
(`.obsidian/workspace.json`), which trips ingest guardrail 1 (the
immutability check) — close Obsidian on the data repo during runs
for both reasons.

Re-test on a settled cache: close and reopen Obsidian, or
Cmd+P → "Reload app without saving", then click.

## 3. Matching semantics are looser than ours — byte-identical is a safe subset

Obsidian strips non-alphanumerics when matching heading anchors:
`## heading?` and `## heading!` are the same target to Obsidian
([Headings with special characters have broken links and
renaming](https://forum.obsidian.md/t/headings-with-special-characters-have-broken-links-and-renaming/40707),
staff reply), and the help docs list the characters that break links
outright ([Internal links — Obsidian
Help](https://obsidian.md/help/links)). The wiki's byte-identical
rule (headings generated from the same string as the anchor, never
typed free-hand — issues #226/#235) is deliberately **stricter**:
every anchor the lints accept also resolves under Obsidian's lenient
matching, including irregular names like `27.  Digital Wallet`.
A lint failure, not a client quirk, is the signal of a bad anchor.

## Properties-panel chips are metadata, not navigation

Frontmatter `sources` citations render as clickable chips in
Obsidian's properties panel, but nothing documents that a chip click
scrolls to the anchor's heading — panel link support itself has open
rough edges ([Wiki links in properties not
working](https://forum.obsidian.md/t/wiki-links-in-properties-not-working/89237),
[Wikilinks won't render correctly in
Properties](https://forum.obsidian.md/t/wikilinks-wont-render-dont-render-correctly-in-properties/91611)).
Treat the panel as the provenance surface it is: the chip answers
"which chapter does this claim rest on". Chapter *navigation* lives
in body prose — anchored body links (validated by `check-links`) are
the surface where heading navigation is expected to work, subject to
the quirks above.

## Summary for reviewers

| Symptom | Cause | Wiki defect? |
|---|---|---|
| Click lands at note top, view flickers | Obsidian scroll bug family (§1), worst in Reading View, amplified by linked panes | No |
| Anchors work "after a while" | MetadataCache async re-resolution after external writes (§2) | No |
| `[[hub#Chapter]]` unresolved styling | Lint would have caught it (§3); re-check after cache settles | Only if `check-links` reports it |
| Panel chip opens note, no heading scroll | Panel is metadata surface (§4) | No |

The lints are the source of truth for anchor correctness. The client
decides how nicely it scrolls.
