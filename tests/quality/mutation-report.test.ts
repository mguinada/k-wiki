import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { mutantIdentity } from "../../src/quality/mutation-identity.ts";
import {
  type Ledger,
  ledgerBlockLine,
  ledgerFromBody,
} from "../../src/quality/mutation-ledger.ts";
import {
  parseRegistry,
  REGISTRY_FILENAME,
  type Registry,
} from "../../src/quality/mutation-registry.ts";
import {
  main,
  type ReportMeta,
  renderIssueBody,
} from "../../src/quality/mutation-report.ts";

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const report = {
  files: {
    "src/sync/config.ts": {
      mutants: [
        {
          mutatorName: "EqualityOperator",
          status: "Killed",
          location: { start: { line: 10 } },
        },
        {
          mutatorName: "StringLiteral",
          status: "Survived",
          location: { start: { line: 42 } },
        },
        {
          mutatorName: "ConditionalExpression",
          status: "Survived",
          location: { start: { line: 7 } },
        },
      ],
    },
    "src/sync/scan.ts": {
      mutants: [
        {
          mutatorName: "MethodExpression",
          status: "NoCoverage",
          location: { start: { line: 3 } },
        },
        {
          mutatorName: "ArrowFunction",
          status: "Timeout",
          location: { start: { line: 9 } },
        },
      ],
    },
  },
};

const cleanReport = {
  files: {
    "src/sync/config.ts": {
      mutants: [
        {
          mutatorName: "EqualityOperator",
          status: "Killed",
          location: { start: { line: 10 } },
        },
      ],
    },
  },
};

const meta: ReportMeta = {
  runUrl: "https://github.com/mguinada/k-wiki/actions/runs/123456",
  htmlUrl:
    "https://github.com/mguinada/k-wiki/actions/runs/123456/artifacts/98765",
};
const RUN_URL = "https://github.com/mguinada/k-wiki/actions/runs/123456";

const HTML_URL =
  "https://github.com/mguinada/k-wiki/actions/runs/123456/artifacts/98765";

const HEAD = [
  "Mutation testing: actionable survivors — auto-filed from CI",
  "(issue #208). Advisory signal, never a gate. Kill survivors via",
  "the mutation-triage skill; adjudicated equivalents and artifacts",
  "live in .mutants-registry.json.",
].join("\n");

const EMPTY_REGISTRY: Registry = { entries: new Map() };

describe("renderIssueBody", () => {
  const ledger: Ledger = {
    entries: [
      {
        file: "src/sync/config.ts",
        line: 7,
        mutator: "ConditionalExpression",
        status: "Survived",
      },
      {
        file: "src/sync/config.ts",
        line: 42,
        mutator: "StringLiteral",
        status: "Survived",
      },
      {
        file: "src/sync/scan.ts",
        line: 3,
        mutator: "MethodExpression",
        status: "NoCoverage",
      },
    ],
  };

  it("renders the exact survivor body with both links and the ledger block", () => {
    expect(renderIssueBody(ledger, EMPTY_REGISTRY, meta)).toBe(
      [
        HEAD,
        "",
        `- Source run: ${RUN_URL}`,
        `- HTML report artifact: ${HTML_URL}`,
        "",
        "Untriaged mutants (3) — kill or record as adjudicated:",
        "",
        "```",
        "Survived  src/sync/config.ts:7  ConditionalExpression",
        "Survived  src/sync/config.ts:42  StringLiteral",
        "NoCoverage  src/sync/scan.ts:3  MethodExpression",
        "```",
        "",
        ledgerBlockLine(ledger),
        "",
      ].join("\n"),
    );
  });

  it("renders the exact survivor body without links", () => {
    expect(renderIssueBody(ledger, EMPTY_REGISTRY)).toBe(
      [
        HEAD,
        "Untriaged mutants (3) — kill or record as adjudicated:",
        "",
        "```",
        "Survived  src/sync/config.ts:7  ConditionalExpression",
        "Survived  src/sync/config.ts:42  StringLiteral",
        "NoCoverage  src/sync/scan.ts:3  MethodExpression",
        "```",
        "",
        ledgerBlockLine(ledger),
        "",
      ].join("\n"),
    );
  });

  it("renders the exact clean body with one link only", () => {
    expect(
      renderIssueBody({ entries: [] }, EMPTY_REGISTRY, { runUrl: RUN_URL }),
    ).toBe(
      [
        HEAD,
        "",
        `- Source run: ${RUN_URL}`,
        "",
        "No actionable mutants — nothing survived, nothing uncovered.",
        "",
        ledgerBlockLine({ entries: [] }),
        "",
      ].join("\n"),
    );
  });

  it("round-trips a rendered body back into the same ledger", () => {
    expect(ledgerFromBody(renderIssueBody(ledger, EMPTY_REGISTRY))).toEqual(
      ledger,
    );
  });
});

