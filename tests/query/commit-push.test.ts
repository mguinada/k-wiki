import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
  commitFiling,
  confirmPush,
  pushFiledCommit,
  queryCommitMessage,
} from "../../src/query/commit-push.ts";
import { gitRunnerFor, lsRemoteOid } from "../../src/writer/git-remote.ts";
import { acquireLease, fetchedTreeOid } from "../../src/writer/lease-ops.ts";
import { LEASE_REF_NAMESPACE } from "../../src/writer/marker.ts";

const run = promisify(execFile);

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** One bare stub remote on main. */
async function makeBareRemote(root: string): Promise<string> {
  const remoteDir = join(root, "remote.git");

  await run("git", [
    "init",
    "--bare",
    "--initial-branch=main",
    "-q",
    remoteDir,
  ]);

  return remoteDir;
}

/** One committed data repo (wiki only) with persistent identity. */
async function makeDataRepo(root: string, name: string): Promise<string> {
  const dataRoot = join(root, name);

  await mkdir(join(dataRoot, "wiki"), { recursive: true });
  await writeFile(join(dataRoot, "wiki", "index.md"), "# Wiki Index\n");
  await writeFile(join(dataRoot, "wiki", "log.md"), "# Wiki Log\n");

  await run("git", ["init", "-q", "--initial-branch=main"], { cwd: dataRoot });
  await run("git", ["config", "user.email", "t@t"], { cwd: dataRoot });
  await run("git", ["config", "user.name", "t"], { cwd: dataRoot });
  await run("git", ["add", "-A"], { cwd: dataRoot });
  await run("git", ["commit", "-q", "-m", "init"], { cwd: dataRoot });

  return dataRoot;
}

/** Wire the marker and the origin remote, then push main. */
async function enableSharedWriter(
  dataRoot: string,
  remoteDir: string,
): Promise<void> {
  await run("git", ["remote", "add", "origin", remoteDir], { cwd: dataRoot });
  await mkdir(join(dataRoot, ".k-wiki"), { recursive: true });
  await writeFile(
    join(dataRoot, ".k-wiki", "shared-writer.json"),
    `${JSON.stringify(
      {
        version: 1,
        remote: "origin",
        branch: "main",
        leaseRef: "refs/k-wiki/leases/data",
        sourceRemovalPolicy: "confirm",
      },
      null,
      2,
    )}\n`,
  );
  await run("git", ["add", "-A"], { cwd: dataRoot });
  await run("git", ["commit", "-q", "-m", "marker"], { cwd: dataRoot });
  await run("git", ["push", "-q", "origin", "main"], { cwd: dataRoot });
}

/** A shared-writer data repo with a fresh filed commit on top. */
async function makeSharedRepo(
  options: { queryArtifactIgnored?: boolean } = {},
): Promise<{
  readonly root: string;
  readonly dataRoot: string;
  readonly remoteDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "k-wiki-commit-push-"));

  tempDirs.push(root);

  const remoteDir = await makeBareRemote(root);
  const dataRoot = await makeDataRepo(root, "data");

  if (options.queryArtifactIgnored === true) {
    await writeFile(join(dataRoot, ".gitignore"), "outputs/last-query.md\n");
    await run("git", ["add", ".gitignore"], { cwd: dataRoot });
    await run("git", ["commit", "-q", "-m", "seed ignore"], { cwd: dataRoot });
  }

  await enableSharedWriter(dataRoot, remoteDir);

  await mkdir(join(dataRoot, "wiki", "queries"), { recursive: true });
  await writeFile(
    join(dataRoot, "wiki", "queries", "rag.md"),
    "---\ntype: query\n---\nRAG\n",
  );
  await run("git", ["add", "-A"], { cwd: dataRoot });
  await run(
    "git",
    ["commit", "-q", "-m", queryCommitMessage("rag"), "--", "wiki"],
    { cwd: dataRoot },
  );

  return { root, dataRoot, remoteDir };
}

/** The remote main OID, or undefined when the branch is absent. */
async function remoteMain(remoteDir: string): Promise<string | undefined> {
  const git = gitRunnerFor({ dir: remoteDir, env: process.env });

  return await lsRemoteOid(git, ".", "refs/heads/main");
}

describe("queryCommitMessage", () => {
  it("pins the forward-only convention", () => {
    expect(queryCommitMessage("rag-vs-fine-tuning")).toBe(
      "query: file rag-vs-fine-tuning",
    );
  });
});

