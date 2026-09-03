import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { main, stepSummaryMarkdown } from "../../src/board/board-triage.ts";
import type { GraphQLFn } from "../../src/board/triage-board.ts";
import { boardPage, fakeBoard, issueNode } from "./fake-board.ts";

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

afterEach(() => {
  process.exitCode = undefined;
});

describe("stepSummaryMarkdown", () => {
  it("renders the report as a markdown job summary", () => {
    const markdown = stepSummaryMarkdown({
      lines: [
        {
          text: "#101 Backlog → Ready — unblocked, no research label",
          level: "move",
        },
        { text: "#102 stays Backlog — blocked by open #9", level: "stay" },
      ],
      summary: "board-triage: 1 move, 1 stay, 0 untouched — dry run, no writes",
      moves: 1,
      ok: true,
      dryRun: true,
    });

    expect(markdown).toBe(
      [
        "## Board triage (dry run)",
        "",
        "- #101 Backlog → Ready — unblocked, no research label",
        "- #102 stays Backlog — blocked by open #9",
        "",
        "board-triage: 1 move, 1 stay, 0 untouched — dry run, no writes",
        "",
      ].join("\n"),
    );
  });

  it("renders the plain heading for an applied report", () => {
    const markdown = stepSummaryMarkdown({
      lines: [],
      summary:
        "board-triage: 0 moves, 0 stays, 0 untouched — verified against the board (0 reconciled)",
      moves: 0,
      ok: true,
      dryRun: false,
    });

    expect(markdown.startsWith("## Board triage\n")).toBe(true);
  });
});

