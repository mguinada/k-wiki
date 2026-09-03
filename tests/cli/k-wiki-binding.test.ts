import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  BINDING_FILE,
  CHECKOUT_ENV,
  findBindingFile,
  parseBinding,
  resolveCheckout,
} from "../../src/cli/k-wiki-binding.ts";

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

interface Fixture {
  /** A project directory the checkout may be resolved from. */
  readonly project: string;
  /** The checkout path the default binding names. */
  readonly checkout: string;
}

/**
 * A project directory plus the checkout its default binding names;
 * `binding` replaces the default single-wiki binding text.
 */
async function makeBoundProject(binding?: string): Promise<Fixture> {
  const checkout = await mkdtemp(join(tmpdir(), "k-wiki-bind-co-"));
  const project = await mkdtemp(join(tmpdir(), "k-wiki-bind-proj-"));

  tempDirs.push(checkout, project);
  await mkdir(join(project, "nested"), { recursive: true });

  const text = binding ?? JSON.stringify({ checkout });

  await writeFile(join(project, BINDING_FILE), text);

  return { project, checkout };
}

describe("parseBinding", () => {
  it("accepts the single-wiki form and expands ~ in checkout", () => {
    const binding = parseBinding(
      '{ "checkout": "~/k-wiki", "settings": "settings-meta.yml" }',
      "/proj/.k-wiki.json",
      "/home/u",
    );

    expect(binding).toEqual({
      checkout: "/home/u/k-wiki",
      settings: "settings-meta.yml",
    });
  });

  it("makes settings optional", () => {
    const binding = parseBinding(
      '{ "checkout": "/abs/k-wiki" }',
      "/proj/.k-wiki.json",
      "/home/u",
    );

    expect(binding.settings).toBeUndefined();
  });

  it("rejects a top-level array with the one-wiki error", () => {
    expect(() =>
      parseBinding(
        '[{ "checkout": "/a" }, { "checkout": "/b" }]',
        "/proj/.k-wiki.json",
        "/home/u",
      ),
    ).toThrow("one project binds exactly one wiki");
  });

  it("rejects a list under checkout", () => {
    expect(() =>
      parseBinding(
        '{ "checkout": ["/a", "/b"] }',
        "/proj/.k-wiki.json",
        "/home/u",
      ),
    ).toThrow('"checkout" must be a non-empty string');
  });

  it("rejects unknown keys such as a checkouts list", () => {
    expect(() =>
      parseBinding(
        '{ "checkouts": ["/a", "/b"] }',
        "/proj/.k-wiki.json",
        "/home/u",
      ),
    ).toThrow('unknown key "checkouts"');
  });

  it("names the expected single-object shape when rejecting", () => {
    expect(() =>
      parseBinding('{ "checkouts": ["/a"] }', "/proj/.k-wiki.json", "/home/u"),
    ).toThrow("a single JSON object");
  });

  it("rejects a missing checkout", () => {
    expect(() =>
      parseBinding('{ "settings": "x.yml" }', "/proj/.k-wiki.json", "/home/u"),
    ).toThrow('"checkout" must be a non-empty string');
  });

  it("rejects an empty checkout", () => {
    expect(() =>
      parseBinding('{ "checkout": "" }', "/proj/.k-wiki.json", "/home/u"),
    ).toThrow('"checkout" must be a non-empty string');
  });

  it("rejects text that is not valid JSON", () => {
    expect(() =>
      parseBinding("{ not json", "/proj/.k-wiki.json", "/home/u"),
    ).toThrow("not valid JSON");
  });

  it("carries the JSON syntax error as the rejection cause", () => {
    let thrown: unknown;

    try {
      parseBinding("{ not json", "/proj/.k-wiki.json", "/home/u");
    } catch (error) {
      thrown = error;
    }

    expect((thrown as { cause?: unknown }).cause).toBeInstanceOf(SyntaxError);
  });

  it("rejects a non-string settings value", () => {
    expect(() =>
      parseBinding(
        '{ "checkout": "/a", "settings": 3 }',
        "/proj/.k-wiki.json",
        "/home/u",
      ),
    ).toThrow('"settings" must be a non-empty string');
  });

  it("rejects an empty settings value", () => {
    expect(() =>
      parseBinding(
        '{ "checkout": "/a", "settings": "" }',
        "/proj/.k-wiki.json",
        "/home/u",
      ),
    ).toThrow('"settings" must be a non-empty string');
  });

  it("rejects a null settings value", () => {
    expect(() =>
      parseBinding(
        '{ "checkout": "/a", "settings": null }',
        "/proj/.k-wiki.json",
        "/home/u",
      ),
    ).toThrow('"settings" must be a non-empty string');
  });
});

