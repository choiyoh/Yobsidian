import { beforeEach, describe, expect, it } from "vitest";
import { MemoryAdapter } from "../vault";
import { DriveClient, DriveError } from "./drive-client";
import { AuthRequiredError, isSyncIgnored, SyncEngine, type SyncSummary } from "./engine";
import { MemorySyncStore } from "./state";
import { FAKE_TOKEN, FakeDrive } from "./testing/fake-drive";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Env {
  vault = new MemoryAdapter("v");
  drive = new FakeDrive();
  store = new MemorySyncStore();
  root = this.drive.addFolder("root", "Vault");
  engine: SyncEngine;

  constructor(fetchImpl?: typeof fetch) {
    const client = new DriveClient({ tokens: { getToken: async () => FAKE_TOKEN }, fetch: fetchImpl ?? ((i, n) => this.drive.fetch(i, n)), sleep: async () => {}, maxRetries: 0 });
    this.engine = new SyncEngine({ vault: this.vault, drive: client, store: this.store, rootId: this.root, now: () => new Date(2026, 9, 6, 15, 30).getTime() });
  }

  sync(opts: Parameters<SyncEngine["sync"]>[0] = {}): Promise<SyncSummary> {
    return this.engine.sync(opts);
  }
  /** Write a local file after a pause, so its mtime differs from the previous write. */
  async edit(path: string, text: string) {
    await sleep(3);
    await this.vault.writeText(path, text);
  }
  async files(): Promise<string[]> {
    return (await this.vault.list()).filter((e) => e.kind === "file").map((e) => e.path).sort();
  }
  listCalls() {
    return this.drive.requests.filter((r) => r === "GET /drive/v3/files").length;
  }
}

let env: Env;
beforeEach(() => {
  env = new Env();
});

describe("first sync", () => {
  it("downloads a remote vault into an empty local one, folders and Korean names included", async () => {
    env.drive.putFile(env.root, "Welcome.md", "# 안녕");
    env.drive.putFile(env.root, "일기/2026-10-06.md", "오늘");
    env.drive.addFolder(env.root, "빈 폴더");
    const s = await env.sync();
    expect(s).toMatchObject({ downloaded: 2, uploaded: 0, fullScan: true, issues: [] });
    expect(await env.vault.readText("일기/2026-10-06.md")).toBe("오늘");
    expect((await env.vault.stat("빈 폴더"))?.kind).toBe("folder");
  });

  it("uploads a local vault to an empty Drive folder, creating nested folders once", async () => {
    await env.vault.writeText("a.md", "A");
    await env.vault.writeText("프로젝트/기획/메모.md", "메모");
    await env.vault.writeText("프로젝트/기획/둘.md", "둘");
    await env.vault.mkdir("빈");
    const s = await env.sync();
    expect(s.uploaded).toBe(3);
    expect(env.drive.tree(env.root)).toEqual(["a.md", "빈/", "프로젝트/", "프로젝트/기획/", "프로젝트/기획/둘.md", "프로젝트/기획/메모.md"]);
    expect(env.drive.text(env.root, "프로젝트/기획/메모.md")).toBe("메모");
  });

  it("merges two populated sides without deleting or transferring identical files", async () => {
    await env.vault.writeText("same.md", "같은 내용");
    await env.vault.writeText("only-local.md", "L");
    env.drive.putFile(env.root, "same.md", "같은 내용");
    env.drive.putFile(env.root, "only-remote.md", "R");
    const before = env.drive.requests.length;
    const s = await env.sync();
    expect(s).toMatchObject({ uploaded: 1, downloaded: 1, conflicts: [], trashedLocal: 0, trashedRemote: 0 });
    expect(env.drive.requests.slice(before).filter((r) => r.endsWith("?media"))).toHaveLength(1); // only only-remote.md; the identical file is never downloaded
    expect(await env.files()).toEqual(["only-local.md", "only-remote.md", "same.md"]);
  });

  it("keeps both versions when the same note differs on both sides", async () => {
    await env.vault.writeText("Note.md", "local version");
    env.drive.putFile(env.root, "Note.md", "remote version");
    const s = await env.sync();
    expect(s.conflicts).toEqual([{ path: "Note.md", conflictPath: "Note (충돌 2026-10-06 1530).md" }]);
    expect(await env.vault.readText("Note.md")).toBe("local version");
    expect(await env.vault.readText("Note (충돌 2026-10-06 1530).md")).toBe("remote version");
    expect(env.drive.text(env.root, "Note.md")).toBe("local version");
    expect(env.drive.text(env.root, "Note (충돌 2026-10-06 1530).md")).toBe("remote version");
    expect((await env.sync()).conflicts).toEqual([]); // stable afterwards
  });
});