const script = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../dev/mutation-report.ts",
);

interface RunResult {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

function runNode(
  args: readonly string[],
  cwd: string = process.cwd(),
): Promise<RunResult> {
  const child = spawn(process.execPath, [realpathSync(script), ...args], {
    stdio: "pipe",
    cwd,
  });

  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";

    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

/** Write `report` as a mutation.json fixture and return its path. */
async function writeReport(
  dir: string,
  content: Record<string, unknown>,
): Promise<string> {
  const path = join(dir, "mutation.json");

  await writeFile(path, JSON.stringify(content));

  return path;
}

describe("mutation-report CLI", () => {
  it("prints the usage line for --help with exit 0", async () => {
    const result = await runNode(["--help"]);

    expect(`${result.code}|${result.out}`).toMatch(/0\|Usage: mutation-report/);
  });

  it("prints help without reading any file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-mutrep-"));

    tempDirs.push(dir);

    const result = await runNode(
      ["--help", join(dir, "does-not-exist.json")],
      dir,
    );

    expect(result.code).toBe(0);
    expect(result.err).toBe("");
  });

  it("prints the rendered body to stdout for a report file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-mutrep-"));

    tempDirs.push(dir);

    const reportPath = await writeReport(dir, report);
    const result = await runNode([
      reportPath,
      "--run-url",
      RUN_URL,
      "--html-url",
      HTML_URL,
    ]);

    expect(result.code).toBe(0);
    expect(result.out).toContain(
      "Survived  src/sync/config.ts:42  StringLiteral",
    );
    expect(result.out).toContain(meta.htmlUrl);
  });

  it("exits 1 naming the report when the path is unreadable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-mutrep-"));

    tempDirs.push(dir);

    const result = await runNode([join(dir, "missing.json")], dir);

    expect(result.code).toBe(1);
    expect(result.err).toContain("missing.json");
  });

  it("exits 1 naming the drifted shape for a non-report JSON file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-mutrep-"));

    tempDirs.push(dir);

    const reportPath = await writeReport(dir, { config: {} });
    const result = await runNode([
      reportPath,
      "--run-url",
      "u",
      "--html-url",
      "h",
    ]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("unexpected shape");
  });
});

