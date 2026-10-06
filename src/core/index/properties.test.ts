import { describe, expect, it } from "vitest";
import { convertValue, readProperties, removeProperty, setProperty } from "./properties";

const note = `---
title: Hello
count: 3
done: true
due: 2026-10-06
tags:
  - a
  - b
aliases: [x, "y z"]
# a comment
meta:
  nested: 1
quoted: "12"
---
# Body
text`;

describe("readProperties", () => {
  it("types each value", () => {
    const props = readProperties(note);
    expect(props.map((p) => [p.key, p.type, p.value])).toEqual([
      ["title", "text", "Hello"],
      ["count", "number", 3],
      ["done", "checkbox", true],
      ["due", "date", "2026-10-06"],
      ["tags", "list", ["a", "b"]],
      ["aliases", "list", ["x", "y z"]],
      ["meta", "raw", "  nested: 1"],
      ["quoted", "text", "12"],
    ]);
  });
  it("returns nothing without front matter", () => {
    expect(readProperties("# Just text")).toEqual([]);
    expect(readProperties("---\n---\nbody")).toEqual([]);
  });
  it("reads Korean keys and values", () => {
    expect(readProperties("---\n제목: 안녕\n---\n")).toEqual([{ key: "제목", type: "text", value: "안녕" }]);
  });
});

describe("setProperty", () => {
  it("replaces only the one key and keeps the rest byte-for-byte", () => {
    const out = setProperty(note, "count", 4);
    expect(out).toBe(note.replace("count: 3", "count: 4"));
  });
  it("replaces a block list with a new list", () => {
    const out = setProperty(note, "tags", ["a", "c", "d"]);
    expect(out).toContain("tags:\n  - a\n  - c\n  - d\naliases:");
    expect(out.endsWith("# Body\ntext")).toBe(true);
  });
  it("appends a new key before the closing fence", () => {
    expect(setProperty("---\na: 1\n---\nbody", "b", "two")).toBe("---\na: 1\nb: two\n---\nbody");
  });
  it("creates front matter when missing", () => {
    expect(setProperty("body\n", "status", "draft")).toBe("---\nstatus: draft\n---\nbody\n");
  });
  it("fills an empty block and keeps CRLF", () => {
    expect(setProperty("---\n---\nbody", "a", true)).toBe("---\na: true\n---\nbody");
    expect(setProperty("---\r\na: 1\r\n---\r\nbody", "b", 2)).toBe("---\r\na: 1\r\nb: 2\r\n---\r\nbody");
  });
  it("quotes values that would change meaning", () => {
    expect(setProperty("", "a", "12")).toContain('a: "12"');
    expect(setProperty("", "a", "yes")).toContain('a: "yes"');
    expect(setProperty("", "a", "[[Note]]")).toContain('a: "[[Note]]"');
    expect(setProperty("", "a", "x: y")).toContain('a: "x: y"');
    expect(setProperty("", "a", 'say "hi"')).toContain('a: say "hi"');
    expect(setProperty("", "d", "2026-10-06", "date")).toContain("d: 2026-10-06");
    expect(readProperties(setProperty("", "a", "he said: \"x\"\nnext"))[0].value).toBe('he said: "x"\nnext');
  });
  it("round-trips what it writes", () => {
    let t = "";
    t = setProperty(t, "list", ["a b", "c: d", "12"]);
    t = setProperty(t, "empty", []);
    t = setProperty(t, "ok", false);
    expect(readProperties(t).map((p) => p.value)).toEqual([["a b", "c: d", "12"], [], false]);
  });
});

describe("removeProperty", () => {
  it("removes a whole block including list items", () => {
    const out = removeProperty(note, "tags");
    expect(out).not.toContain("tags:");
    expect(out).not.toContain("  - a");
    expect(out).toContain("aliases:");
  });
  it("drops the fences when nothing is left", () => {
    expect(removeProperty("---\na: 1\n---\nbody", "a")).toBe("body");
  });
  it("leaves text alone when the key is missing", () => {
    expect(removeProperty(note, "nope")).toBe(note);
  });
});

describe("convertValue", () => {
  it("converts between types", () => {
    expect(convertValue("a, b", "list")).toEqual(["a", "b"]);
    expect(convertValue(["a", "b"], "text")).toBe("a, b");
    expect(convertValue("12", "number")).toBe(12);
    expect(convertValue("abc", "number")).toBe(0);
    expect(convertValue("true", "checkbox")).toBe(true);
    expect(convertValue("2026-10-06", "date")).toBe("2026-10-06");
  });
});