describe("steady state", () => {
  it("does nothing, cheaply, when nothing changed", async () => {
    await env.vault.writeText("a.md", "A");
    await env.sync();
    const lists = env.listCalls();
    const s = await env.sync();
    expect(s).toMatchObject({ uploaded: 0, downloaded: 0, fullScan: false, issues: [] });
    expect(env.listCalls()).toBe(lists); // only a changes check, no tree listing
  });

  it("does not re-list the tree for the echo of its own uploads", async () => {
    await env.vault.writeText("a.md", "A");
    await env.sync();
    await env.edit("a.md", "A2");
    await env.edit("b/new.md", "B");
    expect((await env.sync()).uploaded).toBe(2);
    const lists = env.listCalls();
    expect((await env.sync()).fullScan).toBe(false);
    expect(env.listCalls()).toBe(lists);
  });

  it("uploads a local edit and downloads a remote edit", async () => {
    await env.vault.writeText("a.md", "A");
    await env.vault.writeText("b.md", "B");
    await env.sync();
    await env.edit("a.md", "A local edit");
    env.drive.setContent(env.drive.find(env.root, "b.md")!.id, "B remote edit");
    const s = await env.sync();
    expect(s).toMatchObject({ uploaded: 1, downloaded: 1 });
    expect(env.drive.text(env.root, "a.md")).toBe("A local edit");
    expect(await env.vault.readText("b.md")).toBe("B remote edit");
    expect(s.fullScan).toBe(true); // the remote edit was relevant
  });

  it("picks up a note created remotely in a subfolder", async () => {
    await env.vault.writeText("x/a.md", "A");
    await env.sync();
    env.drive.putFile(env.root, "x/new.md", "N");
    env.drive.putFile(env.root, "y/deep/other.md", "O");
    await env.sync();
    expect(await env.files()).toEqual(["x/a.md", "x/new.md", "y/deep/other.md"]);
  });

  it("syncs binary attachments byte for byte", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 254, 1, 2, 3]);
    await env.vault.writeBinary("img/pic.png", png);
    await env.sync();
    expect([...env.drive.find(env.root, "img/pic.png")!.data!]).toEqual([...png]);
    env.drive.setContent(env.drive.find(env.root, "img/pic.png")!.id, Buffer.from([9, 8, 7]));
    await env.sync();
    expect([...(await env.vault.readBinary("img/pic.png"))]).toEqual([9, 8, 7]);
  });
});

