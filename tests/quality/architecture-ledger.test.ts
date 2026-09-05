import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectTsFiles, insideStrykerSandbox } from "./src-tree.ts";

/**
 * The architecture-ledger guard (issue #316): the bounded-context
 * block in AGENTS.md is the loadable baseline of the #242 domain
 * boundaries, so it cannot drift from the tree it describes. Two
 * checks keep it true: the Bounded contexts table names exactly the
 * `src/` domains (a new domain without a row, or a row without its
 * domain, fails), and every `src/` module declares its purpose
 * in a leading docblock — the per-file scope carrier. Both scans
 * read the real tree and skip inside the Stryker sandbox, where
 * instrumentation distorts it (issue #276).
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const agentsPath = join(repoRoot, "AGENTS.md");

const skipNote =
  "Stryker sandbox instruments src/; the ledger scan reads the real tree (issue #276)";

/**
 * The bounded-context domain names of the Architecture alignment
 * block: the first-column `` `name/` `` cells of its Bounded
 * contexts table. Undefined when the block or its table is absent —
 * the ledger itself has rotted away.
 */
function ledgerDomains(markdown: string): string[] | undefined {
  const sectionStart = /^## Architecture alignment\s*$/m.exec(markdown);
  const tableStart = /^### Bounded contexts\s*$/m.exec(markdown);

  if (sectionStart === null || tableStart === null) {
    return undefined;
  }

  const afterHeading = markdown.slice(
    sectionStart.index + sectionStart[0].length,
  );
  const sectionEnd = afterHeading.search(/^## /m);
  const section = afterHeading.slice(
    0,
    sectionEnd === -1 ? undefined : sectionEnd,
  );
  const tableRel = section.indexOf(tableStart[0]);

  if (tableRel === -1) {
    return undefined;
  }

  const afterTable = section.slice(tableRel + tableStart[0].length);
  const tableEnd = afterTable.search(/^###\s/m);
  const table = afterTable.slice(0, tableEnd === -1 ? undefined : tableEnd);
  const domains: string[] = [];

  for (const cell of table.matchAll(/^\|\s*`([a-z][a-z0-9-]*\/)`/gm)) {
    const name = cell[1];

    if (name !== undefined) {
      domains.push(name.slice(0, -1));
    }
  }

  return domains;
}

/** Whether a module opens with a purpose docblock. */
function hasLeadingDocblock(source: string): boolean {
  return source.startsWith("/**");
}

describe("ledgerDomains", () => {
  it("collects the Bounded contexts domains, ignoring the invariants table above it", () => {
    const domains = ledgerDomains(miniLedger());

    expect(domains).toEqual(["cli", "sync", "wiki"]);
  });

  it("returns undefined when the block or its table is absent", () => {
    expect(ledgerDomains("# k-wiki\n\n## Write Authority\n")).toBeUndefined();
  });
});

describe("hasLeadingDocblock", () => {
  it("accepts a module that opens with a docblock", () => {
    expect(hasLeadingDocblock("/** The sync config loader. */\n")).toBe(true);
  });

  it("rejects a module that opens with an import", () => {
    expect(hasLeadingDocblock('import { join } from "node:path";\n')).toBe(
      false,
    );
  });
});

describe("architecture ledger (live tree)", () => {
  it("the Bounded contexts table names exactly the src/ domains", async ({
    skip,
  }) => {
    if (insideStrykerSandbox()) {
      skip(skipNote);

      return;
    }

    const domains = ledgerDomains(await readFile(agentsPath, "utf8"));

    expect(
      domains,
      "AGENTS.md carries no Architecture alignment block",
    ).not.toBeUndefined();

    const live = (await readdir(join(repoRoot, "src"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const ledger = [...new Set(domains)].sort();
    const offenders = [
      ...ledger
        .filter((domain) => !live.includes(domain))
        .map((domain) => `\`${domain}/\` row: no src/${domain} directory`),
      ...live
        .filter((domain) => !ledger.includes(domain))
        .map((domain) => `src/${domain}: no ledger row in AGENTS.md`),
    ];

    expect(offenders).toEqual([]);
  });

  it("every src/ module declares its purpose in a leading docblock", async ({
    skip,
  }) => {
    if (insideStrykerSandbox()) {
      skip(skipNote);

      return;
    }

    const offenders: string[] = [];

    for (const file of await collectTsFiles(join(repoRoot, "src"), "src")) {
      if (!hasLeadingDocblock(await readFile(join(repoRoot, file), "utf8"))) {
        offenders.push(`${file}: no leading purpose docblock`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

/** A miniature Architecture alignment block, both tables present. */
function miniLedger(): string {
  return [
    "## Architecture alignment",
    "",
    "### Cross-cutting invariants",
    "",
    "| Invariant | Why | Enforcing guard |",
    "|---|---|---|",
    "| one CLI shell | parsers drifted | structure gate |",
    "",
    "### Bounded contexts",
    "",
    "| Domain | Owns | Never | Guard |",
    "|---|---|---|---|",
    "| `cli/` | the shared shell | domain decisions | review-enforced only |",
    "| `sync/` | the projection | LLM concerns | review-enforced only |",
    "| `wiki/` (dev) | link parsing | orchestration | review-enforced only |",
    "",
    "## Write Authority",
    "",
  ].join("\n");
}
