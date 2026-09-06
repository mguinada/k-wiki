/**
 * The sandbox run primitive (issue #336, family 3 of epic #289): the
 * agent-write half of the two-door authority split. One gated run —
 * write → accept-gate → stamp → atomic commit — executes as one
 * process with one outcome (decision 13): there is no ungated write
 * path. The run's writes must land only under `wiki/sandbox/**` in
 * the resolved instance's data repo; anything else trips the
 * accept-gate, which reverts exactly the paths the run touched
 * (decision 3: path-scoped revert, never a whole-repo reset — a
 * wiki-sync commit landing mid-window survives) and fails loudly.
 * On success the epilogue stamps every sandbox page it wrote
 * (`via: agent`, `expires:` with the 7-day floor, decision 8 — the
 * stamps are the pipeline's, the caller cannot forge them), appends
 * the audit entry to `wiki/log.md`, and leaves exactly one commit
 * (`sandbox: <slug>`, decision 5). An empty run commits nothing.
 * The `propose` verb that drives this (family 6) is a later issue;
 * everything here is a library primitive. The instance resolution is
 * the caller's own (decision 10): this module takes the resolved
 * instance and the run context, and refuses when they disagree — the
 * #124 wrong-repo foot-gun becomes a loud refusal, not a silent
 * cross-instance write.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { errorMessage } from "../cli/colors.ts";
import type { RunContext } from "../cli/run-context.ts";
import { statIfExists } from "../cli/shared.ts";
import { changedPaths, runGit, type StatusEntry, tryGit } from "../data/git.ts";
import { type AgentRunner, spawnAgent } from "../ingest/agent-run.ts";
import {
  type AgentSettings,
  agentArgs,
  formatAgentInvocation,
} from "../ingest/agent-settings.ts";
import { capturePreRunState, type PreRunState } from "../ingest/guardrails.ts";
import type { WikiInstance } from "../sync/instance.ts";
import {
  expiresOn,
  SANDBOX_DIR,
  sandboxLogEntry,
  sandboxNotePath,
  stampSandboxPage,
} from "./stamps.ts";

export interface SandboxRunOptions {
  /** The instance the verb resolved through its own --wiki chain
   *  (decision 10, issue #306) — never an ambient cwd default. */
  readonly instance: WikiInstance;
  /** The run context (data root, env, clock, progress sink). Its
   *  data root must match the instance's, or the run refuses. */
  readonly run: RunContext;
  /** Agent settings: the write phase's command and flags. */
  readonly settings: AgentSettings;
  /** The run's note slug — the note's identity. Derives the target
   *  path `wiki/sandbox/<slug>.md`; a second run with the same slug
   *  refuses (edge 3). */
  readonly slug: string;
  /** The composed agent message; the verb (family 6) writes it. */
  readonly prompt: string;
  /** Agent runner; defaults to the real non-interactive invocation. */
  readonly runAgent?: AgentRunner | undefined;
  /** Kill the agent run after this many milliseconds; default 30 min. */
  readonly timeoutMs?: number | undefined;
}

export type SandboxRunResult =
  | {
      readonly status: "committed";
      readonly commit: string;
      readonly message: string;
      /** The repo-relative sandbox `.md` pages the run wrote
       *  (stamped by the epilogue). */
      readonly pages: readonly string[];
    }
  /** The agent wrote nothing: no commit, no stamp, no audit entry
   *  (edge 2 — no run leaves a dirty tree, and no empty commit
   *  either). */
  | { readonly status: "empty" };

/** The slug vocabulary: lowercase kebab-case, the wiki's note-naming
 *  rule — the slug is the note's identity, so it cannot carry path
 *  separators or case variants. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** True when the path sits inside the sandbox namespace. */
function isSandboxPath(path: string): boolean {
  return path.startsWith(`${SANDBOX_DIR}/`);
}

/** True when the path is a sandbox Markdown page. */
function isSandboxPage(path: string): boolean {
  return isSandboxPath(path) && path.endsWith(".md");
}

