import { describe, expect, it } from "vitest";
import { buildPageIndex, unfencedLines } from "../../src/wiki/wiki-links.ts";

/** The fence rule of the shared scanner (issue #246 C-10): an opening
 *  fence is any 3+ backtick/tilde marker (info string allowed); a
 *  closing fence must be bare (no info string), use the same character,
 *  and be at least as long as the opener — CommonMark's rule. */

function unfenced(text: string): string[] {
  return [...unfencedLines(text)].map(([, line]) => line);
}

describe("unfencedLines fence rules", () => {
  it("does not close a fence on a same-char marker with an info string", () => {
    const lines = unfenced("```\nfenced\n```js\nstill fenced\n```\nafter");

    expect(lines).toEqual(["after"]);
  });

  it("does not close a fence on a shorter same-char marker", () => {
    const lines = unfenced("````\nfenced\n```\nstill fenced\n````\nafter");

    expect(lines).toEqual(["after"]);
  });

  it("opens a fence on a marker with an info string", () => {
    const lines = unfenced("```ts\nfenced\n```\nafter");

    expect(lines).toEqual(["after"]);
  });

  it("closes on a longer bare same-char marker", () => {
    const lines = unfenced("```\nfenced\n`````\nafter");

    expect(lines).toEqual(["after"]);
  });

  it("does not close a tilde fence on a backtick marker", () => {
    const lines = unfenced("~~~\nfenced\n```\nstill fenced\n~~~\nafter");

    expect(lines).toEqual(["after"]);
  });
});

describe("buildPageIndex", () => {
  it("maps page names to their wiki-relative paths", () => {
    expect(
      buildPageIndex(["index.md", "sources/temp research.md", "img.png"]),
    ).toEqual(
      new Map([
        ["index", "index.md"],
        ["temp research", "sources/temp research.md"],
      ]),
    );
  });

  it("lets later files win when two pages share one name", () => {
    expect(buildPageIndex(["concepts/temp.md", "sources/temp.md"])).toEqual(
      new Map([["temp", "sources/temp.md"]]),
    );
  });
});
