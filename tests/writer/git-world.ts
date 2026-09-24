/**
 * Shared git test harness for the writer-domain modules: a temp
 * remote (bare) plus one or two work clones, wired with a first
 * commit — the two-writer topology of the issue's required e2e
 * scenarios, at unit speed. Returns dir-bound real-git runners.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type GitHost, gitRunnerFor } from "../../src/writer/git-remote.ts";

const run = promisify(execFile);

export interface TempRepo {
  readonly dir: string;
  readonly git: ReturnType<typeof gitRunnerFor>;
}

export interface WriterWorld {
  readonly remoteDir: string;
  readonly a: TempRepo;
  readonly b: TempRepo;
  readonly cleanup: () => Promise<void>;
}

/** The git commands every clone needs to commit identically. */
async function initClone(dir: string, remote: string): Promise<TempRepo> {
  await mkdir(dir, { recursive: true });
  await run("git", ["init", "--quiet", "--initial-branch=main"], { cwd: dir });
  await run("git", ["config", "user.email", "t@t"], { cwd: dir });
  await run("git", ["config", "user.name", "t"], { cwd: dir });
  await run("git", ["remote", "add", "origin", remote], { cwd: dir });

  return { dir, git: gitRunnerFor({ dir, env: process.env }) };
}

/** One bare remote plus two clones sharing an initial commit on
 *  `main`. The default branch is pinned so git's init default never
 *  changes the shape. */
export async function makeWriterWorld(): Promise<WriterWorld> {
  const root = await mkdtemp(join(tmpdir(), "writer-"));
  const remoteDir = join(root, "remote.git");
  const dirA = join(root, "writer-a");
  const dirB = join(root, "writer-b");

  await run("git", [
    "init",
    "--bare",
    "--initial-branch=main",
    "--quiet",
    remoteDir,
  ]);
  const a = await initClone(dirA, remoteDir);
  const b = await initClone(dirB, remoteDir);

  await writeFile(join(dirA, "seed.txt"), "seed\n");
  await a.git(["add", "-A"]);
  await a.git(["commit", "-m", "init"]);
  await a.git(["push", "-q", "origin", "refs/heads/main:refs/heads/main"]);
  await b.git(["fetch", "-q", "origin", "main"]);
  await b.git(["checkout", "-q", "-b", "main", "origin/main"]);

  const cleanup = async (): Promise<void> => {
    await rm(root, { recursive: true, force: true });
  };

  return { remoteDir, a, b, cleanup };
}

/** A host for driving the bare remote directly (verifying its refs). */
export function remoteHost(remoteDir: string): GitHost {
  return { dir: remoteDir, env: process.env };
}

/** Commit one file on a clone's main and return the new HEAD OID. */
export async function commitFile(
  repo: TempRepo,
  name: string,
  body: string,
): Promise<string> {
  await writeFile(join(repo.dir, name), body);
  await repo.git(["add", "-A"]);
  await repo.git(["commit", "-m", `write ${name}`]);

  return (await repo.git(["rev-parse", "HEAD"])).stdout.trim();
}
