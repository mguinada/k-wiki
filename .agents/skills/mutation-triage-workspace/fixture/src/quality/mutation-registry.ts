// The committed equivalent-mutant registry (issue #241): the
// machine-readable memory of settled adjudications. The file lives
// at the repo root, is edited only in PRs (PR review is the
// human-judgment gate the policy requires — no automation ever
// writes it to main), and every entry carries its receipt: bucket,
// one-line justification, PR link, and date. A receipt-less entry
// fails the unit suite (tests/quality/mutation-registry.test.ts
// validates the committed file against this schema).
//
// Two buckets, never merged: `equivalent` (the sabotage changes
// nothing a test could observe) and `artifact` (a measurement
// artifact — plausibly killable, kept visible in its own report
// section so it stays revisitable). Both are filtered from
// re-filing; excusing is visible, never rewarded — the report
// renders untriaged and recorded counts separately.

/** The committed registry file's name, at the repo root. */
export const REGISTRY_FILENAME = ".mutants-registry.json";

/** Why a mutant needs no kill. */
export type RegistryBucket = "equivalent" | "artifact";

/** One settled adjudication — the receipt is mandatory. */
export interface RegistryEntry {
  readonly bucket: RegistryBucket;
  readonly justification: string;
  readonly pr: string;
  readonly date: string;
}

/** The registry: identity-keyed adjudication records. */
export interface Registry {
  readonly entries: ReadonlyMap<string, RegistryEntry>;
}

const BUCKETS = new Set(["equivalent", "artifact"]);

const ID = /^[0-9a-f]{16}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The shape inside the committed JSON file. */
type RegistryJson = {
  schema: number;
  entries: Record<string, RegistryEntry>;
};

/** One receipt rule: what a well-formed entry field looks like. */
interface ReceiptRule {
  readonly field: keyof RegistryEntry;
  readonly complaint: string;
  readonly valid: (value: unknown) => boolean;
}

/** The mandatory receipt, field by field — an entry without its
 *  receipt fails the suite, which validates the committed file
 *  against exactly these rules. */
const RECEIPT_RULES: readonly ReceiptRule[] = [
  {
    field: "bucket",
    complaint: "carries no legal bucket",
    valid: (value) => typeof value === "string" && BUCKETS.has(value),
  },
  {
    field: "justification",
    complaint: "carries no one-line justification receipt",
    valid: (value) =>
      typeof value === "string" && value !== "" && !value.includes("\n"),
  },
  {
    field: "pr",
    complaint: "carries no https PR link",
    valid: (value) => typeof value === "string" && value.startsWith("https://"),
  },
  {
    field: "date",
    complaint: "carries no YYYY-MM-DD date",
    valid: (value) => typeof value === "string" && DATE.test(value),
  },
];

/** Parse and validate one entry; the error names the failed field. */
function validatedEntry(id: string, entry: unknown): RegistryEntry {
  if (typeof entry !== "object" || entry === null) {
    throw new Error(`registry entry ${id} has an unexpected shape`);
  }

  const candidate = entry as Partial<RegistryEntry>;

  for (const rule of RECEIPT_RULES) {
    if (!rule.valid(candidate[rule.field])) {
      throw new Error(`registry entry ${id} ${rule.complaint}`);
    }
  }

  return candidate as RegistryEntry;
}

/** Parse the registry file's text. Absent text (no file yet) is an
 *  empty registry — a fresh repo has recorded nothing; corrupt text
 *  or a drifted shape throws, so a broken registry fails the filing
 *  loudly instead of silently losing adjudications. */
export function parseRegistry(text: string | undefined): Registry {
  if (text === undefined) {
    return { entries: new Map() };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `the registry at ${REGISTRY_FILENAME} is corrupt (not valid JSON)`,
    );
  }

  const root = parsed as Partial<RegistryJson>;

  if (
    root.schema !== 1 ||
    typeof root.entries !== "object" ||
    root.entries === null ||
    Array.isArray(root.entries)
  ) {
    throw new Error(
      `the registry at ${REGISTRY_FILENAME} has an unexpected shape`,
    );
  }

  const entries = new Map<string, RegistryEntry>();

  for (const [id, entry] of Object.entries(root.entries)) {
    if (!ID.test(id)) {
      throw new Error(
        `registry key ${id} is not a 16-hex-character mutant identity`,
      );
    }

    entries.set(id, validatedEntry(id, entry));
  }

  return { entries };
}

/** One ledger-listed mutant, identity included when computable. */
export interface SplitEntry {
  readonly file: string;
  readonly line: number;
  readonly mutator: string;
  readonly status: string;
  readonly id?: string | undefined;
}

/** One registry-recorded mutant, its record beside it. */
export interface RecordedEntry {
  readonly entry: SplitEntry;
  readonly record: RegistryEntry;
}

/** The triage split of one actionable list: what still needs work,
 *  and what the registry has settled — per bucket. */
export interface LedgerSplit {
  readonly untriaged: readonly SplitEntry[];
  readonly equivalents: readonly RecordedEntry[];
  readonly artifacts: readonly RecordedEntry[];
}

/** Split actionable entries against the registry. Entries without an
 *  identity (pre-registry ledger legacy) never match — they stay
 *  untriaged until re-reported or reconciled. */
export function splitByRegistry(
  entries: readonly SplitEntry[],
  registry: Registry,
): LedgerSplit {
  const untriaged: SplitEntry[] = [];
  const equivalents: RecordedEntry[] = [];
  const artifacts: RecordedEntry[] = [];

  for (const entry of entries) {
    const record =
      entry.id === undefined ? undefined : registry.entries.get(entry.id);

    if (record === undefined) {
      untriaged.push(entry);

      continue;
    }

    const recorded = { entry, record };

    if (record.bucket === "artifact") {
      artifacts.push(recorded);
    } else {
      equivalents.push(recorded);
    }
  }

  return { untriaged, equivalents, artifacts };
}

/** One registry entry whose identity no generated mutant carries. */
export interface PruneCandidate {
  readonly id: string;
  readonly record: RegistryEntry;
}

/** Registry entries the run's generated identities do not cover —
 *  their spans are gone (or their mutants died). Only a full run
 *  may consult this: a windowed run cannot distinguish "span gone"
 *  from "out of window", so it must never prune. The filing reports
 *  the candidates in the issue body; removal itself lands as a PR —
 *  automation never edits the registry on main. */
export function pruneCandidates(
  registry: Registry,
  generated: ReadonlySet<string>,
): readonly PruneCandidate[] {
  const candidates: PruneCandidate[] = [];

  for (const [id, record] of registry.entries) {
    if (!generated.has(id)) {
      candidates.push({ id, record });
    }
  }

  return candidates;
}
