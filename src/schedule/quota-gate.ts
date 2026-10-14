/**
 * The direct-run quota gate (issue #463): the manual-confirmation UI
 * in front of the schedule-domain decision core. Direct `wiki-sync`
 * runs it before any lock, lease, stage, write, or publish; a
 * scheduled child never reaches it — the wrapper passes its outer
 * gate's proceeds as the `--no-quota-check` one-shot override, and
 * `quotaPreflight: off` disables the whole gate on both paths.
 */

import { createInterface } from "node:readline/promises";
import type { AgentSettings } from "../ingest/agent-settings.ts";
import { decideQuota } from "./quota-preflight.ts";

/** The direct-run quota request: the override flag, the loaded
 *  settings, the progress sink (which renders yellow `WARNING:`
 *  lines at its own boundary), terminal-ness, and the confirmation
 *  reader for tests. */
export interface DirectQuotaGateInput {
  readonly noQuotaCheck: boolean;
  readonly settings: AgentSettings;
  readonly onProgress: (message: string) => void;
  readonly interactive: boolean;
  readonly confirm: (prompt: string) => Promise<boolean>;
  /** The probe executor for tests (fixtures inject v5 responses
   *  here); default: the production execFile runner. */
  readonly commandRunner?: (
    command: string,
    env: NodeJS.ProcessEnv | undefined,
  ) => Promise<string>;
}

/** The direct-run quota gate: for a direct `wiki-sync` run — never a
 *  scheduled child, which passes `--no-quota-check` — decide against
 *  the first attempted target before any lock, lease, stage, write,
 *  or publish. Non-authoritative evidence stays fail-open and
 *  silent; authoritative low quota under a terminal warns and
 *  confirm-prompts with a negative default; the `--no-quota-check`
 *  override bypasses the probe with a terminal warning. `declined`
 *  means nothing starts. */
export async function directQuotaGate(
  initial: DirectQuotaGateInput,
): Promise<"proceed" | "declined"> {
  if (initial.noQuotaCheck) {
    return bypassOutcome(initial);
  }

  if (initial.settings.quotaPreflight === "off") {
    return "proceed";
  }

  const { decision, warnings } = await decideQuota({
    settings: initial.settings,
    log: initial.onProgress,
    ...(initial.commandRunner === undefined
      ? {}
      : { commandRunner: initial.commandRunner }),
  });

  for (const warning of warnings) {
    initial.onProgress(`wiki-sync: ${warning}`);
  }

  if (decision.kind !== "skip") {
    return "proceed";
  }

  initial.onProgress(`wiki-sync: WARNING — low quota — ${decision.reason}`);

  return await underThreshold(initial);
}

/** The override's outcome: proceed always, plus the explicit-bypass
 *  warning when the run happens under a terminal with the gate
 *  active (issue #463: off stays fully silent). */
function bypassOutcome(initial: DirectQuotaGateInput): "proceed" {
  if (initial.interactive && initial.settings.quotaPreflight !== "off") {
    initial.onProgress(
      "wiki-sync: WARNING — quota checking explicitly bypassed (--no-quota-check)",
    );
  }

  return "proceed";
}

/** The low-quota branch after the warning: a terminal gets the
 *  negative-default confirmation; non-terminal input declines
 *  without prompting. */
async function underThreshold(
  initial: DirectQuotaGateInput,
): Promise<"proceed" | "declined"> {
  if (
    initial.interactive &&
    (await initial.confirm("Proceed despite low quota? [y/N] "))
  ) {
    return "proceed";
  }

  return "declined";
}

/** The direct confirmation reader: readline over the terminal's
 *  stdin; EOF or an error declines (the prompt is negative-default
 *  in effect — only `y` or `Y` proceeds). */
export function terminalConfirm(prompt: string): Promise<boolean> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  return readline
    .question(prompt)
    .then((answer) => /^y$/i.test(answer.trim()))
    .catch(() => false)
    .finally(() => readline.close());
}