describe("mutation-report merge CLI", () => {
  const priorBody = [
    HEAD,
    "",
    "Untriaged mutants (2) — kill or record as adjudicated:",
    "",
    "```",
    "Survived  src/old-window.ts:9  OldSurvivor",
    "Survived  src/sync/config.ts:42  StringLiteral",
    "```",
    "",
  ].join("\n");

  async function writeMergeInputs(
    dir: string,
  ): Promise<{ reportPath: string; priorPath: string }> {
    const reportPath = await writeReport(dir, report);
    const priorPath = join(dir, "prior-body.md");

    await writeFile(priorPath, priorBody);

    return { reportPath, priorPath };
  }

  it("merges a prior body: out-of-scope survivor stays listed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-mutrep-"));

    tempDirs.push(dir);

    const { reportPath, priorPath } = await writeMergeInputs(dir);
    const result = await runNode([reportPath, "--prior-body", priorPath]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("Survived  src/old-window.ts:9  OldSurvivor");
    expect(result.out).toContain(
      "Survived  src/sync/config.ts:7  ConditionalExpression",
    );
  });

  it("drops out-of-scope survivors with --absence-kills", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-mutrep-"));

    tempDirs.push(dir);

    const { reportPath, priorPath } = await writeMergeInputs(dir);
    const result = await runNode([
      reportPath,
      "--prior-body",
      priorPath,
      "--absence-kills",
    ]);

    expect(result.code).toBe(0);
    expect(result.out).not.toContain("OldSurvivor");
  });

  it("embeds the merged ledger block in the body", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-mutrep-"));

    tempDirs.push(dir);

    const { reportPath, priorPath } = await writeMergeInputs(dir);
    const result = await runNode([reportPath, "--prior-body", priorPath]);

    const body = result.out;

    expect(body).toContain("<!-- k-wiki-mutants-ledger: ");
    expect(ledgerFromBody(body).entries.length).toBe(4);
  });

  it("exits 1 naming --prior-body when its value is absent", async () => {
    const result = await runNode(["report.json", "--prior-body"]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("--prior-body requires a value");
  });

  it("exits 1 naming the prior-body path when it is unreadable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-mutrep-"));

    tempDirs.push(dir);

    const reportPath = await writeReport(dir, report);
    const result = await runNode([
      reportPath,
      "--prior-body",
      join(dir, "no-such-body.md"),
    ]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("no-such-body.md");
  });
});

describe("mutation-report main in-process", () => {
  /** Run `main` with console spies; restore state after. */
  const runMain = (
    argv: readonly string[],
  ): { out: string[]; err: string[] } => {
    const out: string[] = [];
    const err: string[] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...parts: unknown[]) => out.push(parts.join(" ")));
    const errSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...parts: unknown[]) => err.push(parts.join(" ")));

    process.exitCode = undefined;

    try {
      main(argv);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }

    return { out, err };
  };

  it("prints the usage line for --help in-process", () => {
    const { out } = runMain(["--help"]);

    expect(out[0]).toContain("Usage: mutation-report <report.json>");
  });

  it("leaves the exit code unset for --help", () => {
    runMain(["--help"]);

    expect(process.exitCode).toBeUndefined();

    process.exitCode = undefined;
  });

  it("exits 1 with the missing-report-path message for no arguments", () => {
    const { err } = runMain([]);

    expect(`${err[0]}|${process.exitCode ?? 0}`).toMatch(
      /missing <report\.json> — see --help\|1$/,
    );
  });

  it("exits 1 naming --run-url when its value is absent", () => {
    const { err } = runMain(["report.json", "--run-url"]);

    expect(`${err[0]}|${process.exitCode ?? 0}`).toMatch(
      /--run-url requires a value\|1$/,
    );
  });

  it("exits 1 naming --html-url when its value is absent", () => {
    const { err } = runMain(["report.json", "--html-url"]);

    expect(`${err[0]}|${process.exitCode ?? 0}`).toMatch(
      /--html-url requires a value\|1$/,
    );
  });

  it("exits 1 naming an unexpected extra positional", () => {
    const { err } = runMain(["a.json", "b.json"]);

    expect(`${err[0]}|${process.exitCode ?? 0}`).toMatch(
      /unexpected argument: b\.json\|1$/,
    );
  });

  it("prints the rendered body with flags before the positional", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-mutrep-"));

    tempDirs.push(dir);

    const reportPath = await writeReport(dir, cleanReport);
    const { out } = runMain([
      "--run-url",
      RUN_URL,
      "--html-url",
      HTML_URL,
      reportPath,
    ]);

    expect(out.join("\n")).toContain(
      "No actionable mutants — nothing survived, nothing uncovered.",
    );
  });

  it("keeps the exit code unset after rendering a valid report", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-mutrep-"));

    tempDirs.push(dir);

    const reportPath = await writeReport(dir, report);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    process.exitCode = undefined;

    try {
      main([reportPath]);

      expect(process.exitCode).toBeUndefined();
    } finally {
      logSpy.mockRestore();
      process.exitCode = undefined;
    }
  });

  it("exits 1 naming the report path when it cannot be read", () => {
    const { err } = runMain(["/nonexistent/mutation.json"]);

    expect(`${err[0]}|${process.exitCode ?? 0}`).toMatch(
      /cannot read the report at \/nonexistent\/mutation\.json\|1$/,
    );
  });

  it("exits 1 naming the drifted shape in-process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-mutrep-"));

    tempDirs.push(dir);

    const reportPath = await writeReport(dir, { config: {} });
    const { err } = runMain([reportPath]);

    expect(`${err[0]}|${process.exitCode ?? 0}`).toMatch(
      /unexpected shape.*\|1$/,
    );
  });
});

