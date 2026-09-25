import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MARKER_PATH,
  markerPath,
  parseSharedWriterMarker,
  readSharedWriterMarker,
} from "../../src/writer/marker.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function dataRepoWithMarker(marker: string | undefined): Promise<string> {
  const dataRoot = await mkdtemp(join(tmpdir(), "marker-"));
  tempDirs.push(dataRoot);

  if (marker !== undefined) {
    await mkdir(join(dataRoot, ".k-wiki"), { recursive: true });
    await writeFile(join(dataRoot, MARKER_PATH), marker);
  }

  return dataRoot;
}

const VALID = {
  version: 1,
  remote: "origin",
  branch: "main",
  leaseRef: "refs/k-wiki/leases/shared-writer-v1",
  sourceRemovalPolicy: "confirm",
};

describe("markerPath", () => {
  it("joins the marker path under the data repo root", () => {
    expect(markerPath("/data")).toBe("/data/.k-wiki/shared-writer.json");
  });
});

describe("parseSharedWriterMarker", () => {
  it("accepts the v1 schema verbatim", () => {
    const marker = parseSharedWriterMarker(JSON.stringify(VALID), "origin");

    expect(marker).toEqual(VALID);
  });

  it("rejects text that is not valid JSON, naming the origin", () => {
    expect(() => parseSharedWriterMarker("{nope", "m.json")).toThrow(
      /m\.json: not valid JSON/,
    );
  });

  it("rejects a non-object document", () => {
    expect(() => parseSharedWriterMarker("[]", "m.json")).toThrow(
      /expected a JSON object/,
    );
  });

  it("rejects an unknown version so a future format fails closed", () => {
    const text = JSON.stringify({ ...VALID, version: 2 });

    expect(() => parseSharedWriterMarker(text, "m.json")).toThrow(
      /unsupported "version" 2/,
    );
  });

  it("rejects an unknown top-level key", () => {
    const text = JSON.stringify({ ...VALID, ttl: 60 });

    expect(() => parseSharedWriterMarker(text, "m.json")).toThrow(/"ttl"/);
  });

  it("rejects an empty remote name", () => {
    const text = JSON.stringify({ ...VALID, remote: "" });

    expect(() => parseSharedWriterMarker(text, "m.json")).toThrow(/"remote"/);
  });

  it("rejects a branch name carrying a space", () => {
    const text = JSON.stringify({ ...VALID, branch: "two words" });

    expect(() => parseSharedWriterMarker(text, "m.json")).toThrow(/"branch"/);
  });

  it("rejects a branch name given as a full ref", () => {
    const text = JSON.stringify({ ...VALID, branch: "refs/heads/main" });

    expect(() => parseSharedWriterMarker(text, "m.json")).toThrow(/"branch"/);
  });

  it("rejects a leaseRef outside the k-wiki lease namespace", () => {
    const text = JSON.stringify({ ...VALID, leaseRef: "refs/heads/main" });

    expect(() => parseSharedWriterMarker(text, "m.json")).toThrow(
      /refs\/k-wiki\/leases\//,
    );
  });

  it("rejects a bare lease leaf without the refs/ prefix", () => {
    const text = JSON.stringify({ ...VALID, leaseRef: "shared-writer-v1" });

    expect(() => parseSharedWriterMarker(text, "m.json")).toThrow(/"leaseRef"/);
  });

  it("rejects a sourceRemovalPolicy other than confirm", () => {
    const text = JSON.stringify({ ...VALID, sourceRemovalPolicy: "allow" });

    expect(() => parseSharedWriterMarker(text, "m.json")).toThrow(
      /"sourceRemovalPolicy"/,
    );
  });
});

describe("readSharedWriterMarker", () => {
  it("reports absent when the data repo carries no marker", async () => {
    const dataRoot = await dataRepoWithMarker(undefined);

    expect(await readSharedWriterMarker(dataRoot)).toEqual({ kind: "absent" });
  });

  it("reports enabled with the parsed marker", async () => {
    const dataRoot = await dataRepoWithMarker(JSON.stringify(VALID));
    const read = await readSharedWriterMarker(dataRoot);

    expect(read).toEqual({ kind: "enabled", marker: VALID });
  });

  it("reports invalid, with the reason, for a malformed marker", async () => {
    const dataRoot = await dataRepoWithMarker("{oops");

    expect(await readSharedWriterMarker(dataRoot)).toMatchObject({
      kind: "invalid",
      reason: expect.stringContaining("not valid JSON"),
    });
  });

  it("reports invalid for an unknown protocol version", async () => {
    const dataRoot = await dataRepoWithMarker(
      JSON.stringify({ ...VALID, version: 9 }),
    );

    expect(await readSharedWriterMarker(dataRoot)).toMatchObject({
      kind: "invalid",
      reason: expect.stringContaining("unsupported"),
    });
  });
});
