import { describe, expect, it } from "vitest";
import { MemoryAdapter } from "./memory-adapter";
import { buildTree } from "./tree";
import type { VaultChange } from "./types";

const paths = async (vault: MemoryAdapter) => (await vault.list()).map((e) => e.path).sort();

describe("MemoryAdapter", () => {
  it("creates parent folders on write and reads back", async () => {
    const vault = new MemoryAdapter("t");
    await vault.writeText("a/b/Note.md", "hello");
    expect(await vault.readText("a/b/Note.md")).toBe("hello");
    expect(await paths(vault)).toEqual(["a", "a/b", "a/b/Note.md"]);
    expect((await vault.stat("a"))?.kind).toBe("folder");
    expect(await vault.stat("missing.md")).toBeNull();
  });

  it("renames folders with their contents", async () => {
    const vault = new MemoryAdapter("t", { "a/x.md": "x", "a/sub/y.md": "y", "b.md": "b" });
    await vault.rename("a", "z/a2");
    expect(await paths(vault)).toEqual(["b.md", "z", "z/a2", "z/a2/sub", "z/a2/sub/y.md", "z/a2/x.md"]);
    await expect(vault.rename("b.md", "z/a2/x.md")).rejects.toThrow(/exists/);
    await expect(vault.rename("z", "z/inner")).rejects.toThrow(/invalid-path/);
  });

  it("removes folders recursively", async () => {
    const vault = new MemoryAdapter("t", { "a/x.md": "x", "ab.md": "y" });
    await vault.remove("a");
    expect(await paths(vault)).toEqual(["ab.md"]);
    await expect(vault.readText("a/x.md")).rejects.toThrow(/not-found/);
  });

  it("emits change events", async () => {
    const vault = new MemoryAdapter("t");
    const seen: VaultChange[] = [];
    const stop = vault.watch((c) => seen.push(c));
    await vault.writeText("n.md", "1");
    await vault.writeText("n.md", "2");
    await vault.rename("n.md", "m.md");
    await vault.remove("m.md");
    stop();
    await vault.writeText("ignored.md", "");
    expect(seen.map((c) => c.type)).toEqual(["create", "modify", "rename", "delete"]);
  });

  it("builds an explorer tree without hidden folders", async () => {
    const vault = new MemoryAdapter("t", {
      "b.md": "",
      "a.md": "",
      "Folder/c.md": "",
      ".obsidian/app.json": "{}",
    });
    const tree = buildTree(await vault.list());
    expect(tree.children.map((n) => n.name)).toEqual(["Folder", "a.md", "b.md"]);
    expect(tree.children[0].children.map((n) => n.path)).toEqual(["Folder/c.md"]);
  });
});