/** The slug's usage error, undefined when valid. */
export function slugError(slug: string): string | undefined {
  return SLUG_PATTERN.test(slug)
    ? undefined
    : `sandbox slug ${JSON.stringify(slug)} must be lowercase kebab-case — letters and digits, single hyphens between them`;
}

/** Every status path (target or rename origin) under the sandbox
 *  namespace: the pre-write refusal set of edge 1. */
function dirtySandboxPaths(status: readonly StatusEntry[]): string[] {
  const paths = new Set<string>();

  for (const entry of status) {
    for (const path of [entry.path, entry.origin]) {
      if (path !== undefined && isSandboxPath(path)) {
        paths.add(path);
      }
    }
  }

  return [...paths].sort();
}

/** True when the audit log carries pre-run uncommitted changes
 *  (target or rename origin): the run's audit append and its atomic
 *  commit must not absorb them. */
function logMdDirty(status: readonly StatusEntry[]): boolean {
  return status.some(
    (entry) => entry.path === "wiki/log.md" || entry.origin === "wiki/log.md",
  );
}

/** Everything the prepare step validated: the plan the remaining
 *  steps share. */
interface SandboxPlan {
  readonly options: SandboxRunOptions;
  readonly pre: PreRunState;
}

/** The wrong-repo refusal (decision 10): the run context and the
 *  resolved instance must name the same data repo — a disagreement
 *  is the #124 foot-gun arriving as a wrong-repo accept-gate, and it
 *  is refused, not silently accepted. */
function refuseWrongRepo(options: SandboxRunOptions): void {
  const instanceRoot = resolve(dirname(options.instance.rawDir));

  if (resolve(options.run.dataRoot) !== instanceRoot) {
    throw new Error(
      `sandbox run refused — wrong-repo accept-gate: the run context targets ${options.run.dataRoot} but the resolved instance (${options.instance.name ?? "default"}) targets ${instanceRoot}; resolve the instance through the verb's own --wiki resolution and retry`,
    );
  }
}

/** The prepare step: validate the slug, guard the repo, capture the
 *  pre-run state, and refuse dirty sandbox targets (edge 1), a dirty
 *  audit log, and colliding slugs (edge 3) before any write. */
async function prepareStep(options: SandboxRunOptions): Promise<SandboxPlan> {
  const error = slugError(options.slug);

  if (error !== undefined) {
    throw new Error(error);
  }

  refuseWrongRepo(options);

  const { dataRoot, env } = options.run;
  const pre = await capturePreRunState(dataRoot, env);
  const dirty = dirtySandboxPaths(pre.status);

  if (dirty.length > 0) {
    throw new Error(
      `sandbox run refused — the sandbox namespace is already dirty (commit or revert these paths first; the path-scoped revert must not destroy changes that predate the run): ${dirty.join(", ")}`,
    );
  }

  if (logMdDirty(pre.status)) {
    throw new Error(
      "sandbox run refused — wiki/log.md is already dirty (commit or revert it first; the audit append and the sandbox commit must not absorb edits that predate the run)",
    );
  }

  const notePath = sandboxNotePath(options.slug);

  if ((await statIfExists(join(dataRoot, notePath))) !== undefined) {
    throw new Error(
      `sandbox run refused — ${notePath} already exists; the slug is the note's identity, a second run may not overwrite it`,
    );
  }

  return { options, pre };
}

/** The agent step's held outcome: the failure that must wait for
 *  the accept-gate before it escapes. */
interface AgentOutcome {
  readonly error: unknown;
}

/** The write phase: invoke the agent in the data repo root. A
 *  failure is captured, not thrown — the gate must see the tree
 *  state the failed run left behind. */
async function agentStep(plan: SandboxPlan): Promise<AgentOutcome> {
  const { run, settings } = plan.options;

  run.onProgress(`sandbox: invoking agent: ${formatAgentInvocation(settings)}`);

  let error: unknown;

  try {
    await (plan.options.runAgent ?? spawnAgent)(
      settings.command,
      agentArgs(settings, plan.options.prompt),
      { cwd: run.dataRoot, env: run.env, timeoutMs: plan.options.timeoutMs },
    );
  } catch (caught) {
    error = caught;
  }

  return { error };
}

