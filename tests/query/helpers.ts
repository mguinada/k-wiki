/**
 * The shared wiki-query unit-test harness: one committed data-repo
 * template, one makeHarness with a recording agent runner, and the
 * invocation accessor. Shared by the run-machinery and CLI test
 * files; the e2e suite has its own helpers.
 */

import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AgentRunner } from "../../src/ingest/agent-run.ts";

const run = promisify(execFile);

export const SETTINGS_YML = `command: pi
model: GLM-5.2
reasoning: high
`;

const tempDirs: string[] = [];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The CLI's default saved-answer path (outputs/ is per-machine). */
export const defaultLastQuery = join(repoRoot, "outputs", "last-query.md");

/** Remove every temp dir the harness created; each test file hooks
 *  this into its own afterAll. */
export function cleanTempDirs(): Promise<unknown> {
  return Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
}

/** The committed wiki/ tree (git-tracked index, log, one concept page;
 * empty raw/), built once per test file and copied per harness: the
 * same tree and init commit every makeHarness used to build with three
 * git spawns of its own. Prompts and settings stay per-harness writes
 * (untracked, exactly as before — the template commits only the wiki).
 */
let dataRepoTemplate: Promise<string> | undefined;

function committedDataRepoTemplate(): Promise<string> {
  dataRepoTemplate ??= (async () => {
    const template = await mkdtemp(join(tmpdir(), "k-wiki-query-tpl-"));

    tempDirs.push(template);

    await mkdir(join(template, "raw"), { recursive: true });
    await mkdir(join(template, "wiki", "concepts"), { recursive: true });
    await writeFile(join(template, "wiki", "index.md"), "# Index\n");
    await writeFile(join(template, "wiki", "log.md"), "# Log\n");
    await writeFile(join(template, "wiki", "concepts", "rag.md"), "RAG\n");

    await run("git", ["init", "--quiet"], { cwd: template });
    await run("git", ["config", "user.email", "t@t"], { cwd: template });
    await run("git", ["config", "user.name", "t"], { cwd: template });
    await run("git", ["add", "-A"], { cwd: template });
    await run(
      "git",
      [
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "--quiet",
        "-m",
        "init",
      ],
      { cwd: template },
    );

    return template;
  })();

  return dataRepoTemplate;
}

export interface Harness {
  readonly dataRoot: string;
  readonly promptsDir: string;
  readonly outputsDir: string;
  readonly settingsPath: string;
  readonly invocations: {
    command: string;
    args: readonly string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  }[];
  runAgent: AgentRunner;
}

/**
 * A data repo (git-tracked wiki/, empty raw/) with a query prompt, an
 * outputs dir, settings, and a recording agent runner. The default
 * runner is a clean answer-only agent: it writes nothing.
 */
export async function makeHarness(): Promise<Harness> {
  const dataRoot = await mkdtemp(join(tmpdir(), "k-wiki-query-"));

  tempDirs.push(dataRoot);

  await cp(await committedDataRepoTemplate(), dataRoot, { recursive: true });

  const promptsDir = join(dataRoot, "prompts");

  await mkdir(promptsDir, { recursive: true });
  await writeFile(join(promptsDir, "query.md"), "QUERY PROMPT");

  const outputsDir = join(dataRoot, "outputs");

  await mkdir(outputsDir, { recursive: true });

  const settingsPath = join(dataRoot, "settings.yml");

  await writeFile(settingsPath, SETTINGS_YML);

  const invocations: Harness["invocations"] = [];
  const runAgent: AgentRunner = async (command, args, options) => {
    invocations.push({
      command,
      args,
      cwd: options.cwd,
      env: options.env,
    });

    return {
      stdout:
        "Prefer RAG when the knowledge base changes often. See [[retrieval-augmented-generation]].",
      stderr: "",
    };
  };

  return {
    dataRoot,
    promptsDir,
    outputsDir,
    settingsPath,
    invocations,
    runAgent,
  };
}

/** The recorded invocation at `index`; fails loudly when absent. */
export function invocation(h: Harness, index: number) {
  const recorded = h.invocations[index];

  if (recorded === undefined) {
    throw new Error(`agent was not invoked (call ${index})`);
  }

  return recorded;
}

export { repoRoot, run };

/** A search call's toolCall event line, in the recorded stream shape. */
export function toolCallLine(
  id: string,
  args: Record<string, unknown>,
): string {
  return JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id, name: "web_search", arguments: args }],
      stopReason: "toolUse",
      timestamp: 1791000000000,
    },
  });
}

/** A toolResult event line, in the recorded stream shape. */
export function toolResultLine(
  id: string,
  text: string,
  options: { totalResults?: number; isError?: boolean } = {},
): string {
  return JSON.stringify({
    type: "message_end",
    message: {
      role: "toolResult",
      toolCallId: id,
      toolName: "web_search",
      content: [{ type: "text", text }],
      isError: options.isError ?? false,
      ...(options.totalResults === undefined
        ? {}
        : { details: { totalResults: options.totalResults } }),
      timestamp: 1791000001000,
    },
  });
}

/** The final assistant text event line. */
export function assistantTextLine(
  text: string,
  timestamp = 1791000002000,
): string {
  return JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
      timestamp,
    },
  });
}