describe("both sides edited", () => {
  const base = "# 제목\n\n첫째 줄\n둘째 줄\n셋째 줄\n\n끝\n";

  it("merges edits to different parts of a note automatically", async () => {
    await env.vault.writeText("n.md", base);
    await env.sync();
    await env.edit("n.md", base.replace("첫째 줄", "첫째 줄 (노트북)"));
    env.drive.setContent(env.drive.find(env.root, "n.md")!.id, base.replace("끝", "끝\n웹에서 추가\n"));
    const s = await env.sync();
    expect(s).toMatchObject({ merged: 1, conflicts: [] });
    expect(await env.vault.readText("n.md")).toBe(env.drive.text(env.root, "n.md"));
    expect(await env.vault.readText("n.md")).toContain("첫째 줄 (노트북)");
    expect(await env.vault.readText("n.md")).toContain("웹에서 추가");
    expect((await env.sync()).uploaded).toBe(0);
  });

  it("writes a conflict file when the same line changed on both sides", async () => {
    await env.vault.writeText("n.md", base);
    await env.sync();
    await env.edit("n.md", base.replace("둘째 줄", "로컬"));
    env.drive.setContent(env.drive.find(env.root, "n.md")!.id, base.replace("둘째 줄", "원격"));
    const s = await env.sync();
    expect(s.conflicts).toHaveLength(1);
    expect(await env.vault.readText("n.md")).toContain("로컬");
    expect(await env.vault.readText(s.conflicts[0]!.conflictPath)).toContain("원격");
    expect(env.drive.tree(env.root)).toEqual(["n (충돌 2026-10-06 1530).md", "n.md"]);
    expect(env.drive.text(env.root, "n.md")).toContain("로컬");
  });

  it("numbers the conflict file if one with that name already exists", async () => {
    await env.vault.writeText("n.md", base);
    await env.sync();
    await env.vault.writeText("n (충돌 2026-10-06 1530).md", "이미 있음");
    await env.edit("n.md", "L\n");
    env.drive.setContent(env.drive.find(env.root, "n.md")!.id, "R\n");
    const s = await env.sync();
    expect(s.conflicts[0]!.conflictPath).toBe("n (충돌 2026-10-06 1530 2).md");
    expect(await env.vault.readText("n (충돌 2026-10-06 1530).md")).toBe("이미 있음");
  });

  it("treats identical edits on both sides as no conflict", async () => {
    await env.vault.writeText("n.md", "a\n");
    await env.sync();
    await env.edit("n.md", "b\n");
    env.drive.setContent(env.drive.find(env.root, "n.md")!.id, "b\n");
    const s = await env.sync();
    expect(s).toMatchObject({ conflicts: [], merged: 0, uploaded: 0, downloaded: 0 });
  });

  it("never merges non-text files: keeps both", async () => {
    await env.vault.writeBinary("pic.png", new Uint8Array([1, 2, 3]));
    await env.sync();
    await sleep(3);
    await env.vault.writeBinary("pic.png", new Uint8Array([4, 5, 6]));
    env.drive.setContent(env.drive.find(env.root, "pic.png")!.id, Buffer.from([7, 8, 9]));
    const s = await env.sync();
    expect(s.conflicts).toEqual([{ path: "pic.png", conflictPath: "pic (충돌 2026-10-06 1530).png" }]);
    expect([...(await env.vault.readBinary("pic (충돌 2026-10-06 1530).png"))]).toEqual([7, 8, 9]);
  });

  it("leaves a note alone if the user typed in it while its download was in flight", async () => {
    await env.vault.writeText("n.md", "v1\n");
    await env.sync();
    env.drive.setContent(env.drive.find(env.root, "n.md")!.id, "remote v2\n");
    const original = env.drive.fetch;
    let typed = false;
    env.drive.fetch = async (input, init) => {
      if (!typed && String(input).includes("alt=media")) {
        typed = true;
        await sleep(3);
        await env.vault.writeText("n.md", "user typed this\n");
      }
      return original(input, init);
    };
    await env.sync();
    expect(await env.vault.readText("n.md")).toBe("user typed this\n");
    // The next run reconciles it: both sides changed -> merge or conflict, but nothing is lost.
    const s = await env.sync();
    const all = [await env.vault.readText("n.md"), ...(await Promise.all(s.conflicts.map((c) => env.vault.readText(c.conflictPath))))].join("|");
    expect(all).toContain("user typed this");
    expect(all).toContain("remote v2");
  });
});

