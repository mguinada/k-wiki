import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isMainModule } from "../src/cli/is-main.ts";

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
