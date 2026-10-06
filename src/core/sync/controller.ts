import type { VaultAdapter } from "../vault";
import { DriveError } from "./drive-client";
import { AuthRequiredError, type SyncConflict, type SyncIssue, type SyncOptions, type SyncSummary } from "./engine";

export type SyncPhase = "idle" | "syncing" | "offline" | "auth-needed" | "error";

export interface SyncStatus {
  phase: SyncPhase;
  /** When the last run finished without a fatal error (ms since epoch). */
  lastSyncAt?: number;
  progress?: { done: number; total: number };
  /** Result of the last finished run. */
  summary?: SyncSummary;
  /** Problems with individual files in the last run. */
  issues: SyncIssue[];
  /** Conflicts created since the app started. */
  conflicts: SyncConflict[];
  /** Notes in the vault named like a conflict copy, i.e. still waiting for the user to look at them. */
  conflictFiles: string[];
  /** Why the last run failed (phase `error`, `offline` or `auth-needed`). */
  error?: string;
}

export interface SyncRunner {
  sync(options?: SyncOptions): Promise<SyncSummary>;
}

export interface SyncControllerOptions {
  /** How often to check for remote changes while the app is open. */
  intervalMs?: number;
  /** How long to wait after a local edit before syncing, so typing does not upload every keystroke. */
  debounceMs?: number;
  /** Subscribe to window-level events that should trigger a sync. Defaults to the browser's focus/online events. */
  listen?: (type: "focus" | "online", handler: () => void) => () => void;
}

const CONFLICT_NAME = / \(충돌 \d{4}-\d{2}-\d{2} \d{4}( \d+)?\)(\.[^./]+)?$/;

export function isConflictFile(path: string): boolean {
  return CONFLICT_NAME.test(path);
}

/**
 * Keeps one vault in sync in the background: runs the engine on a timer, shortly after local
 * edits, when the window regains focus or the network returns, never two at once, and with a
 * growing pause after failures. UI code just subscribes to {@link SyncStatus}.
 */
export class SyncController {
  private status: SyncStatus = { phase: "idle", issues: [], conflicts: [], conflictFiles: [] };
  private listeners = new Set<(s: SyncStatus) => void>();
  private running: Promise<void> | null = null;
  private pending: SyncOptions | null = null;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;
  private failures = 0;
  private stops: (() => void)[] = [];
  private started = false;

  constructor(
    private readonly vault: VaultAdapter,
    private readonly runner: SyncRunner,
    private readonly opts: SyncControllerOptions = {},
  ) {}

  getStatus = () => this.status;

  subscribe = (listener: (s: SyncStatus) => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  start() {
    if (this.started) return;
    this.started = true;
    const listen = this.opts.listen ?? defaultListen;
    this.stops.push(listen("focus", () => this.schedule(1000)), listen("online", () => void this.syncNow()));
    const off = this.vault.watch?.(() => {
      if (this.running) this.pending ??= {};
      else this.schedule(this.opts.debounceMs ?? 3000);
    });
    if (off) this.stops.push(off);
    this.interval = setInterval(() => void this.auto(), this.opts.intervalMs ?? 60_000);
    void this.syncNow();
  }

  stop() {
    this.started = false;
    this.stops.splice(0).forEach((off) => off());
    clearInterval(this.interval);
    clearTimeout(this.debounce);
    clearTimeout(this.retry);
  }

  /** Run a sync now, or right after the current one finishes. Resolves when the run that covers this request is done. */
  syncNow(options: SyncOptions = {}): Promise<void> {
    if (this.running) {
      this.pending = { ...this.pending, ...options, force: this.pending?.force || options.force, allowMassDelete: this.pending?.allowMassDelete || options.allowMassDelete };
      return this.running;
    }
    this.running = this.run(options).finally(() => {
      this.running = null;
      const next = this.pending;
      this.pending = null;
      if (next && this.started) void this.syncNow(next);
    });
    return this.running;
  }

  /** Timer-driven runs wait while signed out; only the user's sign-in (or "sync now") restarts them. */
  private auto(): Promise<void> {
    return this.status.phase === "auth-needed" ? Promise.resolve() : this.syncNow();
  }

  private schedule(ms: number) {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.auto(), ms);
  }

  private async run(options: SyncOptions) {
    clearTimeout(this.retry);
    this.update({ phase: "syncing", progress: undefined, error: undefined });
    try {
      const summary = await this.runner.sync({ ...options, onProgress: (done, total) => this.update({ progress: { done, total } }) });
      this.failures = 0;
      const conflictFiles = await this.findConflictFiles();
      this.update({
        phase: "idle",
        progress: undefined,
        lastSyncAt: summary.finishedAt,
        summary,
        issues: summary.issues,
        conflicts: [...this.status.conflicts, ...summary.conflicts],
        conflictFiles,
        error: summary.aborted ? `삭제할 파일이 너무 많아서(${summary.aborted.local + summary.aborted.remote}개) 멈췄어요. 확인 후 계속할 수 있어요` : undefined,
      });
    } catch (e) {
      this.failures++;
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof AuthRequiredError || (e instanceof DriveError && e.isAuth)) {
        this.update({ phase: "auth-needed", progress: undefined, error: message });
        return; // nothing to retry until the user signs in
      }
      const offline = e instanceof TypeError || (typeof navigator !== "undefined" && navigator.onLine === false);
      this.update({ phase: offline ? "offline" : "error", progress: undefined, error: offline ? "인터넷에 연결할 수 없어요" : message });
      if (this.started) this.retry = setTimeout(() => void this.syncNow(), Math.min(5 * 60_000, 15_000 * 2 ** Math.min(this.failures - 1, 5)));
    }
  }

  private async findConflictFiles(): Promise<string[]> {
    try {
      return (await this.vault.list()).filter((e) => e.kind === "file" && isConflictFile(e.path)).map((e) => e.path).sort();
    } catch {
      return this.status.conflictFiles;
    }
  }

  private update(patch: Partial<SyncStatus>) {
    this.status = { ...this.status, ...patch };
    for (const l of this.listeners) l(this.status);
  }
}

function defaultListen(type: "focus" | "online", handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(type, handler);
  return () => window.removeEventListener(type, handler);
}
