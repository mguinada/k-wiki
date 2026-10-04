import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../../src/query/wiki-promote.ts";

describe("wiki-promote main", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints the promote usage", async () => {
    const logged: string[] = [];

    vi.spyOn(console, "log").mockImplementation((line: string) => {
      logged.push(line);
    });

    vi.spyOn(console, "error").mockImplementation(() => {});

    await main(["--help"]);

    expect(logged.join("\n")).toContain("Usage: wiki-promote");
  });

  it("documents --sources in the help", async () => {
    const logged: string[] = [];

    vi.spyOn(console, "log").mockImplementation((line: string) => {
      logged.push(line);
    });

    vi.spyOn(console, "error").mockImplementation(() => {});

    await main(["--help"]);

    expect(logged.join("\n")).toContain("--sources");
  });

  it("prints help without an error", async () => {
    const logged: string[] = [];

    vi.spyOn(console, "log").mockImplementation((line: string) => {
      logged.push(line);
    });

    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await main(["--help"]);

    expect(error).not.toHaveBeenCalled();
  });

  it("exits 0", async () => {
    const logged: string[] = [];

    vi.spyOn(console, "log").mockImplementation((line: string) => {
      logged.push(line);
    });

    vi.spyOn(console, "error").mockImplementation(() => {});

    await main(["--help"]);

    expect(process.exitCode).toBeUndefined();
  });

  it("reports a missing slug on stderr", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await main(["--sources", "rag-notes"]);

    expect(error.mock.calls.at(-1)?.[0]).toContain("a slug is required");

    process.exitCode = 0;
  });

  it("exits 1", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    await main(["--sources", "rag-notes"]);

    expect(process.exitCode).toBe(1);

    process.exitCode = 0;
  });

  it("reports missing sources on stderr", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await main(["attention-notes"]);

    expect(error.mock.calls.at(-1)?.[0]).toContain("at least one --sources");

    process.exitCode = 0;
  });

  it("exits 1", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    await main(["attention-notes"]);

    expect(process.exitCode).toBe(1);

    process.exitCode = 0;
  });
});
