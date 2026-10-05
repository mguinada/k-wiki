import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VaultRemovalPlan } from "../../src/sync/projection.ts";
import {
  buildReceipt,
  describeReceipt,
  ensureReceiptIgnored,
  matchReceipt,
  parseReceipt,
  RECEIPT_FILENAME,
  readReceipt,
  writeReceipt,
} from "../../src/writer/receipts.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const PLAN: VaultRemovalPlan[] = [
  {
    vault: "Engineering",
    removals: ["old-note.md"],
    renames: [{ from: "a.md", to: "b/a.md" }],
  },
];

async function tempDataRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "receipt-"));

  tempDirs.push(dir);

  return dir;
}

describe("receipt shape", () => {
  it("round-trips through serialize and parse", () => {
    const receipt = buildReceipt("a".repeat(40), PLAN);
    const text = JSON.stringify(receipt, null, 2);

    expect(parseReceipt(text, "receipt.json")).toEqual(receipt);
  });

  it("rejects malformed receipt JSON", () => {
    expect(() => parseReceipt("{", "r")).toThrow(/not valid JSON/);
  });

  it("rejects a wrong receipt version", () => {
    expect(() =>
      parseReceipt(
        JSON.stringify({ ...buildReceipt("a".repeat(40), PLAN), version: 2 }),
        "r",
      ),
    ).toThrow(/version-1/);
  });

  it("rejects an empty receipt", () => {
    expect(() => parseReceipt("{}", "r")).toThrow(/version-1/);
  });

  it("rejects malformed plan entries", () => {
    const text = JSON.stringify({
      version: 1,
      base: "a".repeat(40),
      plans: [{}],
    });

    expect(() => parseReceipt(text, "r")).toThrow(/malformed plan entry/);
  });
});

describe("matchReceipt", () => {
  const base = "a".repeat(40);

  it("accepts the identical set and base", () => {
    expect(matchReceipt(buildReceipt(base, PLAN), base, PLAN)).toEqual({
      ok: true,
    });
  });

  it("fails the match against an older remote SHA", () => {
    const match = matchReceipt(buildReceipt("b".repeat(40), PLAN), base, PLAN);

    expect(match).toMatchObject({ ok: false });
  });

  it("names the moved canonical head as the reason", () => {
    const match = matchReceipt(buildReceipt("b".repeat(40), PLAN), base, PLAN);

    expect((match as { reason: string }).reason).toContain("canonical is now");
  });

  it("rejects a changed candidate set (test 20's invalidation)", () => {
    const changed: VaultRemovalPlan[] = [
      {
        vault: "Engineering",
        removals: ["old-note.md", "new.md"],
        renames: [],
      },
    ];
    const match = matchReceipt(buildReceipt(base, PLAN), base, changed);

    expect(match).toMatchObject({
      ok: false,
      reason: expect.stringContaining("differs"),
    });
  });

  it("rejects a different rename pairing", () => {
    const changed: VaultRemovalPlan[] = [
      {
        vault: "Engineering",
        removals: ["old-note.md"],
        renames: [{ from: "a.md", to: "elsewhere.md" }],
      },
    ];

    expect(matchReceipt(buildReceipt(base, PLAN), base, changed)).toMatchObject(
      {
        ok: false,
      },
    );
  });

  it("rejects a receipt that duplicates one removal and drops another", () => {
    const plan: VaultRemovalPlan[] = [
      {
        vault: "Engineering",
        removals: ["old-note.md", "spare.md"],
        renames: [],
      },
    ];
    const padded: VaultRemovalPlan[] = [
      {
        vault: "Engineering",
        removals: ["old-note.md", "old-note.md"],
        renames: [],
      },
    ];

    expect(matchReceipt(buildReceipt(base, padded), base, plan)).toMatchObject({
      ok: false,
    });
  });

  it("rejects a receipt that duplicates one rename and drops another", () => {
    const plan: VaultRemovalPlan[] = [
      {
        vault: "Engineering",
        removals: [],
        renames: [
          { from: "a.md", to: "b.md" },
          { from: "c.md", to: "d.md" },
        ],
      },
    ];
    const padded: VaultRemovalPlan[] = [
      {
        vault: "Engineering",
        removals: [],
        renames: [
          { from: "a.md", to: "b.md" },
          { from: "a.md", to: "b.md" },
        ],
      },
    ];

    expect(matchReceipt(buildReceipt(base, padded), base, plan)).toMatchObject({
      ok: false,
    });
  });

  it("accepts the same candidate set in a different order", () => {
    const receiptPlans: VaultRemovalPlan[] = [
      {
        vault: "Engineering",
        removals: ["spare.md", "old-note.md"],
        renames: [{ from: "a.md", to: "b.md" }],
      },
    ];
    const plan: VaultRemovalPlan[] = [
      {
        vault: "Engineering",
        removals: ["old-note.md", "spare.md"],
        renames: [{ from: "a.md", to: "b.md" }],
      },
    ];

    expect(matchReceipt(buildReceipt(base, receiptPlans), base, plan)).toEqual({
      ok: true,
    });
  });
});

describe("receipt file", () => {
  it("reads the receipt back with its plans", async () => {
    const dataRoot = await tempDataRoot();

    const path = await writeReceipt(dataRoot, buildReceipt(base0(), PLAN));

    const loaded = await readReceipt(path);

    expect(loaded.plans).toEqual(PLAN);

    function base0(): string {
      return "a".repeat(40);
    }
  });

  it("writes the receipt at the per-machine path", async () => {
    const dataRoot = await tempDataRoot();

    const path = await writeReceipt(dataRoot, buildReceipt(base0(), PLAN));

    expect(path).toContain(RECEIPT_FILENAME);

    function base0(): string {
      return "a".repeat(40);
    }
  });

  it("excludes the receipt from git", async () => {
    const dataRoot = await tempDataRoot();

    await ensureReceiptIgnored(dataRoot, () => {});

    await ensureReceiptIgnored(dataRoot, () => {});

    const exclude = await readFile(
      join(dataRoot, ".git", "info", "exclude"),
      "utf8",
    );

    expect(exclude).toContain(RECEIPT_FILENAME);
  });

  it("excludes the receipt exactly once", async () => {
    const dataRoot = await tempDataRoot();

    await ensureReceiptIgnored(dataRoot, () => {});

    await ensureReceiptIgnored(dataRoot, () => {});

    const exclude = await readFile(
      join(dataRoot, ".git", "info", "exclude"),
      "utf8",
    );

    expect(exclude.match(new RegExp(RECEIPT_FILENAME, "g"))).toHaveLength(1);
  });
});

describe("describeReceipt", () => {
  it("lists the removal in the confirmation text", () => {
    const lines = describeReceipt(buildReceipt("a".repeat(40), PLAN));

    const text = lines.join("\n");

    expect(text).toContain("removal  Engineering/old-note.md");
  });

  it("lists the rename in the confirmation text", () => {
    const lines = describeReceipt(buildReceipt("a".repeat(40), PLAN));

    const text = lines.join("\n");

    expect(text).toContain("rename   Engineering/a.md → b/a.md");
  });

  it("names the confirmation flag", () => {
    const lines = describeReceipt(buildReceipt("a".repeat(40), PLAN));

    const text = lines.join("\n");

    expect(text).toContain("--removal-receipt");
  });

  it("tells an operator on another Mac to regenerate the receipt first", () => {
    const lines = describeReceipt(buildReceipt("a".repeat(40), PLAN));
    const text = lines.join("\n");

    expect(text).toContain(
      "on another Mac, rerun without --removal-receipt first",
    );
  });
});
