import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The npm-audit guard's repo-wide contract (issue #292): the local
 * on-demand form (`npm run audit`) matches CI's two blocking audits,
 * the README quality-checks table documents it, and Dependabot is
 * configured for advisory-driven security updates only — the
 * github-actions ecosystem weekly, never npm version updates (the
 * deliberate split the issue's Rationale records).
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const BLOCKING_AUDIT =
  "npm audit --omit=dev --audit-level=high && npm audit --audit-level=critical";

async function readRepoFile(path: string): Promise<string> {
  return readFile(resolve(repoRoot, path), "utf8");
}

describe("npm audit guard (issue #292)", () => {
  it("exposes both blocking audits as npm run audit", async () => {
    const pkg = JSON.parse(await readRepoFile("package.json")) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts.audit).toBe(BLOCKING_AUDIT);
  });

  it("documents npm run audit in the README quality-checks table", async () => {
    const readme = await readRepoFile("README.md");

    expect(readme).toContain("`npm run audit`");
  });

  it("tracks only the github-actions ecosystem in dependabot.yml", async () => {
    const config = await readRepoFile(".github/dependabot.yml");
    const ecosystems = config
      .split("\n")
      .map((line) => /^\s*-\s*package-ecosystem:\s*(\S+)/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => match[1]);

    expect(ecosystems).toEqual(["github-actions"]);
  });

  it("schedules dependabot weekly", async () => {
    const config = await readRepoFile(".github/dependabot.yml");

    expect(config).toContain("interval: weekly");
  });
});
