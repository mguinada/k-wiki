import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { main as backfillOriginMain } from "../scripts/backfill-origin.ts";
import { main as checkCrosslinksMain } from "../scripts/check-crosslinks.ts";
import { main as checkLinksMain } from "../scripts/check-links.ts";
import { main as checkProvenanceMain } from "../scripts/check-provenance.ts";
import { isMainModule, refuseTestWorker } from "../src/cli/is-main.ts";
import { main as initDataRepoMain } from "../src/data/init-data-repo.ts";
import { main as generateMain } from "../src/fixtures/generate.ts";
import { main as checkRawMain } from "../src/health/check-raw.ts";
import { main as wikiIngestMain } from "../src/ingest/wiki-ingest.ts";
import { main as wikiQueryMain } from "../src/query/wiki-query.ts";
import { main as syncRepoMain } from "../src/sync/sync-repo.ts";
import { main as syncVaultMain } from "../src/sync/sync-vault.ts";
import { main as wikiSyncMain } from "../src/sync/wiki-sync.ts";

const originalArgv1 = process.argv[1];
const originalMarker = readTestWorkerMarker();

/**
 * The vitest setup file (tests/setup.ts) sets this globalThis flag in every
 * test worker so `isMainModule` can refuse to run `main()` there (issue
 * #123: a mutated import guard must never fire a CLI against live state).
 * The key is duplicated here on purpose — a shared const would make a
 * mutated key an equivalent (self-consistent) mutant.
 */
type TestWorkerGlobals = { __kWikiTestWorker__?: boolean | undefined };

function readTestWorkerMarker(): boolean | undefined {
  return (globalThis as TestWorkerGlobals).__kWikiTestWorker__;
}

function setTestWorkerMarker(value: boolean | undefined) {
  (globalThis as TestWorkerGlobals).__kWikiTestWorker__ = value;
}

function setArgv1(value: string | undefined) {
  if (value === undefined) {
    process.argv.splice(1, 1);

    return;
  }

  process.argv[1] = value;
}

afterEach(() => {
  setArgv1(originalArgv1);
  setTestWorkerMarker(originalMarker);
});

describe("isMainModule", () => {
  it("returns true when the module URL matches the executed script", () => {
    setTestWorkerMarker(undefined);
    setArgv1("/tmp/some-entry.ts");

    expect(isMainModule(pathToFileURL("/tmp/some-entry.ts").href)).toBe(true);
  });

  it("returns false when the module URL differs from the executed script", () => {
    setTestWorkerMarker(undefined);
    setArgv1("/tmp/some-entry.ts");

    expect(isMainModule(pathToFileURL("/tmp/other-module.ts").href)).toBe(
      false,
    );
  });

  it("returns false when argv[1] is undefined", () => {
    setTestWorkerMarker(undefined);
    setArgv1(undefined);

    expect(isMainModule(pathToFileURL("/tmp/some-entry.ts").href)).toBe(false);
  });

  it("returns false inside a test worker even when the module URL matches the executed script", () => {
    setTestWorkerMarker(true);
    setArgv1("/tmp/some-entry.ts");

    expect(isMainModule(pathToFileURL("/tmp/some-entry.ts").href)).toBe(false);
  });

  it("the vitest setup file marks this worker as a test worker", () => {
    expect(originalMarker).toBe(true);
  });
});

describe("refuseTestWorker", () => {
  it("throws inside a test worker", () => {
    setTestWorkerMarker(true);

    expect(() => refuseTestWorker("cli")).toThrow(
      "cli: refusing to run inside a test worker",
    );
  });

  it("does not throw outside a test worker", () => {
    setTestWorkerMarker(undefined);

    expect(() => refuseTestWorker("cli")).not.toThrow();
  });
});

describe("CLI mains refuse to run inside a test worker", () => {
  it("sync-repo main() fails loudly before resolving any default", async () => {
    await expect(syncRepoMain()).rejects.toThrow(
      "sync-repo: refusing to run inside a test worker",
    );
  });

  it("wiki-ingest main() fails loudly before resolving any default", async () => {
    await expect(wikiIngestMain()).rejects.toThrow(
      "wiki-ingest: refusing to run inside a test worker",
    );
  });

  it("sync-vault main() fails loudly before resolving any default", async () => {
    await expect(syncVaultMain()).rejects.toThrow(
      "sync-vault: refusing to run inside a test worker",
    );
  });

  it("data:init main() fails loudly before resolving any default", async () => {
    await expect(initDataRepoMain()).rejects.toThrow(
      "data:init: refusing to run inside a test worker",
    );
  });

  it("wiki-sync main() fails loudly before resolving any default", async () => {
    await expect(wikiSyncMain()).rejects.toThrow(
      "wiki-sync: refusing to run inside a test worker",
    );
  });

  it("wiki-query main() fails loudly before resolving any default", async () => {
    await expect(wikiQueryMain()).rejects.toThrow(
      "wiki-query: refusing to run inside a test worker",
    );
  });

  it("check-raw main() fails loudly before resolving any default", async () => {
    await expect(checkRawMain()).rejects.toThrow(
      "check-raw: refusing to run inside a test worker",
    );
  });

  it("generate main() fails loudly before resolving any default", async () => {
    await expect(generateMain()).rejects.toThrow(
      "generate: refusing to run inside a test worker",
    );
  });

  it("backfill-origin main() fails loudly before resolving any default", async () => {
    await expect(backfillOriginMain()).rejects.toThrow(
      "backfill-origin: refusing to run inside a test worker",
    );
  });

  it("check-links main() fails loudly before resolving any default", async () => {
    await expect(checkLinksMain()).rejects.toThrow(
      "check-links: refusing to run inside a test worker",
    );
  });

  it("check-provenance main() fails loudly before resolving any default", async () => {
    await expect(checkProvenanceMain()).rejects.toThrow(
      "check-provenance: refusing to run inside a test worker",
    );
  });

  it("check-crosslinks main() fails loudly before resolving any default", async () => {
    await expect(checkCrosslinksMain()).rejects.toThrow(
      "check-crosslinks: refusing to run inside a test worker",
    );
  });
});
