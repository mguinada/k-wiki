import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runContext } from "../../src/cli/run-context.ts";
import type { VaultRemovalPlan } from "../../src/sync/projection.ts";
import {
  baselineSnapshot,
  gateRemovals,
  refuseDirtyWorkingTree,
  snapshotPathFor,
  workingTreeClean,
} from "../../src/writer/cycle-steps.ts";
import { gitRunnerFor } from "../../src/writer/git-remote.ts";
import { readReceipt } from "../../src/writer/receipts.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const NOW = () => new Date("2026-01-01T00:00:00Z");

async function tempGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "steps-"));
  tempDirs.push(dir);
  const run = await import("node:child_process").then(({ execFile }) =>
    (require("node:util") as typeof import("node:util")).promisify(execFile),
  );

  await run("git", ["init", "--quiet", "--initial-branch=main"], { cwd: dir });
  await run("git", ["config", "user.email", "t@t"], { cwd: dir });
  await run("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(join(dir, "base.txt"), "base\n");
  await gitRunnerFor({ dir, env: process.env })(["add", "-A"]);
  await gitRunnerFor({ dir, env: process.env })(["commit", "-m", "init"]);

  return dir;
}

describe("refuseDirtyWorkingTree", () => {
  it("accepts a clean tree", async () => {
    const dir = await tempGitRepo();

    expect(
      await refuseDirtyWorkingTree(gitRunnerFor({ dir, env: process.env })),
    ).toBeUndefined();
  });

  it("refuses a tracked modification, naming the path", async () => {
    const dir = await tempGitRepo();

    await writeFile(join(dir, "base.txt"), "changed\n");

    const refusal = await refuseDirtyWorkingTree(
      gitRunnerFor({ dir, env: process.env }),
    );

    expect(refusal).toContain("dirty");
    expect(refusal).toContain("base.txt");
  });

  it("refuses untracked content but allows the run lock", async () => {
    const dir = await tempGitRepo();

    await writeFile(join(dir, ".scheduled-run.lock"), "{}\n");
    await writeFile(join(dir, "stray.md"), "stray\n");

    const refusal = await refuseDirtyWorkingTree(
      gitRunnerFor({ dir, env: process.env }),
    );

    expect(refusal).toContain("stray.md");
    expect(refusal).not.toContain("scheduled-run.lock");
  });
});

describe("workingTreeClean", () => {
  it("tolerates the run lock for the post-failure release decision", async () => {
    const dir = await tempGitRepo();

    await writeFile(join(dir, ".scheduled-run.lock"), "{}\n");

    expect(await workingTreeClean(dir, process.env)).toBe(true);
  });
});

describe("baselineSnapshot", () => {
  it("bootstraps the snapshot when none exists, stamped and anchored", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "baseline-"));
    tempDirs.push(dataRoot);

    await mkdir(join(dataRoot, "raw"), { recursive: true });
    await writeFile(
      join(dataRoot, "raw", "manifest.json"),
      '{"vaults": {"V": {}}}\n',
    );

    const run = runContext({ rawDir: join(dataRoot, "raw"), now: NOW });

    await baselineSnapshot({
      run,
      headOid: "a".repeat(40),
      fastForwarded: false,
    });

    const text = await readFile(snapshotPathFor(dataRoot), "utf8");
    const parsed = JSON.parse(text) as {
      snapshotFor: string;
      committedHead: string;
      vaults: Record<string, unknown>;
    };

    expect(parsed.snapshotFor).toBe(dataRoot);
    expect(parsed.committedHead).toBe("a".repeat(40));
    expect(parsed.vaults.V).toEqual({});
  });

  it("keeps an existing snapshot when the head did not move", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "baseline-"));
    tempDirs.push(dataRoot);

    await mkdir(join(dataRoot, "outputs"), { recursive: true });
    await writeFile(
      join(dataRoot, "outputs", "last-ingested-manifest.json"),
      '{"snapshotFor":"old","committedHead":"old","vaults":{}}\n',
    );

    const run = runContext({ rawDir: join(dataRoot, "raw"), now: NOW });

    await baselineSnapshot({
      run,
      headOid: "b".repeat(40),
      fastForwarded: false,
    });

    const text = await readFile(snapshotPathFor(dataRoot), "utf8");

    expect(text).toContain('"old"');
  });

  it("rewrites the snapshot after a fast-forward (the repair path)", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "baseline-"));
    tempDirs.push(dataRoot);

    await mkdir(join(dataRoot, "outputs"), { recursive: true });
    await mkdir(join(dataRoot, "raw"), { recursive: true });
    await writeFile(
      join(dataRoot, "raw", "manifest.json"),
      '{"vaults": {"V": {}}}\n',
    );
    await writeFile(
      join(dataRoot, "outputs", "last-ingested-manifest.json"),
      '{"snapshotFor":"stale","committedHead":"0000","vaults":{}}\n',
    );

    const run = runContext({ rawDir: join(dataRoot, "raw"), now: NOW });

    await baselineSnapshot({
      run,
      headOid: "c".repeat(40),
      fastForwarded: true,
    });

    const text = await readFile(snapshotPathFor(dataRoot), "utf8");

    expect(text).toContain("c".repeat(40));
    expect(text).not.toContain("stale");
  });
});

describe("gateRemovals", () => {
  const PLANS: VaultRemovalPlan[] = [
    { vault: "V", removals: ["gone.md"], renames: [] },
  ];

  it("passes when no vault plans a removal", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "gate-"));
    tempDirs.push(dataRoot);
    const run = runContext({ rawDir: join(dataRoot, "raw"), now: NOW });

    const gate = await gateRemovals({
      run,
      base: "a".repeat(40),
      plans: [{ vault: "V", removals: [], renames: [] }],
      receipt: undefined,
    });

    expect(gate.status).toBe("pass");
  });

  it("refuses without a receipt, writing one and naming the command", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "gate-"));
    tempDirs.push(dataRoot);
    const run = runContext({ rawDir: join(dataRoot, "raw"), now: NOW });

    const gate = await gateRemovals({
      run,
      base: "a".repeat(40),
      plans: PLANS,
      receipt: undefined,
    });

    if (gate.status !== "refuse") {
      throw new Error("expected a refusal");
    }

    expect(gate.reason.join("\n")).toContain("--removal-receipt");
    expect(gate.reason.join("\n")).toContain("V/gone.md");

    const receiptPath = join(dataRoot, "outputs/shared-writer-receipt.json");
    const receipt = await readReceipt(receiptPath);

    expect(receipt.plans).toEqual(PLANS);
  });

  it("passes with a matching receipt and refuses a stale base", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "gate-"));
    tempDirs.push(dataRoot);
    const run = runContext({ rawDir: join(dataRoot, "raw"), now: NOW });
    const base = "a".repeat(40);
    const receiptPath = join(dataRoot, "receipt.json");

    const { buildReceipt, writeReceipt } = await import(
      "../../src/writer/receipts.ts"
    );
    const path = await writeReceipt(dataRoot, buildReceipt(base, PLANS));

    const ok = await gateRemovals({
      run,
      base,
      plans: PLANS,
      receipt: await readReceipt(path),
    });

    expect(ok.status).toBe("pass");

    await writeFile(receiptPath, "unused");
    const stale = await gateRemovals({
      run,
      base: "b".repeat(40),
      plans: PLANS,
      receipt: await readReceipt(path),
    });

    expect(stale).toMatchObject({ status: "refuse" });
  });
});