describe("deletions", () => {
  it("moves a note deleted remotely to .trash and trashes one deleted locally", async () => {
    await env.vault.writeText("gone-remote.md", "1");
    await env.vault.writeText("gone-local.md", "2");
    await env.vault.writeText("keep.md", "3");
    await env.sync();
    env.drive.trashNode(env.drive.find(env.root, "gone-remote.md")!.id);
    await env.vault.remove("gone-local.md");
    const s = await env.sync();
    expect(s).toMatchObject({ trashedLocal: 1, trashedRemote: 1 });
    expect(await env.files()).toEqual([".trash/gone-remote.md", "keep.md"]);
    expect(env.drive.tree(env.root)).toEqual(["keep.md"]);
    expect(env.drive.nodes.get(env.drive.find(env.root, "keep.md")!.id)).toBeTruthy();
    expect((await env.sync()).trashedLocal).toBe(0);
  });

  it("restores a note that was deleted on one side but edited on the other", async () => {
    await env.vault.writeText("a.md", "old");
    await env.vault.writeText("b.md", "old");
    await env.sync();
    await env.vault.remove("a.md");
    env.drive.setContent(env.drive.find(env.root, "a.md")!.id, "edited remotely");
    env.drive.trashNode(env.drive.find(env.root, "b.md")!.id);
    await env.edit("b.md", "edited locally");
    await env.sync();
    expect(await env.vault.readText("a.md")).toBe("edited remotely");
    expect(env.drive.text(env.root, "b.md")).toBe("edited locally");
  });

  it("propagates the deletion of a whole folder both ways", async () => {
    await env.vault.writeText("dir/a.md", "1");
    await env.vault.writeText("dir/sub/b.md", "2");
    await env.vault.writeText("other/c.md", "3");
    await env.sync();

    await env.vault.remove("dir");
    await env.sync();
    expect(env.drive.tree(env.root)).toEqual(["other/", "other/c.md"]);

    env.drive.trashNode(env.drive.find(env.root, "other")!.id);
    await env.sync();
    expect((await env.vault.list()).map((e) => e.path).filter((p) => !p.startsWith(".trash")).sort()).toEqual([]);
    expect(await env.files()).toEqual([".trash/c.md"]);
  });

  it("stops before a destructive run unless told otherwise", async () => {
    for (let i = 0; i < 30; i++) await env.vault.writeText(`n${i}.md`, String(i));
    await env.sync();
    for (const n of env.drive.tree(env.root)) env.drive.trashNode(env.drive.find(env.root, n)!.id);
    const s = await env.sync();
    expect(s.aborted).toMatchObject({ reason: "mass-delete", local: 30 });
    expect(await env.files()).toHaveLength(30);
    expect((await env.sync({ allowMassDelete: true })).trashedLocal).toBe(30);
  });
});

describe("moves", () => {
  it("propagates a note moved into a folder, and a folder moved into another", async () => {
    await env.vault.writeText("a.md", "A");
    await env.vault.writeText("dir/b.md", "B");
    await env.vault.mkdir("target");
    await env.sync();

    await env.vault.rename("a.md", "target/a.md");
    await env.vault.rename("dir", "target/dir");
    await env.sync();
    expect(env.drive.tree(env.root)).toEqual(["target/", "target/a.md", "target/dir/", "target/dir/b.md"]);
    expect((await env.sync()).uploaded).toBe(0);
  });
});

describe("what does not sync", () => {
  it("skips .trash, Obsidian's window layout, VCS and OS files, but syncs the rest of .obsidian", async () => {
    for (const p of [".trash/x.md", ".obsidian/workspace.json", ".obsidian/workspace-mobile.json", ".git/HEAD", "Thumbs.db", "a/.DS_Store", "ok.md", ".obsidian/app.json", ".obsidian/plugins/p/data.json"]) {
      await env.vault.writeText(p, "x");
    }
    await env.sync();
    expect(env.drive.tree(env.root)).toEqual([".obsidian/", ".obsidian/app.json", ".obsidian/plugins/", ".obsidian/plugins/p/", ".obsidian/plugins/p/data.json", "a/", "ok.md"]);
    expect(isSyncIgnored("notes/.trash/x")).toBe(true);
    expect(isSyncIgnored("notes/x.md")).toBe(false);
  });

  it("ignores Google Docs and files whose names cannot be paths, and reports duplicates", async () => {
    env.drive.putFile(env.root, "real.md", "r");
    env.drive.putFile(env.root, "dup.md", "first");
    const dup = env.drive.putFile(env.root, "x", "tmp");
    env.drive.nodes.get(dup)!.name = "dup.md";
    const doc = env.drive.putFile(env.root, "Doc", "x");
    env.drive.nodes.get(doc)!.mimeType = "application/vnd.google-apps.document";
    const slash = env.drive.putFile(env.root, "y", "x");
    env.drive.nodes.get(slash)!.name = "a/b.md";
    const s = await env.sync();
    expect(await env.files()).toEqual(["dup.md", "real.md"]);
    expect(await env.vault.readText("dup.md")).toBe("first");
    expect(s.issues.map((i) => i.path).sort()).toEqual(["a/b.md", "dup.md"]);
  });
});

