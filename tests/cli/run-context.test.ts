import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runContext } from "../../src/cli/run-context.ts";

const RAW_DIR = join("repo", "data", "raw");

describe("runContext", () => {
  it("derives the data root as the raw dir's parent", () => {
    expect(runContext({ rawDir: RAW_DIR }).dataRoot).toBe(dirname(RAW_DIR));
  });

  it("derives the wiki dir as the data root's wiki/", () => {
    expect(runContext({ rawDir: RAW_DIR }).wikiDir).toBe(
      join(dirname(RAW_DIR), "wiki"),
    );
  });

  it("keeps the raw dir it was given", () => {
    expect(runContext({ rawDir: RAW_DIR }).rawDir).toBe(RAW_DIR);
  });

  it("defaults env to the process environment", () => {
    expect(runContext({ rawDir: RAW_DIR }).env).toBe(process.env);
  });

  it("defaults now to a clock that advances", () => {
    const { now } = runContext({ rawDir: RAW_DIR });

    expect(now().getTime()).toBeGreaterThanOrEqual(Date.now() - 1000);
  });

  it("defaults onProgress to a sink that stays silent", () => {
    const { onProgress } = runContext({ rawDir: RAW_DIR });

    expect(() => onProgress("anything")).not.toThrow();
  });

  it("keeps an explicitly passed environment", () => {
    const env: NodeJS.ProcessEnv = { CUSTOM: "yes" };

    expect(runContext({ rawDir: RAW_DIR, env }).env).toBe(env);
  });

  it("keeps an explicitly passed clock", () => {
    const fixed = new Date("2026-08-20T18:00:00.000Z");

    expect(runContext({ rawDir: RAW_DIR, now: () => fixed }).now()).toBe(fixed);
  });

  it("keeps an explicitly passed progress sink", () => {
    const heard: string[] = [];
    const { onProgress } = runContext({
      rawDir: RAW_DIR,
      onProgress: (message) => heard.push(message),
    });

    onProgress("one");

    expect(heard).toEqual(["one"]);
  });
});
