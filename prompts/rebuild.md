Rebuild the knowledge wiki from all material under raw/.

Follow wiki/AGENTS.md.

Process sources in logical batches.

Build:
- concepts;
- entities;
- sources;
- comparisons;
- relationships;
- index.md;
- log.md.

Second brain: when the data repo root holds the `.second-brain`
marker, restore `wiki/second-brain/profile.md` from git before
building, read it first, and rebuild the pages under
`wiki/second-brain/` with types `project`, `decision`, and
`attempt`. Without the marker this wiki is a domain wiki: build no
second-brain pages.

Avoid duplicate pages.

Every page you build must carry the required frontmatter fields
(`title`, `type`, `created`, `updated`, `tags`) — including `index.md`
and `overview.md`, which the skeleton ships bare; a run that writes
either without frontmatter is auto-reverted.

Every substantive claim must be traceable to source material.

Preserve uncertainty and contradictions.

Do not modify raw/.

The resulting wiki must be understandable without reading every raw source.
