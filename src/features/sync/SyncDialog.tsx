import { useState } from "react";
import { vaultIdOf, type DriveLink, type LocalVault } from "@/app/vault-config";
import type { Platform } from "@/core/platform";
import { supportsFolderPicker } from "@/core/vault";
import { loadGoogleSettings, saveGoogleSettings } from "@/core/sync/auth";
import { DriveFolderPicker } from "./DriveFolderPicker";
import { timeAgo } from "./SyncBadge";
import type { DriveSync } from "./useDriveSync";
import "./sync.css";

const GUIDE_URL = "https://github.com/choiyoh/yobsidian/blob/main/docs/GOOGLE_SETUP.md";

interface Props {
  platform: Platform;
  vaultName: string;
  local: LocalVault;
  recentFolders: string[];
  link: DriveLink | null;
  sync: DriveSync;
  onClose(): void;
  onOpenFolder(): void;
  onSwitchLocal(local: LocalVault): void;
  onLink(folder: DriveLink): void;
  onUnlink(): void;
  onOpenNote(path: string): void;
}

/** Vault location and Google Drive sync, in one place. */
export function SyncDialog(props: Props) {
  const { platform, vaultName, local, recentFolders, onClose } = props;
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="sync-dialog" role="dialog" aria-label="볼트와 동기화" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <header>
          <h2>볼트와 동기화</h2>
          <button className="close" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </header>

        <section>
          <h3>볼트</h3>
          <p>
            <strong>{vaultName}</strong>{" "}
            <span className="muted">{local.kind === "fs" ? local.path : platform === "desktop" ? "이 앱의 저장 공간" : "이 브라우저의 저장 공간"}</span>
          </p>
          <p className="muted">
            {platform === "desktop" || supportsFolderPicker()
              ? "옵시디언 볼트 폴더를 그대로 열 수 있어요. .obsidian 폴더는 읽기만 하고 바꾸지 않아요."
              : "이 브라우저는 폴더를 직접 열 수 없어서, 고른 폴더의 파일을 이 볼트로 가져와요. 폴더를 직접 열려면 Chrome이나 Edge, 또는 데스크톱 앱을 쓰세요."}
          </p>
          <div className="dialog-actions left">
            <button onClick={props.onOpenFolder}>{platform === "desktop" || supportsFolderPicker() ? "폴더 열기…" : "폴더 가져오기…"}</button>
            {local.kind === "fs" && <button onClick={() => props.onSwitchLocal({ kind: "idb", name: "default" })}>기본 볼트로</button>}
          </div>
          {platform === "desktop" && recentFolders.filter((p) => !(local.kind === "fs" && local.path === p)).length > 0 && (
            <ul className="recent">
              {recentFolders
                .filter((p) => !(local.kind === "fs" && local.path === p))
                .map((p) => (
                  <li key={p}>
                    <button className="link" onClick={() => props.onSwitchLocal({ kind: "fs", path: p })}>
                      {p}
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </section>

        <section>
          <h3>Google 드라이브</h3>
          <DriveSection {...props} vaultId={vaultIdOf(local)} />
        </section>
      </div>
    </div>
  );
}

function DriveSection({ platform, link, sync, onLink, onUnlink, onOpenNote, local, vaultName }: Props & { vaultId: string }) {
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingSettings, setEditingSettings] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!sync.configured || editingSettings) {
    return (
      <SettingsForm
        platform={platform}
        onSaved={() => {
          sync.reloadSettings();
          setEditingSettings(false);
        }}
        onCancel={sync.configured ? () => setEditingSettings(false) : undefined}
      />
    );
  }

  if (!sync.signedIn) {
    return (
      <>
        <p className="muted">구글 계정으로 로그인하면 노트를 드라이브 폴더와 동기화해요.{platform === "desktop" ? " 브라우저 창이 열려요." : ""}</p>
        <div className="dialog-actions left">
          <button className="primary" disabled={busy || !sync.auth} onClick={() => void run(sync.signIn)}>
            Google로 로그인
          </button>
          <button className="link" onClick={() => setEditingSettings(true)}>
            클라이언트 ID 설정
          </button>
        </div>
        {error && <p className="sync-error">{error}</p>}
      </>
    );
  }

  const account = <span className="muted">{sync.account ?? "로그인됨"}</span>;

  if (picking && sync.client) {
    return (
      <DriveFolderPicker
        client={sync.client}
        onCancel={() => setPicking(false)}
        onPick={(f) => {
          setPicking(false);
          onLink({ folderId: f.id, folderName: f.name });
        }}
      />
    );
  }

  if (!link) {
    return (
      <>
        <p>{account}</p>
        <p className="muted">
          볼트로 쓸 드라이브 폴더를 고르세요. 이미 노트가 들어 있는 폴더도, 새 폴더도 괜찮아요.
          {local.kind === "idb" && local.name === "default" && " 샘플 노트와는 섞이지 않게 새 볼트로 열어요."}
        </p>
        <div className="dialog-actions left">
          <button className="primary" onClick={() => setPicking(true)}>
            드라이브 폴더 고르기…
          </button>
          <button onClick={() => void run(sync.signOut)}>로그아웃</button>
        </div>
        {error && <p className="sync-error">{error}</p>}
      </>
    );
  }

  const s = sync.status;
  const unresolved = s?.conflictFiles ?? [];
  return (
    <>
      <p>
        <strong>📁 {link.folderName}</strong> · {account}
      </p>
      <p className="muted">
        {!s || s.phase === "syncing"
          ? s?.progress
            ? `동기화 중… ${s.progress.done}/${s.progress.total}`
            : "동기화 중…"
          : s.phase === "idle"
            ? s.lastSyncAt
              ? `${timeAgo(s.lastSyncAt)} 동기화됨${s.summary ? ` (올림 ${s.summary.uploaded}, 내려받음 ${s.summary.downloaded}, 병합 ${s.summary.merged}, 삭제 ${s.summary.trashedLocal + s.summary.trashedRemote})` : ""}`
              : "아직 동기화 전이에요"
            : (s.error ?? "동기화하지 못했어요")}
      </p>

      {s?.summary?.aborted && (
        <div className="sync-warning">
          <p>
            이번 동기화는 파일 {s.summary.aborted.local + s.summary.aborted.remote}개를 한꺼번에 지우게 돼서 멈췄어요. 지운 게 맞다면 계속 진행하세요. (삭제된 파일은 <code>.trash</code> 폴더와 드라이브 휴지통에 남아요)
          </p>
          <button onClick={() => void sync.controller?.syncNow({ allowMassDelete: true })}>그래도 동기화</button>
        </div>
      )}

      {unresolved.length > 0 && (
        <div className="sync-warning">
          <p>양쪽이 다르게 수정된 노트가 있어요. 두 버전을 비교해서 하나만 남기고 나머지는 지우세요.</p>
          <ul>
            {unresolved.map((p) => (
              <li key={p}>
                <button className="link" onClick={() => onOpenNote(p)}>
                  {p}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {s && s.issues.length > 0 && (
        <details className="sync-issues">
          <summary>문제가 있는 파일 {s.issues.length}개</summary>
          <ul>
            {s.issues.slice(0, 50).map((i, n) => (
              <li key={n}>
                <code>{i.path}</code> {i.message}
              </li>
            ))}
          </ul>
        </details>
      )}

      {s?.phase === "auth-needed" && (
        <div className="dialog-actions left">
          <button className="primary" onClick={() => void run(sync.signIn)}>
            다시 로그인
          </button>
        </div>
      )}

      <div className="dialog-actions left">
        <button className="primary" disabled={s?.phase === "syncing"} onClick={() => void sync.controller?.syncNow()}>
          지금 동기화
        </button>
        <button disabled={s?.phase === "syncing"} onClick={() => void sync.controller?.syncNow({ force: true })} title="드라이브 전체를 다시 훑어봐요">
          전체 다시 확인
        </button>
        <button
          onClick={() => {
            if (confirm(`“${vaultName}” 볼트와 드라이브 폴더 “${link.folderName}”의 연결을 끊을까요? 노트는 그대로 남아요.`)) void run(async () => onUnlink());
          }}
        >
          연결 끊기
        </button>
        <button className="link" onClick={() => setEditingSettings(true)}>
          클라이언트 ID
        </button>
        <button className="link" onClick={() => void run(sync.signOut)}>
          로그아웃
        </button>
      </div>
      {error && <p className="sync-error">{error}</p>}
    </>
  );
}

function SettingsForm({ platform, onSaved, onCancel }: { platform: Platform; onSaved(): void; onCancel?: () => void }) {
  const initial = loadGoogleSettings();
  const [clientId, setClientId] = useState(initial.clientId);
  const [clientSecret, setClientSecret] = useState(initial.clientSecret);
  return (
    <form
      className="settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        saveGoogleSettings({ clientId, clientSecret });
        onSaved();
      }}
    >
      <p className="muted">
        구글 드라이브를 쓰려면 본인의 Google Cloud 프로젝트에서 만든 OAuth 클라이언트 ID가 필요해요. 만드는 방법은{" "}
        <a href={GUIDE_URL} target="_blank" rel="noreferrer">
          설정 가이드
        </a>
        에 단계별로 적어 뒀어요.
      </p>
      <label>
        클라이언트 ID
        <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="1234-abcd.apps.googleusercontent.com" spellCheck={false} />
      </label>
      {platform === "desktop" && (
        <label>
          클라이언트 보안 비밀 (데스크톱 앱용)
          <input value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="GOCSPX-…" spellCheck={false} />
        </label>
      )}
      <div className="dialog-actions left">
        <button className="primary" type="submit" disabled={!clientId.trim()}>
          저장
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel}>
            취소
          </button>
        )}
      </div>
    </form>
  );
}
