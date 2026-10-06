import { useEffect, useState } from "react";
import type { DriveLink } from "@/app/vault-config";
import type { DriveSync } from "./useDriveSync";

export function timeAgo(then: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 45) return "방금";
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  if (s < 86400) return `${Math.round(s / 3600)}시간 전`;
  return `${Math.round(s / 86400)}일 전`;
}

/** The sync indicator in the status bar. Clicking it opens the sync dialog. */
export function SyncBadge({ link, sync, onClick }: { link: DriveLink | null; sync: DriveSync; onClick(): void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const { label, tone } = describe(link, sync);
  return (
    <button className={`sync-badge ${tone}`} onClick={onClick} title={link ? `Google 드라이브: ${link.folderName}` : "Google 드라이브와 동기화"}>
      {label}
    </button>
  );
}

function describe(link: DriveLink | null, sync: DriveSync): { label: string; tone: string } {
  if (!link) return { label: "☁ 동기화 꺼짐", tone: "off" };
  if (!sync.configured || !sync.signedIn) return { label: "☁ 로그인 필요", tone: "warn" };
  const s = sync.status;
  if (!s) return { label: "☁ 준비 중…", tone: "off" };
  switch (s.phase) {
    case "syncing":
      return { label: s.progress ? `☁ 동기화 중 ${s.progress.done}/${s.progress.total}` : "☁ 동기화 중…", tone: "busy" };
    case "offline":
      return { label: "☁ 오프라인", tone: "warn" };
    case "auth-needed":
      return { label: "☁ 다시 로그인 필요", tone: "warn" };
    case "error":
      return { label: "☁ 동기화 오류", tone: "error" };
    default:
      if (s.summary?.aborted) return { label: "☁ 확인 필요", tone: "error" };
      if (s.conflictFiles.length > 0) return { label: `☁ 충돌 ${s.conflictFiles.length}개`, tone: "warn" };
      if (s.issues.length > 0) return { label: `☁ 문제 ${s.issues.length}개`, tone: "warn" };
      return { label: s.lastSyncAt ? `☁ 동기화됨 · ${timeAgo(s.lastSyncAt)}` : "☁ 동기화 대기", tone: "ok" };
  }
}
