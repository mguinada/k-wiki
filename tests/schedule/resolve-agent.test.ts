import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loginShell,
  resolveAgentPath,
} from "../../src/schedule/resolve-agent.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "k-wiki-resolve-agent-"));

  tempDirs.push(dir);

  return dir;
}

/** A temp bin dir holding one executable fake agent. */
async function fakeBin(name = "pi-stub"): Promise<string> {
  const dir = await tempDir();

  await writeFile(join(dir, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  return dir;
}

/** Runs one probe with a temporarily narrowed PATH and SHELL, so the
 *  login-shell lookup sees only what the test staged. */
async function withEnv(
  path: string,
  shell: string,
  probe: () => Promise<unknown>,
): Promise<unknown> {
  const originalPath = process.env.PATH;
  const originalShell = process.env.SHELL;

  process.env.PATH = path;
  process.env.SHELL = shell;

  try {
    return await probe();
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }

    if (originalShell === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = originalShell;
    }
  }
}

describe("resolveAgentPath", () => {
  it("accepts an absolute command whose binary exists as-is", async () => {
    await expect(
      resolveAgentPath(process.execPath, "/nonexistent-dir", undefined),
    ).resolves.toBe(process.execPath);
  });

  it("fails an absolute command whose binary is gone", async () => {
    const dir = await tempDir();

    await expect(
      resolveAgentPath(
        join(dir, "absent-agent"),
        "/nonexistent-dir",
        undefined,
      ),
    ).resolves.toBeUndefined();
  });

  it("resolves a bare name from the search path", async () => {
    const dir = await fakeBin();

    await expect(resolveAgentPath("pi-stub", dir, undefined)).resolves.toBe(
      join(dir, "pi-stub"),
    );
  });

  it("skips a non-executable search-path hit", async () => {
    const dir = await tempDir();

    await writeFile(join(dir, "pi-stub"), "#!/bin/sh\nexit 0\n");

    await expect(
      resolveAgentPath("pi-stub", dir, undefined),
    ).resolves.toBeUndefined();
  });

  it("skips a directory shadowing the command's name on the search path", async () => {
    const shadow = await tempDir();
    const real = await fakeBin();

    await mkdir(join(shadow, "pi-stub"), { recursive: true });

    await expect(
      resolveAgentPath("pi-stub", `${shadow}:${real}`, undefined),
    ).resolves.toBe(join(real, "pi-stub"));
  });

  it("resolves a bare name through the login shell when the search path lacks it", async () => {
    const dir = await fakeBin();

    await expect(
      withEnv(`${dir}:/usr/bin:/bin`, "/bin/sh", () =>
        resolveAgentPath("pi-stub", "/nonexistent-dir", "/bin/sh"),
      ),
    ).resolves.toBe(join(dir, "pi-stub"));
  });

  it("returns nothing when neither the search path nor the login shell finds the command", async () => {
    await expect(
      withEnv("/usr/bin:/bin", "/bin/sh", () =>
        resolveAgentPath(
          "no-such-agent-anywhere-399",
          "/nonexistent-dir",
          "/bin/sh",
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it("skips the login-shell lookup entirely when no shell is given", async () => {
    const dir = await fakeBin();

    await expect(
      withEnv(`${dir}:/usr/bin:/bin`, "/bin/sh", () =>
        resolveAgentPath("pi-stub", "/nonexistent-dir", undefined),
      ),
    ).resolves.toBeUndefined();
  });

  it("does not accept a shell builtin name as a resolved path", async () => {
    await expect(
      resolveAgentPath("cd", "/nonexistent-dir", "/bin/sh"),
    ).resolves.toBeUndefined();
  });

  it("survives a command holding a quote that would break the shell probe", async () => {
    await expect(
      resolveAgentPath("o'agent", "/nonexistent-dir", "/bin/sh"),
    ).resolves.toBeUndefined();
  });
});

describe("loginShell", () => {
  it("prefers the environment's SHELL", () => {
    expect(loginShell({ SHELL: "/bin/bash" }, "darwin")).toBe("/bin/bash");
  });

  it("defaults to the macOS login shell on darwin", () => {
    expect(loginShell({}, "darwin")).toBe("/bin/zsh");
  });

  it("defaults to POSIX sh elsewhere", () => {
    expect(loginShell({}, "linux")).toBe("/bin/sh");
  });
});