/** Restore one path to its pre-run state: any index entry the run
 *  staged for the path is dropped first (a staged addition must not
 *  survive as a phantom entry), then a pre-run dirty path (captured
 *  bytes — null means absent) gets its bytes back, a tracked-clean
 *  path is checked out from the pre-run commit (which resurrects a
 *  run's deletion), and anything else was untracked before the run,
 *  so the run created it and it goes away. */
async function revertOnePath(
  dataRoot: string,
  env: NodeJS.ProcessEnv,
  pre: PreRunState,
  path: string,
): Promise<void> {
  const target = join(dataRoot, path);

  await runGit(dataRoot, ["reset", "--quiet", "--", path], env);

  if (pre.contents.has(path)) {
    const content = pre.contents.get(path) ?? null;

    if (content === null) {
      await rm(target, { force: true });

      return;
    }

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);

    return;
  }

  const tracked = await tryGit(
    dataRoot,
    ["cat-file", "-e", `${pre.commit}:${path}`],
    env,
  );

  if (tracked !== undefined) {
    await runGit(dataRoot, ["checkout", pre.commit, "--", path], env);

    return;
  }

  await rm(target, { force: true });
}

/**
 * The path-scoped revert (decision 3): restore exactly the given
 * paths to their pre-run state — never a whole-repo reset, so a
 * wiki-sync commit that landed mid-window survives untouched, and
 * pre-existing dirty work outside the revert set is preserved.
 */
async function revertChangedPaths(
  dataRoot: string,
  env: NodeJS.ProcessEnv,
  pre: PreRunState,
  paths: readonly string[],
): Promise<void> {
  for (const path of paths) {
    await revertOnePath(dataRoot, env, pre, path);
  }
}

/** The gate step: compute the run's changed paths, refuse any write
 *  outside the sandbox namespace (reverting every changed path on
 *  the way out), and surface a held agent failure with the run's
 *  writes reverted — the sandbox is all-or-nothing, so a failed run
 *  leaves no dirty tree. Returns the changed paths on success. */
async function gateStep(
  plan: SandboxPlan,
  agent: AgentOutcome,
): Promise<readonly string[]> {
  const { dataRoot, env, onProgress } = plan.options.run;
  const changed = await changedPaths(dataRoot, env, plan.pre);
  const violations = changed.filter((path) => !isSandboxPath(path));

  if (violations.length > 0) {
    onProgress(
      `sandbox: accept-gate failed — ${violations.length} path(s) outside ${SANDBOX_DIR}/; reverting ${changed.length} changed path(s)`,
    );

    await revertChangedPaths(dataRoot, env, plan.pre, changed);

    throw new Error(
      `sandbox accept-gate failed — the run touched paths outside ${SANDBOX_DIR}/: ${violations.join(", ")}; reverted ${changed.length} changed path(s) to their pre-run state (no whole-repo reset)`,
      { cause: agent.error },
    );
  }

  if (agent.error !== undefined) {
    if (changed.length > 0) {
      await revertChangedPaths(dataRoot, env, plan.pre, changed);
    }

    throw new Error(
      `sandbox agent run failed — the run's ${changed.length} sandbox path(s) were reverted`,
      { cause: agent.error },
    );
  }

  onProgress(
    `sandbox: accept-gate passed — ${changed.length} path(s) under ${SANDBOX_DIR}/`,
  );

  return changed;
}

/** The stamp step: write the epilogue's stamps into every sandbox
 *  page the run wrote (stamp authority, edge 4: caller-supplied
 *  `via:`/`expires:` lines are overwritten). Deleted pages carry
 *  nothing to stamp. Returns the stamped pages, repo-relative. */
async function stampStep(
  plan: SandboxPlan,
  changed: readonly string[],
  expires: string,
): Promise<string[]> {
  const pages: string[] = [];

  for (const path of changed) {
    if (!isSandboxPage(path)) {
      continue;
    }

    const target = join(plan.options.run.dataRoot, path);

    if ((await statIfExists(target)) === undefined) {
      continue;
    }

    const stamped = stampSandboxPage(await readFile(target, "utf8"), expires);

    await writeFile(target, stamped, "utf8");
    pages.push(path);
  }

  return pages;
}