describe("commitFiling", () => {
  it("commits exactly the three filed paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "k-wiki-commit-push-"));

    tempDirs.push(root);

    const dataRoot = await makeDataRepo(root, "data");
    const pagePath = "wiki/queries/rag.md";

    await mkdir(join(dataRoot, "wiki", "queries"), { recursive: true });
    await writeFile(join(dataRoot, pagePath), "---\ntype: query\n---\nRAG\n");
    await writeFile(join(dataRoot, "wiki", "index.md"), "# Index\n- entry\n");
    await writeFile(
      join(dataRoot, "wiki", "log.md"),
      "# Wiki Log\n## [2026-08-21] query | Q\n",
    );

    const oid = await commitFiling({
      dataRoot,
      pagePath,
      slug: "rag",
      env: process.env,
    });
    const { stdout } = await run(
      "git",
      ["show", "--name-only", "--format=", oid],
      { cwd: dataRoot },
    );

    expect(stdout.trim().split("\n")).toEqual([
      "wiki/index.md",
      "wiki/log.md",
      pagePath,
    ]);
  });

  it("leaves unrelated dirt out of the filing commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "k-wiki-commit-push-"));

    tempDirs.push(root);

    const dataRoot = await makeDataRepo(root, "data");
    const pagePath = "wiki/queries/rag.md";

    await mkdir(join(dataRoot, "wiki", "queries"), { recursive: true });
    await writeFile(join(dataRoot, pagePath), "---\ntype: query\n---\nRAG\n");
    await writeFile(join(dataRoot, "wiki", "unrelated.md"), "dirt\n");

    await commitFiling({
      dataRoot,
      pagePath,
      slug: "rag",
      env: process.env,
    });

    const { stdout } = await run("git", ["status", "--porcelain", "-uall"], {
      cwd: dataRoot,
    });

    expect(stdout.trim()).toBe("?? wiki/unrelated.md");
  });

  it("returns the commit carrying the pinned message", async () => {
    const root = await mkdtemp(join(tmpdir(), "k-wiki-commit-push-"));

    tempDirs.push(root);

    const dataRoot = await makeDataRepo(root, "data");
    const pagePath = "wiki/queries/rag.md";

    await mkdir(join(dataRoot, "wiki", "queries"), { recursive: true });
    await writeFile(join(dataRoot, pagePath), "---\ntype: query\n---\nRAG\n");

    const oid = await commitFiling({
      dataRoot,
      pagePath,
      slug: "rag",
      env: process.env,
    });
    const { stdout } = await run("git", ["log", "-1", "--format=%s"], {
      cwd: dataRoot,
    });

    expect(`${oid} ${stdout.trim()}`).toBe(
      `${oid} ${queryCommitMessage("rag")}`,
    );
  });
});

describe("confirmPush", () => {
  function io(answer: string | undefined, isTTY = true) {
    const input = new PassThrough();
    const output = new PassThrough();

    if (answer !== undefined) {
      input.write(answer);
    }

    input.end();

    return { input, output, isTTY };
  }

  it("answers yes to y", async () => {
    expect(await confirmPush(io("y\n"))).toBe(true);
  });

  it("answers yes to yes", async () => {
    expect(await confirmPush(io("yes\n"))).toBe(true);
  });

  it("defaults to no on a bare enter", async () => {
    expect(await confirmPush(io("\n"))).toBe(false);
  });

  it("answers no to n", async () => {
    expect(await confirmPush(io("n\n"))).toBe(false);
  });

  it("treats stdin EOF at the ask as no", async () => {
    expect(await confirmPush(io(undefined))).toBe(false);
  });

  it("defaults to no without a terminal", async () => {
    expect(await confirmPush(io("", false))).toBe(false);
  });
});

