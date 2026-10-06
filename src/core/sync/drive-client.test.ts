import { describe, expect, it } from "vitest";
import { DriveClient, DriveError } from "./drive-client";
import { FAKE_TOKEN, FakeDrive } from "./testing/fake-drive";

function setup() {
  const drive = new FakeDrive();
  let tokenCalls = 0;
  let invalidated = 0;
  const client = new DriveClient({
    tokens: {
      getToken: async () => (++tokenCalls, invalidated > 0 ? FAKE_TOKEN : "stale"),
      invalidate: () => void invalidated++,
    },
    fetch: drive.fetch,
    sleep: async () => {},
  });
  const ok = new DriveClient({ tokens: { getToken: async () => FAKE_TOKEN }, fetch: drive.fetch, sleep: async () => {} });
  return { drive, client, ok, stats: () => ({ tokenCalls, invalidated }) };
}

describe("DriveClient", () => {
  it("lists a folder across pages and creates, reads, updates and trashes files", async () => {
    const { drive, ok } = setup();
    drive.pageSize = 2;
    const vault = drive.addFolder("root", "Vault");
    for (const n of ["a.md", "b.md", "c.md", "d.md", "e.md"]) drive.putFile(vault, n, n);
    expect((await ok.listChildren(vault)).map((f) => f.name).sort()).toEqual(["a.md", "b.md", "c.md", "d.md", "e.md"]);

    const created = await ok.createFile("새 노트.md", vault, new TextEncoder().encode("안녕"));
    expect(created.name).toBe("새 노트.md");
    expect(drive.text(vault, "새 노트.md")).toBe("안녕");
    expect(new TextDecoder().decode(await ok.download(created.id))).toBe("안녕");

    const updated = await ok.updateFile(created.id, new TextEncoder().encode("바뀜"));
    expect(updated.md5Checksum).toBeTruthy();
    expect(drive.text(vault, "새 노트.md")).toBe("바뀜");

    const folder = await ok.createFolder("하위", vault);
    expect(drive.find(vault, "하위")?.id).toBe(folder.id);

    await ok.trash(created.id);
    expect(drive.find(vault, "새 노트.md")).toBeUndefined();
    expect((await ok.listChildren(vault, true)).map((f) => f.name)).toEqual(["하위"]);
  });

  it("uses the resumable protocol for large files", async () => {
    const { drive, ok } = setup();
    const big = new Uint8Array(5 * 1024 * 1024 + 1).fill(7);
    const created = await ok.createFile("big.bin", "root", big);
    expect(drive.requests.some((r) => r.endsWith("?resumable"))).toBe(true);
    expect(drive.nodes.get(created.id)?.data?.length).toBe(big.length);
    expect(drive.nodes.get(created.id)?.name).toBe("big.bin");
    const updated = await ok.updateFile(created.id, big.slice(0, 6_000_000 > big.length ? big.length : 6_000_000));
    expect(updated.id).toBe(created.id);
  });

  it("reads changes in pages and returns the next token", async () => {
    const { drive, ok } = setup();
    drive.pageSize = 2;
    const start = await ok.startPageToken();
    const f = drive.addFolder("root", "F");
    drive.putFile(f, "x.md", "1");
    drive.putFile(f, "y.md", "2");
    const { changes, nextToken } = await ok.changesSince(start);
    expect(changes).toHaveLength(3);
    expect(changes[0]!.file?.name).toBe("F");
    expect((await ok.changesSince(nextToken)).changes).toHaveLength(0);
  });

  it("refreshes the token once on 401", async () => {
    const { drive, client, stats } = setup();
    drive.putFile("root", "n.md", "x");
    expect(await client.listChildren("root")).toHaveLength(1);
    expect(stats().invalidated).toBe(1);
  });

  it("retries rate limits and server errors, then gives up with a DriveError", async () => {
    const { drive, ok } = setup();
    drive.failNext(429, 2, "rateLimitExceeded");
    drive.failNext(503, 1);
    expect(await ok.listChildren("root")).toEqual([]);
    drive.failNext(500, 10);
    await expect(ok.listChildren("root")).rejects.toMatchObject({ name: "DriveError", status: 500 });
  });

  it("does not retry client errors", async () => {
    const { drive, ok } = setup();
    drive.failNext(404, 1, "notFound");
    const err = await ok.getFile("nope").catch((e) => e);
    expect(err).toBeInstanceOf(DriveError);
    expect(err.status).toBe(404);
    expect(drive.requests).toHaveLength(1);
  });
});