describe("mutation-report main flag routing in-process", () => {
  it("prints the usage line for -h in-process", () => {
    const out: string[] = [];
    const err: string[] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...parts: unknown[]) => out.push(parts.join(" ")));
    const errSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...parts: unknown[]) => err.push(parts.join(" ")));

    process.exitCode = undefined;

    try {
      main(["-h"]);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      process.exitCode = undefined;
    }

    expect(out[0]).toContain("Usage: mutation-report <report.json>");
  });

  it("routes --run-url onto the Source run link line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-mutrep-"));

    tempDirs.push(dir);

    const reportPath = await writeReport(dir, cleanReport);
    const out: string[] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...parts: unknown[]) => out.push(parts.join(" ")));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    process.exitCode = undefined;

    try {
      main([reportPath, "--run-url", RUN_URL]);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      process.exitCode = undefined;
    }

    expect(out.join("\n")).toBe(
      [
        HEAD,
        "",
        `- Source run: ${RUN_URL}`,
        "",
        "No actionable mutants — nothing survived, nothing uncovered.",
        "",
        ledgerBlockLine({ entries: [] }),
        "",
      ].join("\n"),
    );
  });

  it("routes --html-url onto the HTML report artifact link line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-mutrep-"));

    tempDirs.push(dir);

    const reportPath = await writeReport(dir, cleanReport);
    const out: string[] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...parts: unknown[]) => out.push(parts.join(" ")));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    process.exitCode = undefined;

    try {
      main([reportPath, "--html-url", HTML_URL]);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      process.exitCode = undefined;
    }

    expect(out.join("\n")).toBe(
      [
        HEAD,
        "",
        `- HTML report artifact: ${HTML_URL}`,
        "",
        "No actionable mutants — nothing survived, nothing uncovered.",
        "",
        ledgerBlockLine({ entries: [] }),
        "",
      ].join("\n"),
    );
  });

  it("exits 1 with the cannot-render message for invalid JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-mutrep-"));

    tempDirs.push(dir);

    const reportPath = join(dir, "mutation.json");

    await writeFile(reportPath, "not json at all");

    const err: string[] = [];
    const errSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...parts: unknown[]) => err.push(parts.join(" ")));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    process.exitCode = undefined;

    try {
      main([reportPath]);
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
    }

    expect(`${err[0]}|${process.exitCode ?? 0}`).toMatch(
      /cannot render the report at .*\|1$/,
    );

    process.exitCode = undefined;
  });

  it("uses argv past the interpreter and script for a bare main()", () => {
    const argv = process.argv;
    const err: string[] = [];
    const errSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...parts: unknown[]) => err.push(parts.join(" ")));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    process.argv = [argv[0] ?? "node", "mutation-report.ts"];
    process.exitCode = undefined;

    try {
      main();
    } finally {
      process.argv = argv;
      errSpy.mockRestore();
      logSpy.mockRestore();
    }

    expect(`${err[0]}|${process.exitCode ?? 0}`).toMatch(
      /missing <report\.json> — see --help\|1$/,
    );

    process.exitCode = undefined;
  });
});

