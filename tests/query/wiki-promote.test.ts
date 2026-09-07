import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../../src/query/wiki-promote.ts";

describe("wiki-promote main", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints help and exits clean for --help", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      logged.push(line);
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await main(["--help"]);

    expect(logged.join("\n")).toContain("Usage: wiki-promote");
    expect(logged.join("\n")).toContain("--sources");
    expect(error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("fails with a usage error when the slug is missing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await main(["--sources", "rag-notes"]);

    expect(error.mock.calls.at(-1)?.[0]).toContain("a slug is required");
    expect(process.exitCode).toBe(1);

    process.exitCode = 0;
  });

  it("fails with a usage error when no sources were supplied", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await main(["attention-notes"]);

    expect(error.mock.calls.at(-1)?.[0]).toContain("at least one --sources");
    expect(process.exitCode).toBe(1);

    process.exitCode = 0;
  });
});
