import { describe, expect, it } from "vitest";
import { MemoryAdapter } from "../vault/memory-adapter";
import { NoteIndex } from "./note-index";

async function build(files: Record<string, string>) {
  const index = new NoteIndex();
  await index.load(new MemoryAdapter("t", files));
  return index;
}

describe("link resolution", () => {
  it("prefers the shortest path, then the linking note's folder", async () => {
    const index = await build({ "a/b/Note.md": "", "Note.md": "", "x/Dup.md": "", "y/Dup.md": "" });
    expect(index.resolve("Note", "z.md")).toBe("Note.md");
    expect(index.resolve("Dup", "y/other.md")).toBe("y/Dup.md");
    expect(index.resolve("b/Note", "z.md")).toBe("a/b/Note.md");
    expect(index.resolve("note.md", "z.md")).toBe("Note.md");
    expect(index.resolve("Missing", "z.md")).toBeNull();
  });

  it("falls back to aliases and resolves attachments by full name", async () => {
    const index = await build({ "People/Bob.md": "---\naliases: [Robert]\n---\n", "files/pic.png": "" });
    expect(index.resolve("Robert", "x.md")).toBe("People/Bob.md");
    expect(index.resolve("pic.png", "x.md")).toBe("files/pic.png");
    expect(index.resolve("pic", "x.md")).toBeNull();
  });

  it("builds minimal link text", async () => {
    const index = await build({ "a/Same.md": "", "b/Same.md": "", "Unique.md": "" });
    expect(index.linkTextFor("Unique.md")).toBe("Unique");
    expect(index.linkTextFor("a/Same.md")).toBe("a/Same");
  });
});

describe("NoteIndex", () => {
  it("computes links, backlinks and unresolved targets", async () => {
    const index = await build({
      "A.md": "see [[B]] and [[Ghost]]\n[[B|again]]",
      "B.md": "back to [[A]] #t",
      "C.md": "![[B]] self [[C]]",
    });
    expect(index.linksFrom("A.md").map((l) => l.resolved)).toEqual(["B.md", null, "B.md"]);
    expect(index.backlinksTo("B.md").map((b) => [b.source, b.context])).toEqual([
      ["A.md", "see [[B]] and [[Ghost]]"],
      ["A.md", "[[B|again]]"],
      ["C.md", "![[B]] self [[C]]"],
    ]);
    expect(index.backlinksTo("A.md").map((b) => b.source)).toEqual(["B.md"]);
    expect(index.backlinksTo("C.md")).toEqual([]);
    expect([...index.unresolved()]).toEqual([["Ghost", ["A.md"]]]);
  });

  it("updates incrementally and notifies", async () => {
    const index = await build({ "A.md": "[[B]]" });
    let calls = 0;
    index.subscribe(() => calls++);
    expect(index.backlinksTo("B.md")).toEqual([]);
    index.setNote("B.md", "hi");
    expect(index.backlinksTo("B.md").map((b) => b.source)).toEqual(["A.md"]);
    index.setNote("A.md", "no links");
    expect(index.backlinksTo("B.md")).toEqual([]);
    index.removeNote("B.md");
    expect(index.has("B.md")).toBe(false);
    expect(calls).toBe(3);
  });

  it("refresh only picks up changed notes", async () => {
    const vault = new MemoryAdapter("t", { "A.md": "[[B]]", "B.md": "" });
    const index = new NoteIndex();
    await index.load(vault);
    await vault.writeText("C.md", "[[A]] #new");
    await vault.remove("B.md");
    await index.refresh(vault);
    expect(index.notePaths()).toEqual(["A.md", "C.md"]);
    expect(index.backlinksTo("A.md").map((b) => b.source)).toEqual(["C.md"]);
    expect(index.tagsOf("C.md")).toEqual(["new"]);
  });

  it("aggregates nested tags and exposes the graph", async () => {
    const index = await build({ "A.md": "#proj/x [[B]] [[B]]", "B.md": "#proj/y [[A]]", "C.md": "[[Nope]]" });
    expect([...index.tags()]).toEqual([
      ["proj", ["A.md", "B.md"]],
      ["proj/x", ["A.md"]],
      ["proj/y", ["B.md"]],
    ]);
    const g = index.graph();
    expect(g.nodes.map((n) => n.name)).toEqual(["A", "B", "C"]);
    expect(g.edges).toEqual([
      { source: "A.md", target: "B.md" },
      { source: "B.md", target: "A.md" },
    ]);
  });

  it("searches by name and alias", async () => {
    const index = await build({ "Apple.md": "", "Banana.md": "---\naliases: [Yellow]\n---\n", "People/Alan.md": "" });
    expect(index.search("al").map((r) => r.name)).toEqual(["Alan", "Apple"]);
    expect(index.search("yel")).toEqual([{ path: "Banana.md", name: "Banana", alias: "Yellow" }]);
    expect(index.search("").length).toBe(3);
  });
});