/** The canonical mutated source: `a + b` at 1-based line 2, columns 10..15. */
const ADD_SOURCE = [
  "export function add(a: number, b: number): number {",
  "  return a + b;",
  "}",
].join("\n");

/** One identity-computable survivor over ADD_SOURCE: the `a + b`
 *  span at 1-based line 2, columns 10..15 (report coordinates). */
const addSurvivor = (mutator: string) => ({
  mutatorName: mutator,
  status: "Survived",
  replacement: "a - b",
  location: { start: { line: 2, column: 10 }, end: { line: 2, column: 15 } },
});

const addReader: Record<string, string> = { "src/math.ts": ADD_SOURCE };

const registryWith = (
  id: string,
  bucket: "equivalent" | "artifact",
): Registry =>
  parseRegistry(
    JSON.stringify({
      schema: 1,
      entries: {
        [id]: {
          bucket,
          justification: "Comparator ties are impossible (distinct paths).",
          pr: "https://github.com/mguinada/k-wiki/pull/237",
          date: "2026-08-31",
        },
      },
    }),
  );

describe("renderIssueBody with a populated registry", () => {
  const equivalentId = mutantIdentity(
    "src/math.ts",
    addSurvivor("ArithmeticOperator"),
    (file) => addReader[file],
  ) as string;

  const ledger: Ledger = {
    entries: [
      {
        id: equivalentId,
        file: "src/math.ts",
        line: 2,
        mutator: "ArithmeticOperator",
        status: "Survived",
      },
      {
        file: "src/math.ts",
        line: 3,
        mutator: "StringLiteral",
        status: "Survived",
      },
    ],
  };

  it("splits the counts: the recorded equivalent leaves the untriaged list, the recorded line carries it", () => {
    const body = renderIssueBody(
      ledger,
      registryWith(equivalentId, "equivalent"),
    );

    expect(body).toContain(
      "Untriaged mutants (1) — kill or record as adjudicated:",
    );
    expect(body).toContain(
      "Recorded adjudications (1) — filtered from the list above: 1 equivalent, 0 artifact (.mutants-registry.json).",
    );
    expect(body).toContain("Survived  src/math.ts:3  StringLiteral");
    expect(body).not.toContain("Survived  src/math.ts:2  ArithmeticOperator");
  });

  it("keeps the recorded entry inside the embedded ledger block — filtering is presentation only", () => {
    expect(
      ledgerFromBody(
        renderIssueBody(ledger, registryWith(equivalentId, "equivalent")),
      ),
    ).toEqual(ledger);
  });

  it("renders an artifact entry in its own section, distinct from equivalents", () => {
    const body = renderIssueBody(
      ledger,
      registryWith(equivalentId, "artifact"),
    );

    expect(body).toContain(
      "Artifact mutants (1) — measurement artifacts, plausibly killable, kept visible:",
    );
    expect(body).toContain(
      "- Survived  src/math.ts:2  ArithmeticOperator — Comparator ties are impossible (distinct paths). (https://github.com/mguinada/k-wiki/pull/237)",
    );
    expect(body).toContain("1 artifact");
  });

  it("renders the all-adjudicated line when no untriaged mutant remains", () => {
    const recorded = ledger.entries[0];

    if (recorded === undefined) {
      throw new Error("test fixture: ledger must carry the recorded entry");
    }

    const allRecorded: Ledger = { entries: [recorded] };

    expect(
      renderIssueBody(allRecorded, registryWith(equivalentId, "equivalent")),
    ).toContain(
      "No untriaged mutants — every actionable mutant is adjudicated.",
    );
  });

  it("renders prune candidates as their own section", () => {
    const body = renderIssueBody(
      { entries: [] },
      registryWith(equivalentId, "equivalent"),
      {
        prune: [
          {
            id: equivalentId,
            record: {
              bucket: "equivalent",
              justification: "Comparator ties are impossible (distinct paths).",
              pr: "https://github.com/mguinada/k-wiki/pull/237",
              date: "2026-08-31",
            },
          },
        ],
      },
    );

    expect(body).toContain(
      "Registry prune candidates (1) — not generated by this full run; remove from .mutants-registry.json in a PR:",
    );
    expect(body).toContain(
      `- ${equivalentId} recorded 2026-08-31 (https://github.com/mguinada/k-wiki/pull/237)`,
    );
  });
});

