import { describe, expect, it } from "vitest";
import { basename, dirname, extname, isHidden, isWithin, normalizePath, stem } from "./paths";

describe("paths", () => {
  it("normalizes separators, dots and slashes", () => {
    expect(normalizePath("/a//b/./c.md/")).toBe("a/b/c.md");
    expect(normalizePath("a\\b\\c.md")).toBe("a/b/c.md");
    expect(normalizePath("a/b/../c.md")).toBe("a/c.md");
    expect(normalizePath("")).toBe("");
  });

  it("rejects paths escaping the vault", () => {
    expect(() => normalizePath("../secret.md")).toThrow(/invalid-path/);
  });

  it("splits names like Obsidian does", () => {
    expect(dirname("a/b/Note.md")).toBe("a/b");
    expect(dirname("Note.md")).toBe("");
    expect(basename("a/b/Note.md")).toBe("Note.md");
    expect(extname("a/Note.MD")).toBe("md");
    expect(extname(".gitignore")).toBe("");
    expect(stem("a/My Note.md")).toBe("My Note");
  });

  it("detects hidden and nested paths", () => {
    expect(isHidden(".obsidian/app.json")).toBe(true);
    expect(isHidden("a/b.md")).toBe(false);
    expect(isWithin("a/b/c.md", "a")).toBe(true);
    expect(isWithin("ab/c.md", "a")).toBe(false);
    expect(isWithin("anything", "")).toBe(true);
  });
});
