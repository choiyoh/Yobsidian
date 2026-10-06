import { describe, expect, it } from "vitest";
import { attachmentFolder, saveAttachment } from "./attachments";
import { NoteIndex } from "./index/note-index";
import { MemoryAdapter } from "./vault/memory-adapter";

const bytes = new Uint8Array([1, 2, 3]);
const now = new Date(2026, 9, 6, 9, 5, 7);

describe("attachmentFolder", () => {
  it("follows Obsidian's folder setting forms", () => {
    expect(attachmentFolder("", "a/b.md")).toBe("");
    expect(attachmentFolder("/", "a/b.md")).toBe("");
    expect(attachmentFolder("./", "a/b.md")).toBe("a");
    expect(attachmentFolder("./files", "a/b.md")).toBe("a/files");
    expect(attachmentFolder("assets/", "a/b.md")).toBe("assets");
  });
});

describe("saveAttachment", () => {
  async function setup(files: Record<string, string> = {}) {
    const vault = new MemoryAdapter("v", files);
    const index = new NoteIndex();
    await index.load(vault);
    return { vault, index };
  }

  it("names a pasted image like Obsidian and puts it in the vault root by default", async () => {
    const { vault, index } = await setup();
    const path = await saveAttachment(vault, index, { bytes, mime: "image/png", fromPath: "n.md", now });
    expect(path).toBe("Pasted image 20261006090507.png");
    expect(await vault.readBinary(path)).toEqual(bytes);
    expect(index.has(path)).toBe(true);
    expect(index.resolve("Pasted image 20261006090507.png", "n.md")).toBe(path);
  });

  it("uses the vault's attachment folder and keeps dropped file names, adding a number on a clash", async () => {
    const { vault, index } = await setup({ ".obsidian/app.json": JSON.stringify({ attachmentFolderPath: "assets" }) });
    const a = await saveAttachment(vault, index, { bytes, name: "photo.JPG", fromPath: "n.md" });
    const b = await saveAttachment(vault, index, { bytes, name: "photo.JPG", fromPath: "n.md" });
    expect([a, b]).toEqual(["assets/photo.JPG", "assets/photo 1.JPG"]);
  });

  it("lets the app setting override the vault config", async () => {
    const { vault, index } = await setup({ ".obsidian/app.json": JSON.stringify({ attachmentFolderPath: "assets" }) });
    const p = await saveAttachment(vault, index, { bytes, name: "a.png", fromPath: "x/n.md", folderSetting: "./img" });
    expect(p).toBe("x/img/a.png");
  });
});
