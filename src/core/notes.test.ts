import { describe, expect, it } from "vitest";
import { NoteIndex } from "./index";
import { createNote, movePath, readVaultConfig, sanitizeFileName, trashPath, uniquePath } from "./notes";
import { MemoryAdapter } from "./vault";

async function setup(files: Record<string, string>) {
  const vault = new MemoryAdapter("t", files);
  const index = new NoteIndex();
  await index.load(vault);
  return { vault, index };
}

describe("createNote", () => {
  it("creates in the root by default and never overwrites", async () => {
    const { vault, index } = await setup({ "Note.md": "old" });
    expect(await createNote(vault, index, { name: "Note" })).toBe("Note 1.md");
    expect(await vault.readText("Note.md")).toBe("old");
    expect(index.resolve("Note 1", "x.md")).toBe("Note 1.md");
  });

  it("honours a path in the link and .obsidian/app.json settings", async () => {
    const { vault, index } = await setup({ ".obsidian/app.json": '{"newFileLocation":"current"}', "a/b.md": "" });
    expect(await createNote(vault, index, { name: "x/y/Deep" })).toBe("x/y/Deep.md");
    expect(await createNote(vault, index, { name: "Sibling", fromPath: "a/b.md" })).toBe("a/Sibling.md");
    expect(await readVaultConfig(vault)).toMatchObject({ newFileLocation: "current" });
  });

  it("sanitizes names", () => {
    expect(sanitizeFileName('a:b/c?"d')).toBe("a-b-c--d");
    expect(uniquePath(() => false, "", "n")).toBe("n.md");
  });
});

describe("movePath", () => {
  it("renames a note and rewrites links, keeping aliases, headings and embeds", async () => {
    const { vault, index } = await setup({
      "Old.md": "self [[Old]]",
      "A.md": "[[Old]] [[Old|alias]] [[old#Head]] ![[Old]] [[Other]]",
      "Other.md": "",
    });
    await movePath(vault, index, "Old.md", "New.md");
    expect(await vault.readText("A.md")).toBe("[[New]] [[New|alias]] [[New#Head]] ![[New]] [[Other]]");
    expect(await vault.readText("New.md")).toBe("self [[New]]");
    expect(new Set(index.backlinksTo("New.md").map((b) => b.source))).toEqual(new Set(["A.md"]));
  });

  it("leaves link-looking text in code alone", async () => {
    const { vault, index } = await setup({ "Old.md": "", "A.md": "[[Old]] `[[Old]]`\n```\n[[Old]]\n```" });
    await movePath(vault, index, "Old.md", "New.md");
    expect(await vault.readText("A.md")).toBe("[[New]] `[[Old]]`\n```\n[[Old]]\n```");
  });

  it("uses a path when the new name is ambiguous, and handles attachments", async () => {
    const { vault, index } = await setup({
      "Dup.md": "",
      "Src.md": "[[Mine]] ![[pic.png]]",
      "Mine.md": "",
      "pic.png": "x",
    });
    await movePath(vault, index, "Mine.md", "sub/Dup.md");
    await movePath(vault, index, "pic.png", "img/pic2.png");
    expect(await vault.readText("Src.md")).toBe("[[sub/Dup]] ![[pic2.png]]");
  });

  it("moves folders and fixes path-style links", async () => {
    const { vault, index } = await setup({ "f/A.md": "[[f/B]]", "f/B.md": "", "Out.md": "[[A]] [[f/B]]" });
    await movePath(vault, index, "f", "g");
    expect(await vault.readText("Out.md")).toBe("[[A]] [[B]]");
    expect(await vault.readText("g/A.md")).toBe("[[B]]");
    expect(index.has("f/A.md")).toBe(false);
    expect(index.has("g/A.md")).toBe(true);
  });

  it("moves a note into a folder and out to the root, fixing path-style links", async () => {
    const { vault, index } = await setup({ "A.md": "[[B]]", "B.md": "[[A]]", "dir/C.md": "[[dir/D]]", "dir/D.md": "" });
    await movePath(vault, index, "B.md", "dir/B.md");
    expect(await vault.readText("A.md")).toBe("[[B]]");
    expect(await vault.readText("dir/B.md")).toBe("[[A]]");
    await movePath(vault, index, "dir/D.md", "D.md");
    expect(await vault.readText("dir/C.md")).toBe("[[D]]");
    expect(index.has("D.md")).toBe(true);
  });

  it("fails without touching anything if the destination exists", async () => {
    const { vault, index } = await setup({ "A.md": "", "B.md": "[[A]]" });
    await expect(movePath(vault, index, "A.md", "B.md")).rejects.toThrow();
    expect(await vault.readText("B.md")).toBe("[[A]]");
  });
});

describe("trashPath", () => {
  it("moves into .trash and drops the note from the index", async () => {
    const { vault, index } = await setup({ "A.md": "", "x/A.md": "" });
    await trashPath(vault, index, "A.md");
    await trashPath(vault, index, "x/A.md");
    expect((await vault.list()).map((e) => e.path).filter((p) => p.startsWith(".trash/")).sort()).toEqual([".trash/A 1.md", ".trash/A.md"]);
    expect(index.notePaths()).toEqual([]);
  });
});
