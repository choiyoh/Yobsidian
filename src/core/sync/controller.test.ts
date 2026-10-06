import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryAdapter } from "../vault";
import { SyncController, isConflictFile } from "./controller";
import { DriveError } from "./drive-client";
import { AuthRequiredError, type SyncSummary } from "./engine";

const summary = (over: Partial<SyncSummary> = {}): SyncSummary => ({
  startedAt: 1,
  finishedAt: 2,
  uploaded: 0,
  downloaded: 0,
  merged: 0,
  trashedRemote: 0,
  trashedLocal: 0,
  conflicts: [],
  issues: [],
  fullScan: false,
  ...over,
});

function setup(sync: (o: unknown) => Promise<SyncSummary>) {
  const vault = new MemoryAdapter("v");
  const runner = { sync: vi.fn(sync) };
  const handlers: Record<string, () => void> = {};
  const controller = new SyncController(vault, runner, {
    intervalMs: 60_000,
    debounceMs: 3000,
    listen: (type, h) => ((handlers[type] = h), () => delete handlers[type]),
  });
  return { vault, runner, controller, handlers };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("SyncController", () => {
  it("syncs on start, on a timer, and shortly after local edits (debounced)", async () => {
    const t = setup(async () => summary());
    t.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.runner.sync).toHaveBeenCalledTimes(1);

    await t.vault.writeText("a.md", "1");
    await t.vault.writeText("a.md", "2");
    await vi.advanceTimersByTimeAsync(2900);
    expect(t.runner.sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(t.runner.sync).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.runner.sync.mock.calls.length).toBeGreaterThanOrEqual(3);
    t.controller.stop();
  });

  it("never runs two syncs at once and runs once more for requests made meanwhile", async () => {
    let release!: () => void;
    let active = 0;
    let maxActive = 0;
    const t = setup(async () => {
      maxActive = Math.max(maxActive, ++active);
      await new Promise<void>((r) => (release = r));
      active--;
      return summary();
    });
    const first = t.controller.syncNow();
    void t.controller.syncNow();
    void t.controller.syncNow({ force: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.runner.sync).toHaveBeenCalledTimes(1);
    expect(t.controller.getStatus().phase).toBe("syncing");
    release();
    await first;
    t.controller.start(); // allow follow-up runs
    await vi.advanceTimersByTimeAsync(0);
    expect(maxActive).toBe(1);
    t.controller.stop();
  });

  it("reports results, conflicts and leftover conflict files", async () => {
    const t = setup(async () => summary({ finishedAt: 99, conflicts: [{ path: "a.md", conflictPath: "a (충돌 2026-10-06 1530).md" }], issues: [{ path: "x.md", message: "boom" }] }));
    await t.vault.writeText("a (충돌 2026-10-06 1530).md", "theirs");
    await t.vault.writeText("b.md", "ok");
    await t.controller.syncNow();
    expect(t.controller.getStatus()).toMatchObject({
      phase: "idle",
      lastSyncAt: 99,
      conflicts: [{ path: "a.md", conflictPath: "a (충돌 2026-10-06 1530).md" }],
      conflictFiles: ["a (충돌 2026-10-06 1530).md"],
      issues: [{ path: "x.md", message: "boom" }],
    });
  });

  it("tells the user when it stopped to avoid deleting too much", async () => {
    const t = setup(async () => summary({ aborted: { reason: "mass-delete", local: 30, remote: 0, tracked: 40 } }));
    await t.controller.syncNow();
    expect(t.controller.getStatus().error).toMatch(/30개/);
  });

  it("classifies failures: sign-in needed, offline (retried with backoff), other errors", async () => {
    let next: () => Promise<SyncSummary> = async () => {
      throw new AuthRequiredError();
    };
    const t = setup(() => next());
    t.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.controller.getStatus().phase).toBe("auth-needed");
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1); // no retry storm while signed out (the interval still ticks)
    const callsWhileSignedOut = t.runner.sync.mock.calls.length;
    expect(callsWhileSignedOut).toBeLessThanOrEqual(6);

    next = async () => {
      throw new TypeError("Failed to fetch");
    };
    await t.controller.syncNow();
    expect(t.controller.getStatus()).toMatchObject({ phase: "offline", error: "인터넷에 연결할 수 없어요" });

    next = async () => {
      throw new DriveError(500, "backendError", "oops");
    };
    await t.controller.syncNow();
    expect(t.controller.getStatus().phase).toBe("error");

    next = async () => summary({ finishedAt: 5 });
    t.handlers.online!();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.controller.getStatus()).toMatchObject({ phase: "idle", lastSyncAt: 5 });
    t.controller.stop();
  });

  it("recognizes conflict file names", () => {
    expect(isConflictFile("폴더/노트 (충돌 2026-10-06 1530).md")).toBe(true);
    expect(isConflictFile("노트 (충돌 2026-10-06 1530 2).md")).toBe(true);
    expect(isConflictFile("pic (충돌 2026-10-06 1530)")).toBe(true);
    expect(isConflictFile("노트 (충돌).md")).toBe(false);
  });
});
