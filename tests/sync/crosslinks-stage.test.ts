import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type RunContextInput, runContext } from "../../src/cli/run-context.ts";
import {
  type CrosslinksResult,
  runCrosslinksStage,
} from "../../src/sync/crosslinks-stage.ts";

/** The crosslink stage's own unit tests (the module behind the
 *  cycle's stage 4): skip, announcement, audit scope, failure, and
 *  the `~` expansion of configured domain dirs. The cycle-level
 *  integration lives in wiki-sync.test.ts. */

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A temp data root whose wiki/ carries one decision page linking
 *  out, plus one domain wiki for the audit to validate against. */
async function makeAuditedWiki(
  decisionBody: string,
): Promise<{ readonly dataRoot: string; readonly domainWiki: string }> {
  const tmp = await mkdtemp(join(tmpdir(), "k-wiki-crosslinks-"));

  tempDirs.push(tmp);

  const dataRoot = join(tmp, "data");
  const domainRoot = join(tmp, "domain");

  await mkdir(join(dataRoot, "wiki"), { recursive: true });
  await mkdir(join(domainRoot, "wiki"), { recursive: true });
  await mkdir(join(domainRoot, "raw"), { recursive: true });
  await writeFile(
    join(dataRoot, "wiki", "decision.md"),
    `# Decision\n\n${decisionBody}\n`,
  );
  await writeFile(
    join(domainRoot, "raw", "manifest.json"),
    `${JSON.stringify({ vaults: { Engineering: {} } }, null, 2)}\n`,
  );
  await writeFile(join(domainRoot, "wiki", "index.md"), "# Domain\n");
  await writeFile(join(domainRoot, "wiki", "stub.md"), "# Stub\n");

  return { dataRoot, domainWiki: join(domainRoot, "wiki") };
}

function runFor(dataRoot: string, input: Omit<RunContextInput, "rawDir"> = {}) {
  return runContext({ rawDir: join(dataRoot, "raw"), ...input });
}

describe("runCrosslinksStage", () => {
  it("skips the stage outright when no domains are configured", async () => {
    const { dataRoot } = await makeAuditedWiki("# Decision\n");

    await expect(
      runCrosslinksStage({ run: runFor(dataRoot) }),
    ).resolves.toBeUndefined();
  });

  it("announces the domain wiki count on the progress line", async () => {
    const { dataRoot, domainWiki } = await makeAuditedWiki("# Decision\n");
    const progress: string[] = [];

    await runCrosslinksStage({
      run: runFor(dataRoot, {
        onProgress: (message) => progress.push(message),
      }),
      domains: [domainWiki],
    });

    expect(progress).toContainEqual(
      "wiki-sync: crosslinks — auditing against 1 domain wiki",
    );
  });

  it("runs without a progress sink", async () => {
    const { dataRoot, domainWiki } = await makeAuditedWiki("# Decision\n");

    await expect(
      runCrosslinksStage({
        run: runFor(dataRoot),
        domains: [domainWiki],
      }),
    ).resolves.toBeDefined();
  });

  it("reports the audited link and page counts", async () => {
    const { dataRoot, domainWiki } = await makeAuditedWiki(
      "Domain background in [[engineering/stub]].",
    );

    const result: CrosslinksResult | undefined = await runCrosslinksStage({
      run: runFor(dataRoot),
      domains: [domainWiki],
    });

    expect(result).toMatchObject({
      domains: [domainWiki],
      external: 1,
      domainPages: 2,
    });
  });

  it("audits the wiki dir only, not the data repo around it", async () => {
    const { dataRoot, domainWiki } = await makeAuditedWiki("# Decision\n");

    // A stray broken cross-wiki link OUTSIDE wiki/ must stay invisible
    // to the audit: only the data repo's wiki/ is audited.
    await writeFile(
      join(dataRoot, "stray-note.md"),
      "broken: [[engineering/missing]]\n",
    );

    await expect(
      runCrosslinksStage({
        run: runFor(dataRoot),
        domains: [domainWiki],
      }),
    ).resolves.toBeDefined();
  });

  it("fails the stage naming a broken cross-wiki link", async () => {
    const { dataRoot, domainWiki } = await makeAuditedWiki(
      "Domain background in [[engineering/missing]].",
    );

    await expect(
      runCrosslinksStage({
        run: runFor(dataRoot),
        domains: [domainWiki],
      }),
    ).rejects.toThrow(/wiki\/decision\.md:\d+ -> \[\[engineering\/missing\]\]/);
  });

  it("expands a leading ~ in a configured domain dir against home", async () => {
    const { dataRoot, domainWiki } = await makeAuditedWiki("# Decision\n");

    // Inject the domain wiki's grandparent so `~/domain/wiki` names
    // the same dir the harness built. Injected, not env-mutated:
    // `os.homedir()` reads the process's C environ, which worker
    // threads (Stryker's vitest pool) do not share with `process.env`.
    const result = await runCrosslinksStage({
      run: runFor(dataRoot),
      domains: ["~/domain/wiki"],
      home: dirname(dirname(domainWiki)),
    });

    expect(result?.domains).toEqual([domainWiki]);
  });
});