describe("main", () => {
  async function runCli(
    args: string[],
    graphql: GraphQLFn | undefined,
    env: Record<string, string> = {},
  ): Promise<{ out: string[]; err: string[] }> {
    const argv = process.argv;
    const out: string[] = [];
    const err: string[] = [];
    const savedEnv: Record<string, string | undefined> = {};

    for (const key of [
      ...Object.keys(env),
      "GITHUB_STEP_SUMMARY",
      "NO_COLOR",
    ]) {
      savedEnv[key] = process.env[key];
    }

    process.argv = [...argv.slice(0, 2), ...args];
    Object.assign(process.env, env);
    delete process.env.NO_COLOR;
    process.exitCode = undefined;

    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...parts: unknown[]) => out.push(parts.join(" ")));
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...parts: unknown[]) => err.push(parts.join(" ")));

    try {
      await main(graphql);
    } finally {
      process.argv = argv;

      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }

      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    return { out, err };
  }

  it("prints the usage line for --help with exit 0 and no side effects", async () => {
    const { out, err } = await runCli(["--help"], undefined);

    expect(
      `${process.exitCode}|${err.length}|${out[0]?.startsWith("Usage: board-triage")}`,
    ).toBe("undefined|0|true");
  });

  it("rejects an unknown option with exit 1", async () => {
    const { err } = await runCli(["--wat"], undefined);

    expect(err[0]).toContain("unknown option");
    expect(process.exitCode).toBe(1);
  });

  it("rejects a positional argument with exit 1 instead of triaging the default board", async () => {
    const { err } = await runCli(["mguinada", "3"], undefined);

    expect(err[0]).toContain("unexpected argument");
    expect(process.exitCode).toBe(1);
  });

  it("rejects a non-numeric --project value with exit 1", async () => {
    const { err } = await runCli(["--project", "abc"], undefined);

    expect(err[0]).toContain("--project needs a project number");
    expect(process.exitCode).toBe(1);
  });

  it("rejects a valueless --owner with exit 1", async () => {
    const { err } = await runCli(["--owner"], undefined);

    expect(err[0]).toContain("--owner needs a login value");
    expect(process.exitCode).toBe(1);
  });

  it("rejects a valueless --project with exit 1 instead of triaging the default board", async () => {
    const { err } = await runCli(["--project"], undefined);

    expect(err[0]).toContain("--project needs a project number");
    expect(process.exitCode).toBe(1);
  });

  it("runs the injected client with the parsed owner and project", async () => {
    const seen: { owner: string; projectNumber: number }[] = [];
    const graphql: GraphQLFn = async (_query, variables) => {
      seen.push({
        owner: String(variables.owner),
        projectNumber: Number(variables.projectNumber),
      });

      return boardPage([issueNode({ id: "I1", number: 1, status: "Backlog" })]);
    };

    await runCli(["--owner", "octo", "--project", "27", "--dry-run"], graphql);

    expect(seen[0]).toEqual({ owner: "octo", projectNumber: 27 });
  });

  it("defaults the owner and project when the flags are absent", async () => {
    const seen: { owner: string; projectNumber: number }[] = [];
    const graphql: GraphQLFn = async (_query, variables) => {
      seen.push({
        owner: String(variables.owner),
        projectNumber: Number(variables.projectNumber),
      });

      return boardPage([
        issueNode({
          id: "I1",
          number: 9,
          status: "Backlog",
          blockers: [{ number: 4, state: "OPEN" }],
        }),
      ]);
    };

    await runCli([], graphql);

    expect(seen[0]).toEqual({ owner: "mguinada", projectNumber: 2 });
  });

  it("rejects a --project value with leading junk", async () => {
    const { err } = await runCli(["--project", "x7"], undefined);

    expect(err[0]).toContain("--project needs a project number");
    expect(process.exitCode).toBe(1);
  });

  it("rejects a --project value with trailing junk", async () => {
    const { err } = await runCli(["--project", "7x"], undefined);

    expect(err[0]).toContain("--project needs a project number");
    expect(process.exitCode).toBe(1);
  });

  it("prints the same usage line for -h as for --help", async () => {
    const { out } = await runCli(["-h"], undefined);

    expect(out[0]?.startsWith("Usage: board-triage")).toBe(true);
  });

  it("carries the CLI name in the unknown-option error", async () => {
    const { err } = await runCli(["--wat"], undefined);

    expect(err[0]).toContain("board-triage: unknown option");
  });

  it("carries the CLI name in the --project usage error", async () => {
    const { err } = await runCli(["--project", "abc"], undefined);

    expect(err[0]).toContain("board-triage: --project needs a project number");
  });

  it("stays green when GITHUB_STEP_SUMMARY is empty", async () => {
    const { graphql } = fakeBoard([
      issueNode({
        id: "I1",
        number: 9,
        status: "Backlog",
        blockers: [{ number: 4, state: "OPEN" }],
      }),
    ]);

    const { err } = await runCli([], graphql, { GITHUB_STEP_SUMMARY: "" });

    expect(err).toEqual([]);
  });

  it("renders move lines green with colors forced", async () => {
    const { graphql } = fakeBoard([
      issueNode({ id: "I1", number: 7, status: "Backlog" }),
    ]);

    const { out } = await runCli([], graphql);

    expect(
      out.some((line) => line.startsWith("\u001b[32m#7 Backlog → Ready")),
    ).toBe(true);
  });

  it("renders stay lines dim with colors forced", async () => {
    const { graphql } = fakeBoard([
      issueNode({
        id: "I1",
        number: 9,
        status: "Backlog",
        blockers: [{ number: 4, state: "OPEN" }],
      }),
    ]);

    const { out } = await runCli([], graphql);

    expect(
      out.some((line) => line.startsWith("\u001b[2m#9 stays Backlog")),
    ).toBe(true);
  });

  it("renders a failed move line red with colors forced", async () => {
    const { graphql } = fakeBoard(
      [issueNode({ id: "I1", number: 7, status: "Backlog" })],
      { failAlways: ["I1"] },
    );

    const { err } = await runCli([], graphql);

    expect(
      err.some((line) =>
        line.startsWith("\u001b[31m#7 Backlog → Ready not verified"),
      ),
    ).toBe(true);
  });

  it("renders the failed summary red on stderr with colors forced", async () => {
    const { graphql } = fakeBoard(
      [issueNode({ id: "I1", number: 7, status: "Backlog" })],
      { failAlways: ["I1"] },
    );

    const { err } = await runCli([], graphql);

    expect(
      err.some((line) => line.startsWith("\u001b[31mboard-triage: 1 move")),
    ).toBe(true);
  });

  it("renders the dry-run plan on stdout and appends the job summary when GITHUB_STEP_SUMMARY is set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-triage-summary-"));

    tempDirs.push(dir);

    const summaryPath = join(dir, "summary.md");
    const { graphql } = fakeBoard([
      issueNode({ id: "I1", number: 7, status: "Backlog" }),
    ]);

    const { out } = await runCli(["--dry-run"], graphql, {
      GITHUB_STEP_SUMMARY: summaryPath,
      NO_COLOR: "1",
    });

    expect(
      out.some((line) => line.includes("#7 Backlog → Ready — unblocked")),
    ).toBe(true);
    expect(await readFile(summaryPath, "utf8")).toContain(
      "## Board triage (dry run)",
    );
  });

  it("reports a failing client red on stderr with exit 1", async () => {
    const graphql: GraphQLFn = async () => {
      throw new Error("boom");
    };

    const { err } = await runCli([], graphql);

    expect(err[0]).toContain("board-triage: boom");
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 when a move fails verification", async () => {
    const { graphql } = fakeBoard(
      [issueNode({ id: "I1", number: 7, status: "Backlog" })],
      {
        failAlways: ["I1"],
      },
    );

    const { err } = await runCli([], graphql);

    expect(err.some((line) => line.includes("not verified"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("exits 0 on a green applied run", async () => {
    const { graphql } = fakeBoard([
      issueNode({ id: "I1", number: 7, status: "Backlog" }),
    ]);

    const { out } = await runCli([], graphql);

    expect(out.some((line) => line.includes("#7 Backlog → Ready"))).toBe(true);
    expect(
      out.some((line) => line.includes("verified against the board")),
    ).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("drives the real gh binary from PATH when no client is injected", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-triage-main-gh-"));

    tempDirs.push(dir);
    await writeFile(
      join(dir, "page.json"),
      JSON.stringify(
        boardPage([issueNode({ id: "I1", number: 7, status: "Backlog" })]),
      ),
    );
    await writeFile(
      join(dir, "gh"),
      '#!/bin/sh\nif [ "$1" != "api" ]; then exit 9; fi\ncat ' +
        JSON.stringify(join(dir, "page.json")) +
        "\n",
      { mode: 0o755 },
    );

    const { out } = await runCli(["--dry-run"], undefined, {
      PATH: `${dir}:${process.env.PATH ?? ""}`,
    });

    expect(out.some((line) => line.includes("#7 Backlog → Ready"))).toBe(true);
  });
});
