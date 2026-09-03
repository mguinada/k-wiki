import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkCrossWikiLinks } from "../../src/wiki/crosslinks.ts";

/** Unit tests for the cross-wiki link audit core
 *  (src/wiki/crosslinks.ts, issue #81): the one-way link discipline
 *  rules, exercised directly at the module's mirrored path
 *  (issue #260). The check-crosslinks CLI rendering stays at
 *  tests/scripts/check-crosslinks.test.ts. */

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** Write one wiki tree (`<name>/` with files) under `root`; when
 *  `vault` is given, also the sibling `raw/manifest.json` naming that
 *  vault — a domain wiki's identity source. */
async function writeWiki(
  root: string,
  name: string,
  files: Record<string, string>,
  vault?: string,
): Promise<void> {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(join(root, name, dirname(file)), { recursive: true });
    await writeFile(join(root, name, file), content);
  }

  if (vault !== undefined) {
    await mkdir(join(root, "raw"), { recursive: true });
    await writeFile(
      join(root, "raw", "manifest.json"),
      `${JSON.stringify({ vaults: { [vault]: {} } }, null, 2)}\n`,
    );
  }
}

/** A temp root holding `<name>/` wiki (plus a manifest naming `vault`
 *  when given). */
async function makeWiki(
  name: string,
  files: Record<string, string>,
  vault?: string,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "k-wiki-xlinks-"));

  tempDirs.push(root);
  await writeWiki(root, name, files, vault);

  return root;
}