describe("findBindingFile", () => {
  it("finds the binding in the start directory itself", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-bind-"));

    tempDirs.push(dir);
    await writeFile(join(dir, BINDING_FILE), '{ "checkout": "/a" }');

    expect(await findBindingFile(dir, "/nonexistent/home")).toBe(
      join(dir, BINDING_FILE),
    );
  });

  it("finds the nearest binding walking upward", async () => {
    const base = await mkdtemp(join(tmpdir(), "k-wiki-bind-"));

    tempDirs.push(base);
    await mkdir(join(base, "outer", "inner"), { recursive: true });
    await writeFile(
      join(base, "outer", BINDING_FILE),
      '{ "checkout": "/outer" }',
    );
    await writeFile(join(base, BINDING_FILE), '{ "checkout": "/base" }');

    expect(
      await findBindingFile(join(base, "outer", "inner"), "/nonexistent/home"),
    ).toBe(join(base, "outer", BINDING_FILE));
  });

  it("stops at home after checking it", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "k-wiki-home-"));

    tempDirs.push(fakeHome);
    await mkdir(join(fakeHome, "proj"), { recursive: true });
    await writeFile(
      join(fakeHome, BINDING_FILE),
      '{ "checkout": "/home-bound" }',
    );

    expect(await findBindingFile(join(fakeHome, "proj"), fakeHome)).toBe(
      join(fakeHome, BINDING_FILE),
    );
  });

  it("never looks above home", async () => {
    const parent = await mkdtemp(join(tmpdir(), "k-wiki-home-"));
    const fakeHome = join(parent, "home");

    tempDirs.push(parent);
    await mkdir(join(fakeHome, "proj"), { recursive: true });
    await writeFile(
      join(parent, BINDING_FILE),
      '{ "checkout": "/above-home" }',
    );

    expect(await findBindingFile(join(fakeHome, "proj"), fakeHome)).toBe(
      undefined,
    );
  });

  it("climbs toward the root when the start dir is outside home", async () => {
    const base = await mkdtemp(join(tmpdir(), "k-wiki-bind-"));

    tempDirs.push(base);
    await mkdir(join(base, "a", "b"), { recursive: true });
    await writeFile(join(base, BINDING_FILE), '{ "checkout": "/base" }');

    expect(
      await findBindingFile(join(base, "a", "b"), "/nonexistent/home"),
    ).toBe(join(base, BINDING_FILE));
  });

  it("returns undefined when no binding exists on the walk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-bind-"));

    tempDirs.push(dir);

    expect(await findBindingFile(dir, "/nonexistent/home")).toBe(undefined);
  });
});

describe("resolveCheckout", () => {
  it("prefers the explicit flag over env and binding file", async () => {
    const h = await makeBoundProject();

    expect(
      await resolveCheckout({
        flag: "/flag/checkout",
        env: { [CHECKOUT_ENV]: h.checkout },
        cwd: h.project,
        home: "/nonexistent/home",
      }),
    ).toEqual({
      checkout: "/flag/checkout",
      settings: undefined,
      origin: "flag",
    });
  });

  it("prefers the env var over the binding file", async () => {
    const h = await makeBoundProject();

    expect(
      await resolveCheckout({
        flag: undefined,
        env: { [CHECKOUT_ENV]: "/env/checkout" },
        cwd: h.project,
        home: "/nonexistent/home",
      }),
    ).toEqual({
      checkout: "/env/checkout",
      settings: undefined,
      origin: "env",
    });
  });

  it("uses the binding file's checkout and settings before cwd", async () => {
    const h = await makeBoundProject();

    await writeFile(
      join(h.project, BINDING_FILE),
      JSON.stringify({ checkout: h.checkout, settings: "settings-alt.yml" }),
    );

    expect(
      await resolveCheckout({
        flag: undefined,
        env: {},
        cwd: h.project,
        home: "/nonexistent/home",
      }),
    ).toEqual({
      checkout: h.checkout,
      settings: "settings-alt.yml",
      origin: "file",
    });
  });

  it("falls back to the cwd when nothing resolves", async () => {
    const dir = await mkdtemp(join(tmpdir(), "k-wiki-cwd-"));

    tempDirs.push(dir);

    expect(
      await resolveCheckout({
        flag: undefined,
        env: {},
        cwd: dir,
        home: "/nonexistent/home",
      }),
    ).toEqual({ checkout: dir, settings: undefined, origin: "cwd" });
  });

  it("expands ~ in the flag value", async () => {
    expect(
      await resolveCheckout({
        flag: "~/co-flag",
        env: {},
        cwd: "/anywhere",
        home: "/home/u",
      }),
    ).toEqual({
      checkout: "/home/u/co-flag",
      settings: undefined,
      origin: "flag",
    });
  });

  it("expands ~ in the env value", async () => {
    expect(
      await resolveCheckout({
        flag: undefined,
        env: { [CHECKOUT_ENV]: "~/co-env" },
        cwd: "/anywhere",
        home: "/home/u",
      }),
    ).toEqual({
      checkout: "/home/u/co-env",
      settings: undefined,
      origin: "env",
    });
  });

  it("treats an empty env value as unset and falls through to the binding file", async () => {
    const h = await makeBoundProject();

    expect(
      await resolveCheckout({
        flag: undefined,
        env: { [CHECKOUT_ENV]: "" },
        cwd: h.project,
        home: "/nonexistent/home",
      }),
    ).toEqual({
      checkout: h.checkout,
      settings: undefined,
      origin: "file",
    });
  });

  it("throws naming the binding file when it is invalid", async () => {
    const h = await makeBoundProject('[{ "checkout": "/a" }]');

    await expect(
      resolveCheckout({
        flag: undefined,
        env: {},
        cwd: h.project,
        home: "/nonexistent/home",
      }),
    ).rejects.toThrow(`invalid binding at ${join(h.project, BINDING_FILE)}`);
  });
});
