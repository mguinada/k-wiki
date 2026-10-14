import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { terminalColors } from "../../src/cli/colors.ts";
import { gitRunnerFor } from "../../src/writer/git-remote.ts";
import {
  fetchHeadState,
  type MaintenanceObservation,
  maintenanceLine,
} from "../../src/writer/maintenance-log.ts";

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const DIM = (text: string): string => terminalColors(process.env).dim(text);
const NO_COLOR_DIM = (text: string): string => {
  void terminalColors;

  return text;
};

const OBS: MaintenanceObservation = {
  verb: "renew",
  ref: "refs/k-wiki/leases/shared-writer-v1",
  oid: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
  treeRead: "ok",
  durationMs: 12.34,
};

describe("maintenanceLine", () => {
  it("renders the maintenance verb", () => {
    expect(
      maintenanceLine({
        obs: OBS,
        fetchHead: { exists: true, size: 137 },
        dim: (text) => terminalColors(process.env).dim(text),
      }),
    ).toContain("lease maintenance renew");
  });

  it("names the lease ref", () => {
    expect(
      maintenanceLine({
        obs: OBS,
        fetchHead: { exists: true, size: 137 },
        dim: (text) => terminalColors(process.env).dim(text),
      }),
    ).toContain("ref refs/k-wiki/leases/shared-writer-v1");
  });

  it("renders the own OID short", () => {
    expect(
      maintenanceLine({
        obs: OBS,
        fetchHead: { exists: true, size: 137 },
        dim: (text) => terminalColors(process.env).dim(text),
      }),
    ).toContain("own 1a2b3c4d");
  });

  it("reports the tree-read exit status", () => {
    expect(
      maintenanceLine({
        obs: OBS,
        fetchHead: { exists: true, size: 137 },
        dim: (text) => terminalColors(process.env).dim(text),
      }),
    ).toContain("tree read ok");
  });

  it("bounds the step duration", () => {
    expect(
      maintenanceLine({
        obs: OBS,
        fetchHead: { exists: true, size: 137 },
        dim: (text) => terminalColors(process.env).dim(text),
      }),
    ).toContain("dur 12ms");
  });

  it("renders the fetch-head state as {exists, size} only", () => {
    expect(
      maintenanceLine({
        obs: OBS,
        fetchHead: { exists: true, size: 137 },
        dim: (text) => terminalColors(process.env).dim(text),
      }),
    ).toContain("FETCH_HEAD {exists: true, size: 137}");
  });

  it("renders colored when no NO_COLOR is set", () => {
    expect(
      maintenanceLine({
        obs: OBS,
        fetchHead: { exists: false, size: 0 },
        dim: (text) => terminalColors({}).dim(text),
      }),
    ).toContain("\u001b[");
  });

  it("renders plain text under NO_COLOR", () => {
    const plain = maintenanceLine({
      obs: OBS,
      fetchHead: { exists: false, size: 0 },
      dim: NO_COLOR_DIM,
    });

    expect(plain).not.toContain("\u001b[");
  });

  it("marks a degraded tree read", () => {
    const line = maintenanceLine({
      obs: { ...OBS, treeRead: "degraded" },
      fetchHead: { exists: false, size: 0 },
      dim: DIM,
    });

    expect(line).toContain("tree read degraded");
  });

  it("carries no credential or child-stderr material", () => {
    expect(
      maintenanceLine({
        obs: OBS,
        fetchHead: { exists: false, size: 0 },
        dim: (text) => terminalColors(process.env).dim(text),
      }),
    ).not.toMatch(/token|credential|fatal/i);
  });
});

describe("fetchHeadState in a real git repo", () => {
  async function seededRepo(): Promise<ReturnType<typeof gitRunnerFor>> {
    const dir = await mkdtemp(join(tmpdir(), "maint-log-"));

    tempDirs.push(dir);

    const git = gitRunnerFor({ dir, env: process.env });

    await git(["init", "--quiet"]);
    await git(["config", "user.email", "t@t"]);
    await git(["config", "user.name", "t"]);
    await git(["commit", "--allow-empty", "--quiet", "-m", "seed"]);
    await git(["fetch", "--quiet", "."]);

    return git;
  }

  it("reports exists and size of the populated shared fetch-head file", async () => {
    const git = await seededRepo();
    const state = await fetchHeadState(git);

    expect(state.exists).toBe(true);
  });

  it("reports the populated file's byte size", async () => {
    const git = await seededRepo();
    const state = await fetchHeadState(git);

    expect(state.size).toBeGreaterThan(0);
  });

  it("reports a zero-sized present file without throwing", async () => {
    const git = await seededRepo();
    const gitDir = (
      await git(["rev-parse", "--absolute-git-dir"])
    ).stdout.trim();

    await writeFile(join(gitDir, "FETCH_HEAD"), "");

    const path = join(gitDir, "FETCH_HEAD");

    expect((await stat(path)).size).toBe(0);
  });

  it("reports a zero-size for the emptied file", async () => {
    const git = await seededRepo();
    const gitDir = (
      await git(["rev-parse", "--absolute-git-dir"])
    ).stdout.trim();

    await writeFile(join(gitDir, "FETCH_HEAD"), "");

    expect(await fetchHeadState(git)).toEqual({ exists: true, size: 0 });
  });

  it("fails into the absent state when the file is missing", async () => {
    const git = await seededRepo();
    const gitDir = (
      await git(["rev-parse", "--absolute-git-dir"])
    ).stdout.trim();

    await rm(join(gitDir, "FETCH_HEAD"), { force: true });

    expect(await fetchHeadState(git)).toEqual({ exists: false, size: 0 });
  });

  it("fails into the absent state when git is not a repository", async () => {
    const failing: Parameters<typeof fetchHeadState>[0] = async () => {
      throw new Error("no git here");
    };

    expect(await fetchHeadState(failing)).toEqual({ exists: false, size: 0 });
  });
});