describe("checkCrossWikiLinks", () => {
  it("resolves a cross-wiki link against the domain wiki's pages", async () => {
    const brain = await makeWiki("brain", {
      "decision-fast-tests.md": "Backed by [[engineering/stub]].\n",
    });
    const engineering = await makeWiki(
      "engineering",
      { "concepts/stub.md": "# Stub\n" },
      "Engineering",
    );

    const report = await checkCrossWikiLinks(
      join(brain, "brain"),
      join(engineering, "engineering"),
    );

    expect(report.problems).toEqual([]);
  });

  it("counts the resolved external link", async () => {
    const brain = await makeWiki("brain", {
      "decision-fast-tests.md": "Backed by [[engineering/stub]].\n",
    });
    const engineering = await makeWiki(
      "engineering",
      { "concepts/stub.md": "# Stub\n" },
      "Engineering",
    );

    const report = await checkCrossWikiLinks(
      join(brain, "brain"),
      join(engineering, "engineering"),
    );

    expect(report.external).toBe(1);
  });

  it("resolves a link whose vault name case differs", async () => {
    const brain = await makeWiki("brain", {
      "index.md": "See [[Engineering/stub]].\n",
    });
    const engineering = await makeWiki(
      "engineering",
      { "entities/stub.md": "# Stub\n" },
      "Engineering",
    );

    const report = await checkCrossWikiLinks(
      join(brain, "brain"),
      join(engineering, "engineering"),
    );

    expect(report.problems).toEqual([]);
  });

  it("counts the case-insensitive external link", async () => {
    const brain = await makeWiki("brain", {
      "index.md": "See [[Engineering/stub]].\n",
    });
    const engineering = await makeWiki(
      "engineering",
      { "entities/stub.md": "# Stub\n" },
      "Engineering",
    );

    const report = await checkCrossWikiLinks(
      join(brain, "brain"),
      join(engineering, "engineering"),
    );

    expect(report.external).toBe(1);
  });

  it("resolves links to several domain wikis in one run", async () => {
    const brain = await makeWiki("brain", {
      "index.md": "See [[engineering/stub]] and [[anthropology/kinship]].\n",
    });
    const engineering = await makeWiki(
      "engineering",
      { "concepts/stub.md": "# Stub\n" },
      "Engineering",
    );
    const anthropology = await makeWiki(
      "anthropology",
      { "entities/kinship.md": "# Kinship\n" },
      "Anthropology",
    );

    const report = await checkCrossWikiLinks(
      join(brain, "brain"),
      join(engineering, "engineering"),
      join(anthropology, "anthropology"),
    );

    expect(report.problems).toEqual([]);
  });

  it("counts one external link per domain wiki", async () => {
    const brain = await makeWiki("brain", {
      "index.md": "See [[engineering/stub]] and [[anthropology/kinship]].\n",
    });
    const engineering = await makeWiki(
      "engineering",
      { "concepts/stub.md": "# Stub\n" },
      "Engineering",
    );
    const anthropology = await makeWiki(
      "anthropology",
      { "entities/kinship.md": "# Kinship\n" },
      "Anthropology",
    );

    const report = await checkCrossWikiLinks(
      join(brain, "brain"),
      join(engineering, "engineering"),
      join(anthropology, "anthropology"),
    );

    expect(report.external).toBe(2);
  });

  it("audits the single brain page", async () => {
    const brain = await makeWiki("brain", {
      "index.md": "See [[engineering/stub]] and [[anthropology/kinship]].\n",
    });
    const engineering = await makeWiki(
      "engineering",
      { "concepts/stub.md": "# Stub\n" },
      "Engineering",
    );
    const anthropology = await makeWiki(
      "anthropology",
      { "entities/kinship.md": "# Kinship\n" },
      "Anthropology",
    );

    const report = await checkCrossWikiLinks(
      join(brain, "brain"),
      join(engineering, "engineering"),
      join(anthropology, "anthropology"),
    );

    expect(report.auditedPages).toBe(1);
  });

  it("sees both domain wiki pages", async () => {
    const brain = await makeWiki("brain", {
      "index.md": "See [[engineering/stub]] and [[anthropology/kinship]].\n",
    });
    const engineering = await makeWiki(
      "engineering",
      { "concepts/stub.md": "# Stub\n" },
      "Engineering",
    );
    const anthropology = await makeWiki(
      "anthropology",
      { "entities/kinship.md": "# Kinship\n" },
      "Anthropology",
    );

    const report = await checkCrossWikiLinks(
      join(brain, "brain"),
      join(engineering, "engineering"),
      join(anthropology, "anthropology"),
    );

    expect(report.domainPages).toBe(2);
  });

  it("reports a broken cross-wiki link as file:line -> [[link]]", async () => {
    const brain = await makeWiki("brain", {
      "profile.md": "Points at [[engineering/missing]].\n",
    });
    const engineering = await makeWiki(
      "engineering",
      { "concepts/stub.md": "# Stub\n" },
      "Engineering",
    );

    const report = await checkCrossWikiLinks(
      join(brain, "brain"),
      join(engineering, "engineering"),
    );

    expect(report.problems).toEqual([
      "brain/profile.md:1 -> [[engineering/missing]]",
    ]);
  });

  it("reports a link naming an unknown domain wiki", async () => {
    const brain = await makeWiki("brain", {
      "index.md": "Points at [[history/foo]].\n",
    });
    const engineering = await makeWiki(
      "engineering",
      { "index.md": "# Engineering\n" },
      "Engineering",
    );

    const report = await checkCrossWikiLinks(
      join(brain, "brain"),
      join(engineering, "engineering"),
    );

    expect(report.problems).toEqual([
      'brain/index.md:1 -> [[history/foo]] (unknown domain wiki "history")',
    ]);
  });

  it("reports a cross-wiki link inside a domain wiki", async () => {
    const brain = await makeWiki("brain", { "index.md": "# Brain\n" });
    const engineering = await makeWiki(
      "engineering",
      { "entities/leaky.md": "Dodges resolution via [[brain/decision]].\n" },
      "Engineering",
    );

    const report = await checkCrossWikiLinks(
      join(brain, "brain"),
      join(engineering, "engineering"),
    );

    expect(report.problems).toEqual([
      "engineering/entities/leaky.md:1 -> [[brain/decision]] (domain wikis must not use cross-wiki links)",
    ]);
  });

  it("ignores protocol links entirely", async () => {
    const brain = await makeWiki("brain", {
      "index.md": "Plain URL wikilink [[https://example.com/page]].\n",
    });
    const engineering = await makeWiki(
      "engineering",
      { "index.md": "# Engineering\n" },
      "Engineering",
    );

    const report = await checkCrossWikiLinks(
      join(brain, "brain"),
      join(engineering, "engineering"),
    );

    expect(report.problems).toEqual([]);
  });

  it("does not count protocol links as external", async () => {
    const brain = await makeWiki("brain", {
      "index.md": "Plain URL wikilink [[https://example.com/page]].\n",
    });
    const engineering = await makeWiki(
      "engineering",
      { "index.md": "# Engineering\n" },
      "Engineering",
    );

    const report = await checkCrossWikiLinks(
      join(brain, "brain"),
      join(engineering, "engineering"),
    );

    expect(report.external).toBe(0);
  });

  it("skips AGENTS.md in both trees", async () => {
    const brain = await makeWiki("brain", {
      "AGENTS.md": "Contract mentions [[engineering/missing]].\n",
    });
    const engineering = await makeWiki(
      "engineering",
      { "AGENTS.md": "Self [[engineering/missing]].\n", "index.md": "# E\n" },
      "Engineering",
    );

    const report = await checkCrossWikiLinks(
      join(brain, "brain"),
      join(engineering, "engineering"),
    );

    expect(report.problems).toEqual([]);
  });

  it("does not audit AGENTS.md", async () => {
    const brain = await makeWiki("brain", {
      "AGENTS.md": "Contract mentions [[engineering/missing]].\n",
    });
    const engineering = await makeWiki(
      "engineering",
      { "AGENTS.md": "Self [[engineering/missing]].\n", "index.md": "# E\n" },
      "Engineering",
    );

    const report = await checkCrossWikiLinks(
      join(brain, "brain"),
      join(engineering, "engineering"),
    );

    expect(report.auditedPages).toBe(0);
  });

  it("still counts the domain wiki's pages", async () => {
    const brain = await makeWiki("brain", {
      "AGENTS.md": "Contract mentions [[engineering/missing]].\n",
    });
    const engineering = await makeWiki(
      "engineering",
      { "AGENTS.md": "Self [[engineering/missing]].\n", "index.md": "# E\n" },
      "Engineering",
    );

    const report = await checkCrossWikiLinks(
      join(brain, "brain"),
      join(engineering, "engineering"),
    );

    expect(report.domainPages).toBe(1);
  });

  it("rejects a missing audited wiki directory", async () => {
    const root = await makeWiki("engineering", { "index.md": "# E\n" });

    await expect(
      checkCrossWikiLinks(join(root, "missing"), join(root, "engineering")),
    ).rejects.toThrow(
      `wiki directory does not exist: ${join(root, "missing")}`,
    );
  });

  it("rejects a missing domain wiki directory", async () => {
    const root = await makeWiki("brain", { "index.md": "# P\n" });

    await expect(
      checkCrossWikiLinks(join(root, "brain"), join(root, "missing")),
    ).rejects.toThrow(
      `wiki directory does not exist: ${join(root, "missing")}`,
    );
  });

  it("rejects a domain wiki without a sibling manifest", async () => {
    const brain = await makeWiki("brain", { "index.md": "# P\n" });
    const bare = await makeWiki("engineering", { "index.md": "# E\n" });

    await expect(
      checkCrossWikiLinks(join(brain, "brain"), join(bare, "engineering")),
    ).rejects.toThrow(/no manifest at .*raw\/manifest\.json/);
  });

  it("rejects a domain wiki whose manifest names no vaults", async () => {
    const brain = await makeWiki("brain", { "index.md": "# P\n" });
    const empty = await makeWiki(
      "engineering",
      { "index.md": "# E\n" },
      "Empty",
    );

    await writeFile(
      join(empty, "raw", "manifest.json"),
      `${JSON.stringify({ vaults: {} }, null, 2)}\n`,
    );
    await expect(
      checkCrossWikiLinks(join(brain, "brain"), join(empty, "engineering")),
    ).rejects.toThrow(/names no vaults/);
  });

  it("lets a domain wiki keep internal links", async () => {
    const brain = await makeWiki("brain", {
      "decision.md": "Backed by [[engineering/stub]].\n",
    });
    const engineering = await makeWiki(
      "engineering",
      {
        "concepts/stub.md": "# Stub\n\nSee also [[notes]].\n",
        "concepts/notes.md": "# Notes\n",
      },
      "Engineering",
    );

    const report = await checkCrossWikiLinks(
      join(brain, "brain"),
      join(engineering, "engineering"),
    );

    expect(report.problems).toEqual([]);
  });
});
