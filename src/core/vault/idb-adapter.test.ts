import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { IdbAdapter } from "./idb-adapter";

let counter = 0;
const freshName = () => `test-${++counter}-${Math.random()}`;

describe("IdbAdapter", () => {
  it("seeds a new vault and restores it after reopening", async () => {
    const name = freshName();
    const a = await IdbAdapter.open(name, { "Hello.md": "hi", "dir/Sub.md": "sub" });
    await a.writeText("Later.md", "later");
    await a.writeBinary("img/pic.bin", new Uint8Array([1, 2, 3]));
    await a.mkdir("empty");
    await a.flush();
    a.close();

    const b = await IdbAdapter.open(name, { "Ignored.md": "seed only applies to new vaults" });
    expect((await b.list()).map((e) => e.path).sort()).toEqual(["Hello.md", "Later.md", "dir", "dir/Sub.md", "empty", "img", "img/pic.bin"]);
    expect(await b.readText("dir/Sub.md")).toBe("sub");
    expect([...(await b.readBinary("img/pic.bin"))]).toEqual([1, 2, 3]);
  });

  it("persists renames, overwrites and recursive deletes", async () => {
    const name = freshName();
    const a = await IdbAdapter.open(name, { "a/one.md": "1", "a/two.md": "2", "keep.md": "k" });
    await a.rename("a", "b");
    await a.writeText("keep.md", "changed");
    await a.remove("b/one.md");
    await a.flush();
    a.close();

    const b = await IdbAdapter.open(name);
    expect((await b.list()).map((e) => e.path).sort()).toEqual(["b", "b/two.md", "keep.md"]);
    expect(await b.readText("keep.md")).toBe("changed");
  });
});
