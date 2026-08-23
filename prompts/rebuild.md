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

Second brain: restore `wiki/second-brain/profile.md` from git before
building, read it first, and rebuild the pages under
`wiki/second-brain/` with types `project`, `decision`, and `attempt`.

Avoid duplicate pages.

Every page you build must carry the required frontmatter fields
(`title`, `type`, `created`, `updated`, `tags`) — including `index.md`
and `overview.md`, which the skeleton ships bare; a run that writes
either without frontmatter is auto-reverted.

Every substantive claim must be traceable to source material.

Preserve uncertainty and contradictions.

Do not modify raw/.

The resulting wiki must be understandable without reading every raw source.