describe("mutation-report CLI with a registry on disk", () => {
  const equivalentId = () =>
    mutantIdentity(
      "src/math.ts",
      addSurvivor("ArithmeticOperator"),
      (file) => addReader[file],
    ) as string;

  /** A temp repo: sources (incl. the identical twin span), registry
   *  recording the first mutant, and a report over all three. */
  async function writeRegistryRepo(
    dir: string,
    registryText: string,
  ): Promise<string> {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "math.ts"), ADD_SOURCE);
    await writeFile(join(dir, "src", "twin.ts"), ADD_SOURCE);
    await writeFile(join(dir, REGISTRY_FILENAME), registryText);

    return writeReport(dir, {
      files: {
        "src/math.ts": {
          mutants: [
            addSurvivor("ArithmeticOperator"),
            addSurvivor("OptionalChaining"),
          ],
        },
        "src/twin.ts": {
          mutants: [addSurvivor("ArithmeticOperator")],
        },
      },
    });
  }

  const populated = () =>
    JSON.stringify({
      schema: 1,
      entries: {
        [equivalentId()]: {
          bucket: "equivalent",
          justification: "Comparator ties are impossible (distinct paths).",
          pr: "https://github.com/mguinada/k-wiki/pull/237",
          date: "2026-08-31",
        },
      },
    });

  it("filters the recorded mutant from the filing and keeps its unrecorded sibling listed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-mutrep-reg-"));

    tempDirs.push(dir);

    const reportPath = await writeRegistryRepo(dir, populated());
    const result = await runNode([reportPath], dir);

    expect(result.code).toBe(0);
    expect(result.out).not.toContain("src/math.ts:2  ArithmeticOperator");
    expect(result.out).toContain("src/math.ts:2  OptionalChaining");
    expect(result.out).toContain("Recorded adjudications (1)");
  });

  it("keeps the identical span in another file listed — the path is part of the identity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-mutrep-reg-"));

    tempDirs.push(dir);

    const reportPath = await writeRegistryRepo(dir, populated());
    const result = await runNode([reportPath], dir);

    expect(result.out).toContain("Survived  src/twin.ts:2  ArithmeticOperator");
  });

  it("keeps the recorded entry inside the ledger block it files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-mutrep-reg-"));

    tempDirs.push(dir);

    const reportPath = await writeRegistryRepo(dir, populated());
    const result = await runNode([reportPath], dir);

    expect(ledgerFromBody(result.out).entries).toHaveLength(3);
  });

  it("exits 1 naming the registry when it is present but corrupt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-mutrep-reg-"));

    tempDirs.push(dir);

    const reportPath = await writeRegistryRepo(dir, "{not json");
    const result = await runNode([reportPath], dir);

    expect(result.code).toBe(1);
    expect(result.err).toContain(REGISTRY_FILENAME);
  });

  it("exits 1 naming the registry when an entry lacks its receipt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-mutrep-reg-"));

    tempDirs.push(dir);

    const reportPath = await writeRegistryRepo(
      dir,
      JSON.stringify({
        schema: 1,
        entries: { [equivalentId()]: { bucket: "equivalent" } },
      }),
    );
    const result = await runNode([reportPath], dir);

    expect(result.code).toBe(1);
    expect(result.err).toContain("justification");
  });
});