describe("pushFiledCommit", () => {
  it("fast-forwards the remote and releases the lease", async () => {
    const { dataRoot, remoteDir } = await makeSharedRepo();

    await pushFiledCommit({ dataRoot, env: process.env });

    const head = (
      await run("git", ["rev-parse", "HEAD"], { cwd: dataRoot })
    ).stdout.trim();

    expect(await remoteMain(remoteDir)).toBe(head);
  });

  it("leaves no lease behind after the push", async () => {
    const { dataRoot } = await makeSharedRepo();

    await pushFiledCommit({ dataRoot, env: process.env });

    const git = gitRunnerFor({ dir: dataRoot, env: process.env });

    expect(
      await lsRemoteOid(git, "origin", `${LEASE_REF_NAMESPACE}data`),
    ).toBeUndefined();
  });

  it("refuses a remote that moved since the filing commit", async () => {
    const { dataRoot, remoteDir } = await makeSharedRepo();
    const moved = await mkdtemp(join(tmpdir(), "k-wiki-moved-"));

    tempDirs.push(moved);

    await run("git", ["clone", "-q", remoteDir, moved]);
    await run("git", ["config", "user.email", "t@t"], { cwd: moved });
    await run("git", ["config", "user.name", "t"], { cwd: moved });
    await writeFile(join(moved, "wiki", "other.md"), "moved\n");
    await run("git", ["add", "-A"], { cwd: moved });
    await run("git", ["commit", "-q", "-m", "moved"], { cwd: moved });
    await run("git", ["push", "-q", "origin", "main"], { cwd: moved });

    await expect(
      pushFiledCommit({ dataRoot, env: process.env }),
    ).rejects.toThrow("non-fast-forward");
  });

  it("leaves the remote untouched when refusing the moved remote", async () => {
    const { dataRoot, remoteDir } = await makeSharedRepo();
    const moved = await mkdtemp(join(tmpdir(), "k-wiki-moved-"));

    tempDirs.push(moved);

    await run("git", ["clone", "-q", remoteDir, moved]);
    await run("git", ["config", "user.email", "t@t"], { cwd: moved });
    await run("git", ["config", "user.name", "t"], { cwd: moved });
    await writeFile(join(moved, "wiki", "other.md"), "moved\n");
    await run("git", ["add", "-A"], { cwd: moved });
    await run("git", ["commit", "-q", "-m", "moved"], { cwd: moved });
    await run("git", ["push", "-q", "origin", "main"], { cwd: moved });

    const before = await remoteMain(remoteDir);

    await pushFiledCommit({ dataRoot, env: process.env }).catch(() => {});

    expect(await remoteMain(remoteDir)).toBe(before);
  });

  it("refuses unshared local commits with push-first guidance", async () => {
    const { dataRoot } = await makeSharedRepo();

    await mkdir(join(dataRoot, "wiki", "queries"), { recursive: true });
    await writeFile(
      join(dataRoot, "wiki", "queries", "embeddings.md"),
      "---\ntype: query\n---\nEmbeddings\n",
    );
    await run("git", ["add", "-A"], { cwd: dataRoot });
    await run(
      "git",
      ["commit", "-q", "-m", queryCommitMessage("embeddings"), "--", "wiki"],
      { cwd: dataRoot },
    );

    await expect(
      pushFiledCommit({ dataRoot, env: process.env }),
    ).rejects.toThrow("unshared");
  });

  it("leaves the remote untouched when unshared commits precede the filing", async () => {
    const { dataRoot, remoteDir } = await makeSharedRepo();

    await mkdir(join(dataRoot, "wiki", "queries"), { recursive: true });
    await writeFile(
      join(dataRoot, "wiki", "queries", "embeddings.md"),
      "---\ntype: query\n---\nEmbeddings\n",
    );
    await run("git", ["add", "-A"], { cwd: dataRoot });
    await run(
      "git",
      ["commit", "-q", "-m", queryCommitMessage("embeddings"), "--", "wiki"],
      { cwd: dataRoot },
    );

    const before = await remoteMain(remoteDir);

    await pushFiledCommit({ dataRoot, env: process.env }).catch(() => {});

    expect(await remoteMain(remoteDir)).toBe(before);
  });

  it("refuses a live lease, naming the holder", async () => {
    const { dataRoot } = await makeSharedRepo();
    const git = gitRunnerFor({ dir: dataRoot, env: process.env });

    await run("git", ["fetch", "origin", "main"], { cwd: dataRoot });

    await acquireLease({
      git,
      remote: "origin",
      leaseRef: "refs/k-wiki/leases/data",
      treeOid: await fetchedTreeOid(git),
      base: (await remoteMain(dataRoot)) ?? "",
      now: () => new Date(),
      holder: "other-mac:1",
    });

    await expect(
      pushFiledCommit({ dataRoot, env: process.env }),
    ).rejects.toThrow("other-mac:1");
  });

  it("refuses dirt beyond the filing", async () => {
    const { dataRoot } = await makeSharedRepo();

    await writeFile(join(dataRoot, "wiki", "stray.md"), "dirt\n");

    await expect(
      pushFiledCommit({ dataRoot, env: process.env }),
    ).rejects.toThrow("dirty beyond the filed commit");
  });

  it("pushes a filing when the transient query artifact is ignored", async () => {
    const { dataRoot } = await makeSharedRepo({ queryArtifactIgnored: true });

    await mkdir(join(dataRoot, "outputs"), { recursive: true });
    await writeFile(join(dataRoot, "outputs", "last-query.md"), "saved\n");

    await expect(
      pushFiledCommit({ dataRoot, env: process.env }),
    ).resolves.toBeUndefined();
  });

  it("names the stage-1 artifact in the dirty refusal", async () => {
    const { dataRoot } = await makeSharedRepo();

    await mkdir(join(dataRoot, "outputs"), { recursive: true });
    await writeFile(join(dataRoot, "outputs", "last-query.md"), "saved\n");

    await expect(
      pushFiledCommit({ dataRoot, env: process.env }),
    ).rejects.toThrow("outputs/last-query.md");
  });

  it("refuses when shared-writer mode is not enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "k-wiki-plain-"));

    tempDirs.push(root);

    const dataRoot = await makeDataRepo(root, "data");

    await expect(
      pushFiledCommit({ dataRoot, env: process.env }),
    ).rejects.toThrow("shared-writer mode is not enabled");
  });
});
