import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { expandHome } from "../sync/config.ts";
import { isPlainObject, statIfExists } from "./shared.ts";

/**
 * The k-wiki binding file and checkout resolution (issue #76,
 * extracted in issue #259): the per-project `.k-wiki.json` schema —
 * one project binds exactly one wiki — and the resolution order
 * every k-wiki command applies: the `--checkout` flag, the
 * `K_WIKI_CHECKOUT` environment variable, the nearest binding file
 * walking up from the cwd, then the cwd itself. CLI-side by design:
 * paths and process input, no wiki domain logic.
 */

/** The per-project binding file name, at the bound project's root. */
export const BINDING_FILE = ".k-wiki.json";

/** Environment variable naming a checkout without a binding file. */
export const CHECKOUT_ENV = "K_WIKI_CHECKOUT";

/** One parsed binding: exactly one wiki (issue #76's 1:1 rule). */
export interface KWikiBinding {
  /** k-wiki checkout path, `~` already expanded. */
  readonly checkout: string;
  /** Non-default settings file inside the checkout, when set. */
  readonly settings: string | undefined;
}

const BINDING_SHAPE =
  'a single JSON object: { "checkout": "<k-wiki checkout>", "settings": "<optional settings file>" }';

/** Reject any key beyond checkout and settings (the one-wiki shape). */
function rejectUnknownKeys(
  parsed: Record<string, unknown>,
  source: string,
): void {
  for (const key of Object.keys(parsed)) {
    if (key !== "checkout" && key !== "settings") {
      throw new Error(
        `invalid binding at ${source}: unknown key ${JSON.stringify(key)}; expected ${BINDING_SHAPE}`,
      );
    }
  }
}

/** Validate the optional settings field: absent, or a non-empty string. */
function parseSettingsField(
  settings: unknown,
  source: string,
): string | undefined {
  if (typeof settings === "string" && settings.length > 0) {
    return settings;
  }

  if (settings !== undefined) {
    throw new Error(
      `invalid binding at ${source}: "settings" must be a non-empty string`,
    );
  }

  return undefined;
}

/**
 * Parse and validate a binding file. The schema deliberately rejects
 * every list or multi-wiki form: one project binds exactly one wiki
 * (no ambient path between work and personal knowledge).
 */
export function parseBinding(
  text: string,
  source: string,
  home: string,
): KWikiBinding {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`invalid binding at ${source}: not valid JSON`, { cause });
  }

  if (!isPlainObject(parsed)) {
    throw new Error(
      `invalid binding at ${source}: expected ${BINDING_SHAPE} — one project binds exactly one wiki; lists and multi-wiki forms are rejected`,
    );
  }

  rejectUnknownKeys(parsed, source);

  const checkout = parsed.checkout;

  if (typeof checkout !== "string" || checkout.length === 0) {
    throw new Error(
      `invalid binding at ${source}: "checkout" must be a non-empty string`,
    );
  }

  return {
    checkout: expandHome(checkout, home),
    settings: parseSettingsField(parsed.settings, source),
  };
}

/**
 * Find the nearest binding file walking up from `startDir`, stopping
 * at the home directory or the filesystem root (each checked last).
 * Undefined when no binding exists on the walk.
 */
export async function findBindingFile(
  startDir: string,
  home: string,
): Promise<string | undefined> {
  let dir = resolve(startDir);

  while (true) {
    const candidate = join(dir, BINDING_FILE);

    if ((await statIfExists(candidate))?.isFile() === true) {
      return candidate;
    }

    if (dir === home || dirname(dir) === dir) {
      return undefined;
    }

    dir = dirname(dir);
  }
}

/** Where the resolved checkout came from, for progress and errors. */
export type CheckoutOrigin = "flag" | "env" | "file" | "cwd";

export interface CheckoutResolution {
  /** The k-wiki checkout, `~` already expanded. */
  readonly checkout: string;
  /** Binding's non-default settings file, when the binding was used. */
  readonly settings: string | undefined;
  readonly origin: CheckoutOrigin;
}

/**
 * Resolve the k-wiki checkout (issue #76): explicit flag > env var >
 * binding file (cwd-upward walk) > the cwd itself — today's behavior
 * of running from inside the checkout, preserved.
 */
export async function resolveCheckout(input: {
  readonly flag: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly home: string;
}): Promise<CheckoutResolution> {
  if (input.flag !== undefined) {
    return {
      checkout: expandHome(input.flag, input.home),
      settings: undefined,
      origin: "flag",
    };
  }

  const fromEnv = input.env[CHECKOUT_ENV];

  if (fromEnv !== undefined && fromEnv !== "") {
    return {
      checkout: expandHome(fromEnv, input.home),
      settings: undefined,
      origin: "env",
    };
  }

  const bindingPath = await findBindingFile(input.cwd, input.home);

  if (bindingPath === undefined) {
    return { checkout: input.cwd, settings: undefined, origin: "cwd" };
  }

  const binding = parseBinding(
    await readFile(bindingPath, "utf8"),
    bindingPath,
    input.home,
  );

  return {
    checkout: binding.checkout,
    settings: binding.settings,
    origin: "file",
  };
}
