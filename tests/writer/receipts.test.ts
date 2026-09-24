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

  it("rejects malformed JSON and wrong versions", () => {
    expect(() => parseReceipt("{", "r")).toThrow(/not valid JSON/);
    expect(() =>
      parseReceipt(
        JSON.stringify({ ...buildReceipt("a".repeat(40), PLAN), version: 2 }),
        "r",
      ),
    ).toThrow(/version-1/);
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

  it("rejects a receipt planned against an older remote SHA", () => {
    const match = matchReceipt(buildReceipt("b".repeat(40), PLAN), base, PLAN);

    expect(match).toMatchObject({ ok: false });
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
});

describe("receipt file", () => {
  it("writes and reads back at the per-machine path", async () => {
    const dataRoot = await tempDataRoot();
    const path = await writeReceipt(dataRoot, buildReceipt(base0(), PLAN));
    const loaded = await readReceipt(path);

    expect(loaded.plans).toEqual(PLAN);
    expect(path).toContain(RECEIPT_FILENAME);

    function base0(): string {
      return "a".repeat(40);
    }
  });

  it("keeps the receipt out of git via .git/info/exclude", async () => {
    const dataRoot = await tempDataRoot();

    await ensureReceiptIgnored(dataRoot, () => {});
    await ensureReceiptIgnored(dataRoot, () => {});

    const exclude = await readFile(
      join(dataRoot, ".git", "info", "exclude"),
      "utf8",
    );

    expect(exclude).toContain(RECEIPT_FILENAME);
    expect(exclude.match(new RegExp(RECEIPT_FILENAME, "g"))).toHaveLength(1);
  });
});

describe("describeReceipt", () => {
  it("lists exact paths and the confirmation command", () => {
    const lines = describeReceipt(buildReceipt("a".repeat(40), PLAN));
    const text = lines.join("\n");

    expect(text).toContain("removal  Engineering/old-note.md");
    expect(text).toContain("rename   Engineering/a.md → b/a.md");
    expect(text).toContain("--removal-receipt");
  });
});