describe("failures", () => {
  it("stops with an error when signed out, and recovers on the next run", async () => {
    await env.vault.writeText("a.md", "A");
    env.drive.failNext(401, 3, "authError");
    await expect(env.sync()).rejects.toBeInstanceOf(DriveError);
    expect((await env.sync()).uploaded).toBe(1);
  });

  it("keeps going past one bad file and re-checks the remote tree next time", async () => {
    await env.vault.writeText("a.md", "A");
    await env.vault.writeText("b.md", "B");
    await env.sync();
    env.drive.setContent(env.drive.find(env.root, "a.md")!.id, "A2");
    env.drive.setContent(env.drive.find(env.root, "b.md")!.id, "B2");
    const original = env.drive.fetch;
    let failed = false;
    env.drive.fetch = async (input, init) => {
      if (!failed && String(input).includes("alt=media") && String(input).includes(env.drive.find(env.root, "a.md")!.id)) {
        failed = true;
        return new Response(JSON.stringify({ error: { message: "nope", errors: [{ reason: "notFound" }] } }), { status: 404 });
      }
      return original(input, init);
    };
    const s = await env.sync();
    expect(s.issues).toHaveLength(1);
    expect(await env.vault.readText("b.md")).toBe("B2");
    expect(await env.vault.readText("a.md")).toBe("A");
    await env.sync();
    expect(await env.vault.readText("a.md")).toBe("A2");
  });

  it("propagates AuthRequiredError from the token source", async () => {
    const client = new DriveClient({
      tokens: {
        getToken: async () => {
          throw new AuthRequiredError();
        },
      },
      fetch: env.drive.fetch,
    });
    const eng = new SyncEngine({ vault: env.vault, drive: client, store: env.store, rootId: env.root });
    await expect(eng.sync()).rejects.toBeInstanceOf(AuthRequiredError);
  });
});

describe("two devices", () => {
  it("converge through Drive", async () => {
    const laptop = env;
    const phone = new Env();
    phone.drive = laptop.drive;
    phone.root = laptop.root;
    const phoneClient = new DriveClient({ tokens: { getToken: async () => FAKE_TOKEN }, fetch: laptop.drive.fetch, sleep: async () => {} });
    phone.engine = new SyncEngine({ vault: phone.vault, drive: phoneClient, store: phone.store, rootId: laptop.root });

    await laptop.vault.writeText("Ideas.md", "- one\n");
    await laptop.sync();
    await phone.sync();
    expect(await phone.vault.readText("Ideas.md")).toBe("- one\n");

    await phone.edit("Ideas.md", "- one\n- two\n");
    await phone.edit("Phone only.md", "p");
    await laptop.edit("Laptop only.md", "l");
    await phone.sync();
    await laptop.sync();
    await phone.sync();
    expect(await laptop.files()).toEqual(["Ideas.md", "Laptop only.md", "Phone only.md"]);
    expect(await phone.files()).toEqual(await laptop.files());
    expect(await laptop.vault.readText("Ideas.md")).toBe("- one\n- two\n");

    await laptop.vault.remove("Phone only.md");
    await laptop.sync();
    await phone.sync();
    expect(await phone.files()).toEqual([".trash/Phone only.md", "Ideas.md", "Laptop only.md"]);
  });
});
