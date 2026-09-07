import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  agentVerbUsageError,
  runAgentVerbs,
} from "../../src/cli/agent-verbs.ts";
import type { CheckoutResolution } from "../../src/cli/k-wiki-binding.ts";

/**
 * The agent-verb runner (issue #337's split of the read verbs out
 * of the dispatcher): parse one read verb's argv, resolve the
 * instance with the explicit -w/--wiki flag beating the binding's
 * wiki key (decision 12), and run the verb.
 */

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

/** A minimal checkout: root sync.json → one data repo, meta alias. */
async function makeCheckout(): Promise<string> {
  const dataRoot = await mkdtemp(join(tmpdir(), "agent-verbs-data-"));

  tempDirs.push(dataRoot);
  await mkdir(join(dataRoot, "wiki"), { recursive: true });
  await mkdir(join(dataRoot, "raw"), { recursive: true });
  await writeFile(join(dataRoot, "wiki", "index.md"), "# Index\n");

  const checkout = await mkdtemp(join(tmpdir(), "agent-verbs-co-"));

  tempDirs.push(checkout);
  await writeFile(
    join(checkout, "sync.json"),
    JSON.stringify({
      vaults: [],
      dataRoot,
      instances: { meta: "sync-meta.json" },
    }),
  );
  await writeFile(
    join(checkout, "sync-meta.json"),
    JSON.stringify({ vaults: [], dataRoot }),
  );

  return checkout;
}

/** A binding-file resolution for `checkout`, with optional wiki key. */
function resolution(
  checkout: string,
  wiki: string | undefined,
): CheckoutResolution {
  return {
    checkout,
    settings: undefined,
    wiki,
    origin: "file",
  };
}

/** Run one read verb in-process against a resolution, capturing
 *  the console. */
async function runVerb(
  verb: string,
  args: readonly string[],
  resolved: CheckoutResolution,
  home: string,
): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];

  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...parts: unknown[]) => out.push(parts.join(" ")));
  const errorSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...parts: unknown[]) => err.push(parts.join(" ")));

  try {
    await runAgentVerbs(verb, args, { resolution: resolved, home });
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }

  return { out: out.join("\n"), err: err.join("\n") };
}

describe("agentVerbUsageError", () => {
  it("requires a question for query", () => {
    expect(agentVerbUsageError("query", [])).toContain(
      "a question is required",
    );
  });

  it("rejects two arguments to read", () => {
    expect(agentVerbUsageError("read", ["a", "b"])).toContain(
      "exactly one <slug>",
    );
  });

  it("rejects arguments to status", () => {
    expect(agentVerbUsageError("status", ["x"])).toContain(
      "takes no arguments",
    );
  });

  it("accepts one type for list", () => {
    expect(agentVerbUsageError("list", ["concept"])).toBeUndefined();
  });

  it("accepts one slug for read", () => {
    expect(agentVerbUsageError("read", ["rag"])).toBeUndefined();
  });
});

describe("runAgentVerbs with -w/--wiki", () => {
  it("lets the explicit flag beat the binding's wiki key", async () => {
    const checkout = await makeCheckout();
    const { out } = await runVerb(
      "status",
      ["-w", "meta"],
      resolution(checkout, undefined),
      tmpdir(),
    );

    expect(out).toContain("instance:    meta");
  });

  it("resolves the binding's wiki key when no flag is passed", async () => {
    const checkout = await makeCheckout();
    const { out } = await runVerb(
      "status",
      [],
      resolution(checkout, "meta"),
      tmpdir(),
    );

    expect(out).toContain("instance:    meta");
  });

  it("names the --wiki flag as the source for an unknown name", async () => {
    const checkout = await makeCheckout();
    const { err } = await runVerb(
      "status",
      ["--wiki", "nope"],
      resolution(checkout, undefined),
      tmpdir(),
    );

    expect(err).toContain("(from the --wiki flag)");
  });

  it("names the binding file as the source for an unknown key", async () => {
    const checkout = await makeCheckout();
    const { err } = await runVerb(
      "status",
      [],
      resolution(checkout, "nope"),
      tmpdir(),
    );

    expect(err).toContain("(from .k-wiki.json)");
  });

  it("rejects a valueless -w flag", async () => {
    const checkout = await makeCheckout();
    const { err } = await runVerb(
      "status",
      ["-w"],
      resolution(checkout, undefined),
      tmpdir(),
    );

    expect(err).toContain("--wiki needs a name value");
  });

  it("resolves the default instance without flag or key", async () => {
    const checkout = await makeCheckout();
    const { out } = await runVerb(
      "status",
      [],
      resolution(checkout, undefined),
      tmpdir(),
    );

    expect(out).toContain("instance:    default");
  });
});