/** The audit step: append the run's entry to `wiki/log.md` (created
 *  when absent), keeping the log's append-only shape. */
async function auditStep(plan: SandboxPlan, entry: string): Promise<void> {
  const logPath = join(plan.options.run.dataRoot, "wiki", "log.md");

  await mkdir(dirname(logPath), { recursive: true });

  const existing = await readFile(logPath, "utf8").catch(() => "");
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";

  await writeFile(logPath, `${existing}${separator}${entry}`, "utf8");
}

/** The commit step: stage the sandbox namespace and the log, then
 *  commit with the `sandbox: <slug>` convention (decision 5). The
 *  pathspecs keep the commit atomic over exactly the run's surface —
 *  unrelated dirty paths elsewhere stay untouched. Returns the
 *  commit hash. */
async function commitStep(plan: SandboxPlan, slug: string): Promise<string> {
  const { dataRoot, env } = plan.options.run;
  const specs = [SANDBOX_DIR, "wiki/log.md"];

  await runGit(dataRoot, ["add", "-A", "--", ...specs], env);
  await runGit(
    dataRoot,
    ["commit", "--quiet", "-m", `sandbox: ${slug}`, "--", ...specs],
    env,
  );

  const { stdout } = await runGit(dataRoot, ["rev-parse", "HEAD"], env);

  return stdout.trim();
}

/** An epilogue failure must not leave the run's writes dirty: drop
 *  the epilogue's staging and path-scoped-revert the run's paths
 *  plus the log it touched. */
// ponytail: a mid-window commit's own log.md append could be
// reverted here with the run's — an IO-failure edge inside an edge;
// the reaper-grade fix (log entry checksums) is not worth it now.
async function revertAfterEpilogue(
  plan: SandboxPlan,
  changed: readonly string[],
): Promise<void> {
  const { dataRoot, env } = plan.options.run;

  await runGit(
    dataRoot,
    ["reset", "--quiet", "--", SANDBOX_DIR, "wiki/log.md"],
    env,
  );
  await revertChangedPaths(dataRoot, env, plan.pre, [
    ...changed,
    "wiki/log.md",
  ]);
}

/** The epilogue: stamp the pages, append the audit entry, commit —
 *  or revert everything the run wrote if any step fails, so no run
 *  leaves a dirty tree. */
async function epilogueStep(
  plan: SandboxPlan,
  changed: readonly string[],
): Promise<SandboxRunResult> {
  const { now, onProgress } = plan.options.run;
  const expires = expiresOn(now);
  const date = now().toISOString().slice(0, 10);

  try {
    const pages = await stampStep(plan, changed, expires);

    await auditStep(
      plan,
      sandboxLogEntry({
        date,
        slug: plan.options.slug,
        expires,
        pages,
      }),
    );

    const commit = await commitStep(plan, plan.options.slug);

    onProgress(
      `sandbox: committed ${commit.slice(0, 8)} (sandbox: ${plan.options.slug}), expires ${expires}`,
    );

    return {
      status: "committed",
      commit,
      message: `sandbox: ${plan.options.slug}`,
      pages,
    };
  } catch (error) {
    await revertAfterEpilogue(plan, changed);

    throw new Error(
      `sandbox epilogue failed — the run's writes were reverted: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

/**
 * One sandboxed agent run: prepare (refusals) → write (agent) →
 * accept-gate (path-scoped revert on violation) → epilogue (stamp,
 * audit, atomic commit). Every refusal and failure is loud; every
 * success leaves exactly one `sandbox: <slug>` commit and a clean
 * run surface; an empty run commits nothing.
 */
export async function runSandboxRun(
  options: SandboxRunOptions,
): Promise<SandboxRunResult> {
  const plan = await prepareStep(options);
  const agent = await agentStep(plan);
  const changed = await gateStep(plan, agent);

  if (changed.length === 0) {
    return { status: "empty" };
  }

  return await epilogueStep(plan, changed);
}
