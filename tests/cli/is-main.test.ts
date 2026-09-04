import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refuseDirectExecution } from "../../src/cli/is-main.ts";

const originalArgv1 = process.argv[1];

/**
 * Issue #135: src/ and scripts/ modules are libraries; their only
 * entry path is a shebanged launcher — `bin/<name>` (extensionless,
 * issue #156) for the wiki
 * runtime, `dev/<name>.ts` for development-lifecycle commands
 * (issue #253). Executed directly, a library module must fail loudly
 * — refusal message naming the launcher, exit 1 — and never invoke
 * main() (issue #123's hazard class, eliminated by construction).
 */

function setArgv1(value: string | undefined) {
  if (value === undefined) {
    process.argv.splice(1, 1);

    return;
  }

  process.argv[1] = value;
}

afterEach(() => {
  setArgv1(originalArgv1);
  vi.restoreAllMocks();
});

describe("refuseDirectExecution", () => {
  it("prints the library-module refusal naming the launcher when the module is executed directly", () => {
    setArgv1("/tmp/some-entry.ts");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    refuseDirectExecution(
      pathToFileURL("/tmp/some-entry.ts").href,
      "sync-vault",
    );

    expect(error.mock.calls[0]?.[0]).toBe(
      "library module — run bin/sync-vault",
    );
  });

  it("names the dev/ launcher directory when the module passes one", () => {
    setArgv1("/tmp/some-entry.ts");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    refuseDirectExecution(
      pathToFileURL("/tmp/some-entry.ts").href,
      "mutation-chunk",
      "dev",
    );

    expect(error.mock.calls[0]?.[0]).toBe(
      "library module — run dev/mutation-chunk",
    );
  });

  it("exits 1 when the module is executed directly", () => {
    setArgv1("/tmp/some-entry.ts");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    refuseDirectExecution(
      pathToFileURL("/tmp/some-entry.ts").href,
      "sync-vault",
    );

    expect(exit).toHaveBeenCalledWith(1);
  });

  it("stays silent when argv[1] is a different module", () => {
    setArgv1("/tmp/some-entry.ts");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    refuseDirectExecution(
      pathToFileURL("/tmp/other-module.ts").href,
      "sync-vault",
    );

    expect(`${error.mock.calls.length}${exit.mock.calls.length}`).toBe("00");
  });

  it("stays silent when argv[1] is undefined", () => {
    setArgv1(undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    refuseDirectExecution(
      pathToFileURL("/tmp/some-entry.ts").href,
      "sync-vault",
    );

    expect(`${error.mock.calls.length}${exit.mock.calls.length}`).toBe("00");
  });
});
