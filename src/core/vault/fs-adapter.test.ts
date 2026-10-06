import { describe, expect, it, vi } from "vitest";
import { FsAdapter, type FsBackend } from "./fs-adapter";
import { MemoryAdapter } from "./memory-adapter";
import { VaultError, type VaultChange } from "./types";

/** An FsBackend over a MemoryAdapter, so FsAdapter's own logic (events, polling, errors) is testable without Tauri. */
function backendOver(mem: MemoryAdapter): FsBackend {
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof VaultError) throw `${e.code}: ${e.path} (raw)`; // what Rust returns
      throw e;
    }
  };
  return {
    list: () => mem.list(),
    stat: (_r, p) => mem.stat(p),
    read: (_r, p) => wrap(() => mem.readBinary(p)),
    write: (_r, p, d) => mem.writeBinary(p, d),
    mkdir: (_r, p) => mem.mkdir(p),
    rename: (_r, a, b) => wrap(() => mem.rename(a, b)),
    remove: (_r, p) => wrap(() => mem.remove(p)),
  };
}

describe("FsAdapter", () => {
  it("names the vault after its folder, on either path style", () => {
    const b = backendOver(new MemoryAdapter("m"));
    expect(new FsAdapter("/Users/me/Notes", b).name).toBe("Notes");
    expect(new FsAdapter("C:\\Users\\me\\내 볼트\\", b).name).toBe("내 볼트");
    expect(new FsAdapter("/Users/me/Notes", b).id).toBe("fs:/Users/me/Notes");
  });

  it("maps native error strings back to VaultError codes", async () => {
    const fs = new FsAdapter("/v", backendOver(new MemoryAdapter("m", { "a.md": "x" })));
    await expect(fs.readText("missing.md")).rejects.toMatchObject({ name: "VaultError", code: "not-found", path: "missing.md" });
    await expect(fs.rename("a.md", "a.md")).rejects.toMatchObject({ code: "exists" });
  });

  it("writes, reads and announces its own changes right away", async () => {
    const fs = new FsAdapter("/v", backendOver(new MemoryAdapter("m")));
    const seen: VaultChange[] = [];
    const off = fs.watch((c) => seen.push(c));
    await fs.poll();
    await fs.writeText("n.md", "안녕");
    await fs.writeText("n.md", "안녕2");
    await fs.rename("n.md", "m.md");
    await fs.remove("m.md");
    off();
    expect(seen.map((c) => c.type)).toEqual(["create", "modify", "rename", "delete"]);
    expect(await fs.stat("m.md")).toBeNull();
  });

  it("notices changes made by other programs on the next poll, without echoing its own", async () => {
    const mem = new MemoryAdapter("m", { "a.md": "1", "b.md": "1" });
    const fs = new FsAdapter("/v", backendOver(mem));
    const seen: VaultChange[] = [];
    vi.useFakeTimers();
    const off = fs.watch((c) => seen.push(c));
    await fs.poll(); // baseline
    await fs.writeText("own.md", "x");
    seen.length = 0;
    await fs.poll();
    expect(seen).toEqual([]); // our own write is not reported twice

    vi.setSystemTime(Date.now() + 10);
    await mem.writeText("a.md", "changed outside");
    await mem.writeText("c.md", "new outside");
    await mem.remove("b.md");
    await fs.poll();
    off();
    vi.useRealTimers();
    expect(seen).toEqual(
      expect.arrayContaining([
        { type: "modify", path: "a.md" },
        { type: "create", path: "c.md" },
        { type: "delete", path: "b.md" },
      ]),
    );
    expect(seen).toHaveLength(3);
  });

  it("refuses paths that leave the vault before reaching the backend", async () => {
    const fs = new FsAdapter("/v", backendOver(new MemoryAdapter("m")));
    await expect(fs.readText("../secret")).rejects.toMatchObject({ code: "invalid-path" });
  });
});
