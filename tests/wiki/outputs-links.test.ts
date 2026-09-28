import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  isOutputsTarget,
  outputsFileProbe,
  outputsLinkProblem,
  outputsRelativeTarget,
} from "../../src/wiki/outputs-links.ts";

/** Unit tests for the outputs-namespace link resolver
 *  (src/wiki/outputs-links.ts, issue #414): the one classification
 *  every resolver — guardrail check 3, check-links, the dashboard
 *  KPIs, check-crosslinks — shares for `[[outputs/…]]` citations. */

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A temp root whose outputs/ directory holds the given files. */
async function makeOutputs(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "k-wiki-outputs-"));

  tempDirs.push(root);

  for (const [file, content] of Object.entries(files)) {
    await mkdir(join(root, "outputs", dirname(file)), { recursive: true });
    await writeFile(join(root, "outputs", file), content);
  }

  return root;
}

describe("isOutputsTarget", () => {
  it("accepts the outputs prefix with a page segment", () => {
    expect(isOutputsTarget("outputs/cycle-2026-09-27.md")).toBe(true);
  });

  it("rejects a bare outputs name without the slash", () => {
    expect(isOutputsTarget("outputs")).toBe(false);
  });

  it("rejects a longer name that merely starts with outputs", () => {
    expect(isOutputsTarget("outputsX")).toBe(false);
  });
});

describe("outputsRelativeTarget", () => {
  it("strips the outputs prefix from a nested path", () => {
    expect(outputsRelativeTarget("outputs/runs/a/b.md")).toBe("runs/a/b.md");
  });

  it("normalizes .. steps that stay inside the directory", () => {
    expect(outputsRelativeTarget("outputs/runs/../a.md")).toBe("a.md");
  });

  it("rejects an empty page segment", () => {
    expect(outputsRelativeTarget("outputs/")).toBeUndefined();
  });

  it("rejects a traversal escaping the directory", () => {
    expect(
      outputsRelativeTarget("outputs/../raw/manifest.json"),
    ).toBeUndefined();
  });

  it("rejects an absolute remainder", () => {
    expect(outputsRelativeTarget("outputs//etc/passwd")).toBeUndefined();
  });

  it("accepts a file name that merely begins with dots", () => {
    expect(outputsRelativeTarget("outputs/..notes.md")).toBe("..notes.md");
  });
});

describe("outputsLinkProblem", () => {
  it("classifies a citation to an existing file as resolved", async () => {
    const root = await makeOutputs({ "cycle-2026-09-27.md": "# Cycle\n" });

    expect(
      outputsLinkProblem(
        "outputs/cycle-2026-09-27.md",
        await outputsFileProbe(join(root, "outputs")),
      ),
    ).toBeUndefined();
  });

  it("classifies a citation to a missing file as missing", () => {
    expect(outputsLinkProblem("outputs/cycle-2026-09-27.md", () => false)).toBe(
      "missing",
    );
  });

  it("classifies an escaping traversal as escape before existence is asked", () => {
    expect(outputsLinkProblem("outputs/../raw/manifest.json", () => true)).toBe(
      "escape",
    );
  });
});

describe("outputsFileProbe", () => {
  it("answers true only for an existing regular file under the directory", async () => {
    const root = await makeOutputs({
      "cycle-2026-09-27.md": "# Cycle\n",
      "runs/inner.md": "# Inner\n",
    });
    const probe = await outputsFileProbe(join(root, "outputs"));

    expect(probe("cycle-2026-09-27.md")).toBe(true);
  });

  it("answers false for a wrong-case path on any filesystem", async () => {
    const root = await makeOutputs({ "cycle-2026-09-27.md": "# Cycle\n" });
    const probe = await outputsFileProbe(join(root, "outputs"));

    expect(probe("Cycle-2026-09-27.md")).toBe(false);
  });

  it("answers false for a symlink, even one naming an existing file", async () => {
    const root = await makeOutputs({ "cycle-2026-09-27.md": "# Cycle\n" });

    await symlink(
      join(root, "outputs", "cycle-2026-09-27.md"),
      join(root, "outputs", "linked.md"),
    );

    const probe = await outputsFileProbe(join(root, "outputs"));

    expect(probe("linked.md")).toBe(false);
  });

  it("answers false for a broken symlink", async () => {
    const root = await makeOutputs({ "real.md": "# Real\n" });

    await symlink(
      join(root, "outputs", "gone.md"),
      join(root, "outputs", "dangling.md"),
    );

    const probe = await outputsFileProbe(join(root, "outputs"));

    expect(probe("dangling.md")).toBe(false);
  });

  it("answers false for a path that resolves to a directory", async () => {
    const root = await makeOutputs({ "runs/inner.md": "# Inner\n" });
    const probe = await outputsFileProbe(join(root, "outputs"));

    expect(probe("runs")).toBe(false);
  });

  it("answers false when the directory itself is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "k-wiki-outputs-"));

    tempDirs.push(root);

    const probe = await outputsFileProbe(join(root, "outputs"));

    expect(probe("a.md")).toBe(false);
  });
});
