import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

let help: string;

beforeAll(() => {
  help = execFileSync(
    process.execPath,
    [join(repoRoot, "bin", "wiki-sync"), "--help"],
    { encoding: "utf8" },
  );
});

describe("wiki-sync help (printed by the launcher)", () => {
  it("documents the removal-receipt switch", () => {
    expect(help).toContain("--removal-receipt <path>");
  });

  it("documents shared-writer mode", () => {
    expect(help).toContain("shared-writer");
  });

  it("documents the remote-lease serialization", () => {
    expect(help).toContain("remote lease");
  });

  it("names the enable-shared-writer door", () => {
    expect(help).toContain("enable-shared-writer");
  });
});
