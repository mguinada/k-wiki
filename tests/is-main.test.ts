import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isMainModule } from "../src/cli/is-main.ts";

const originalArgv1 = process.argv[1];

function setArgv1(value: string | undefined) {
  if (value === undefined) {
    process.argv.splice(1, 1);

    return;
  }

  process.argv[1] = value;
}

afterEach(() => {
  setArgv1(originalArgv1);
});

describe("isMainModule", () => {
  it("returns true when the module URL matches the executed script", () => {
    setArgv1("/tmp/some-entry.ts");

    expect(isMainModule(pathToFileURL("/tmp/some-entry.ts").href)).toBe(true);
  });

  it("returns false when the module URL differs from the executed script", () => {
    setArgv1("/tmp/some-entry.ts");

    expect(isMainModule(pathToFileURL("/tmp/other-module.ts").href)).toBe(
      false,
    );
  });

  it("returns false when argv[1] is undefined", () => {
    setArgv1(undefined);

    expect(isMainModule(pathToFileURL("/tmp/some-entry.ts").href)).toBe(false);
  });
});
