import { describe, expect, it } from "vitest";
import { parseLinkInner, parseNote } from "./parse";

describe("parseNote links", () => {
  it("parses plain, aliased, heading, block and embed links", () => {
    const text = "[[A]] [[B|bee]] [[C#Intro]] [[D#^blk]] ![[img.png]]";
    const links = parseNote(text).links;
    expect(links.map((l) => [l.target, l.alias, l.heading, l.block, l.embed])).toEqual([
      ["A", undefined, undefined, undefined, false],
      ["B", "bee", undefined, undefined, false],
      ["C", undefined, "Intro", undefined, false],
      ["D", undefined, undefined, "blk", false],
      ["img.png", undefined, undefined, undefined, true],
    ]);
    expect(text.slice(links[4].start, links[4].end)).toBe("![[img.png]]");
  });

  it("records the line and ignores links in code", () => {
    const text = "[[A]]\n\n`[[no]]`\n```\n[[nope]]\n```\n[[B]]";
    const links = parseNote(text).links;
    expect(links.map((l) => [l.target, l.line])).toEqual([["A", 0], ["B", 6]]);
  });

  it("handles escaped pipes (tables) and same-note heading links", () => {
    expect(parseLinkInner("A\\|b")).toMatchObject({ target: "A", alias: "b" });
    expect(parseLinkInner("#Heading")).toMatchObject({ target: "", heading: "Heading" });
  });
});

describe("parseNote tags", () => {
  it("finds body tags, nested tags and skips numbers, headings and code", () => {
    const text = "# Title\n\nHello #foo and #a/b/c, #한글 not#tag #123 `#code`\n```\n#fenced\n```\n";
    expect(parseNote(text).tags.sort()).toEqual(["a/b/c", "foo", "한글"].sort());
  });

  it("merges front matter tags in every YAML shape", () => {
    expect(parseNote("---\ntags: [x, \"y\"]\n---\n#z").tags.sort()).toEqual(["x", "y", "z"]);
    expect(parseNote("---\ntags:\n  - one\n  - two\n---\n").tags).toEqual(["one", "two"]);
    expect(parseNote("---\ntags: a, b\n---\n").tags).toEqual(["a", "b"]);
  });
});

describe("parseNote metadata", () => {
  it("reads aliases and headings", () => {
    const note = parseNote("---\naliases: [Foo, Bar]\n---\n# One\ntext\n## Two ##\n```\n# not heading\n```");
    expect(note.aliases).toEqual(["Foo", "Bar"]);
    expect(note.headings).toEqual([
      { level: 1, text: "One", line: 3 },
      { level: 2, text: "Two", line: 5 },
    ]);
  });
});
