import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NoteIndex } from "@/core/index";
import { createNote, movePath, sanitizeFileName, trashPath, uniquePath } from "@/core/notes";
import { buildTree, dirname, extname, isMarkdown, isWithin, joinPath, stem, type TreeNode, type VaultAdapter } from "@/core/vault";
import { detectPlatform } from "@/core/platform";
import type { EditorMode, LinkTarget } from "@/features/editor/env";
import { NoteEditor, type NoteEditorHandle, type SaveState } from "@/features/editor/NoteEditor";
import { RightPanel } from "@/features/panels/RightPanel";
import { TagPane } from "@/features/panels/TagPane";
import { SyncBadge } from "@/features/sync/SyncBadge";
import { SyncDialog } from "@/features/sync/SyncDialog";
import { useDriveSync } from "@/features/sync/useDriveSync";
import { QuickSwitcher } from "@/features/switcher/QuickSwitcher";
import { FileTree } from "./FileTree";
import { pickFolder } from "./pick-folder";
import { useNavigation } from "./useNavigation";
import { loadVaultConfig, openLocalVault, setDriveLink, switchLocalVault, vaultIdOf, type DriveLink, type LocalVault } from "./vault-config";

// Opened once per page load (also across React StrictMode's double effects).
// A folder on disk (desktop) or the browser-storage vault, as chosen in the sync dialog; a reload applies a change.
let vaultPromise: Promise<VaultAdapter> | null = null;
function openConfiguredVault() {
  return (vaultPromise ??= openLocalVault(loadVaultConfig().local));
}

function switchVault(local: LocalVault) {
  switchLocalVault(local);
  window.location.reload();
}

export function App() {
  const [vault, setVault] = useState<VaultAdapter | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    openConfiguredVault().then(setVault, (e) => setError(String(e)));
  }, []);
  if (error)
    return (
      <div className="empty">
        <p>볼트를 열지 못했어요: {error}</p>
        <p>
          <button onClick={() => switchVault({ kind: "idb", name: "default" })}>기본 볼트로 열기</button>
        </p>
      </div>
    );
  if (!vault) return <p className="empty">불러오는 중…</p>;
  return <Workspace vault={vault} />;
}

function loadMode(): EditorMode {
  try {
    const m = localStorage.getItem("yobsidian.mode");
    if (m === "live" || m === "source" || m === "reading") return m;
  } catch {
    // storage unavailable: use the default
  }
  return "live";
}

const SAVE_LABEL: Record<SaveState, string> = { saved: "저장됨", dirty: "수정됨", saving: "저장 중…", error: "저장 실패" };

function Workspace({ vault }: { vault: VaultAdapter }) {
  const index = useMemo(() => new NoteIndex(), []);
  const platform = useMemo(() => detectPlatform(), []);
  const editor = useRef<NoteEditorHandle>(null);
  const nav = useNavigation(null);
  const active = nav.current?.path ?? null;

  const [ready, setReady] = useState(false);
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [mode, setModeState] = useState<EditorMode>(loadMode);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [leftTab, setLeftTab] = useState<"files" | "tags">("files");
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [showLeft, setShowLeft] = useState(true);
  const [showRight, setShowRight] = useState(() => window.innerWidth > 1000);
  const [switcher, setSwitcher] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; node: TreeNode } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef(0);
  const [syncDialog, setSyncDialog] = useState(false);
  const [vaultConfig, setVaultConfig] = useState(loadVaultConfig);
  const link: DriveLink | null = vaultConfig.links[vault.id] ?? null;
  const sync = useDriveSync(vault, link);

  const say = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3500);
  }, []);

  const setMode = (m: EditorMode) => {
    setModeState(m);
    try {
      localStorage.setItem("yobsidian.mode", m);
    } catch {
      // not persisted; fine
    }
  };

  // Tell the user when a sync had to keep both versions of a note.
  const conflictCount = sync.status?.conflicts.length ?? 0;
  const seenConflicts = useRef(0);
  useEffect(() => {
    if (conflictCount > seenConflicts.current) say("양쪽에서 다르게 수정된 노트가 있어서 두 버전을 모두 남겼어요. 동기화 창에서 확인하세요");
    seenConflicts.current = conflictCount;
  }, [conflictCount, say]);

  const linkDrive = (folder: DriveLink) => {
    const current = loadVaultConfig();
    if (current.local.kind === "idb" && current.local.name === "default") {
      // Keep the sample notes out of the user's Drive: sync into a fresh, empty vault instead.
      const fresh: LocalVault = { kind: "idb", name: `drive-${folder.folderId}` };
      setDriveLink(vaultIdOf(fresh), folder);
      switchVault(fresh);
      return;
    }
    setDriveLink(vault.id, folder);
    setVaultConfig(loadVaultConfig());
  };

  const unlinkDrive = async () => {
    await sync.forget();
    setDriveLink(vault.id, null);
    setVaultConfig(loadVaultConfig());
  };

  // Build the index, keep the explorer and index in step with the vault, then open a first note.
  useEffect(() => {
    let timer = 0;
    let disposed = false;
    const refresh = async () => {
      const entries = await vault.list();
      if (disposed) return;
      setTree(buildTree(entries));
      await index.refresh(vault, entries);
    };
    index.load(vault).then(async () => {
      if (disposed) return;
      await refresh();
      setReady(true);
    });
    const off = vault.watch?.(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(), 50);
    });
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      off?.();
    };
  }, [vault, index]);

  useEffect(() => {
    if (!ready || nav.current) return;
    const first = index.has("Welcome.md") ? "Welcome.md" : index.notePaths()[0];
    if (first) nav.go(first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // ----------------------------------------------------------------- actions

  const openNote = useCallback((path: string, reveal?: { heading?: string; block?: string }) => nav.go(path, reveal), [nav]);

  const createAndOpen = useCallback(
    async (name: string, from: string | null, folder?: string) => {
      await editor.current?.flush();
      const path = await createNote(vault, index, { name, fromPath: from ?? undefined, folder });
      nav.go(path);
      return path;
    },
    [vault, index, nav],
  );

  const openLink = useCallback(
    async (link: LinkTarget, from: string) => {
      let path = link.target === "" ? from : index.resolve(link.target, from);
      if (!path) {
        path = await createAndOpen(link.target, from);
        say(`“${stem(path)}” 노트를 만들었어요`);
        return;
      }
      if (!isMarkdown(path)) return say("노트가 아닌 파일은 아직 열 수 없어요");
      nav.go(path, { heading: link.heading, block: link.block });
    },
    [index, nav, createAndOpen, say],
  );

  const openTag = useCallback((tag: string) => {
    setSelectedTag(tag);
    setLeftTab("tags");
    setShowLeft(true);
  }, []);

  const newFolder = async (parent: string) => {
    const path = uniquePath((p) => tree !== null && flat(tree).has(p), parent, "새 폴더", "");
    await vault.mkdir(path);
    setRenaming(path);
  };

  const rename = async (path: string, name: string) => {
    setRenaming(null);
    try {
      const entry = await vault.stat(path);
      if (!entry) return;
      const clean = sanitizeFileName(name);
      if (!clean) return;
      const ext = extname(path);
      const base =
        entry.kind === "folder" ? clean : isMarkdown(path) ? clean.replace(/\.md$/i, "") + ".md" : /\.[^./]+$/.test(clean) || !ext ? clean : `${clean}.${ext}`;
      const dest = joinPath(dirname(path), base);
      if (dest === path) return;
      if (await vault.stat(dest)) return say("같은 이름이 이미 있어요");
      await editor.current?.flush();
      await movePath(vault, index, path, dest);
      nav.remap((p) => (isWithin(p, path) ? dest + p.slice(path.length) : p));
    } catch (e) {
      say(`이름을 바꾸지 못했어요: ${e instanceof Error ? e.message : e}`);
    }
  };

  const remove = async (path: string) => {
    try {
      await editor.current?.flush();
      await trashPath(vault, index, path);
      nav.remap((p) => (isWithin(p, path) ? null : p));
      say("삭제했어요 (.trash 폴더로 옮겨짐)");
    } catch (e) {
      say(`삭제하지 못했어요: ${e instanceof Error ? e.message : e}`);
    }
  };

  // --------------------------------------------------------------- shortcuts

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "o") (e.preventDefault(), setSwitcher(true));
      else if (mod && !e.altKey && e.key.toLowerCase() === "e") (e.preventDefault(), setMode(mode === "reading" ? "live" : "reading"));
      else if (e.altKey && !mod && e.key === "ArrowLeft") (e.preventDefault(), nav.back());
      else if (e.altKey && !mod && e.key === "ArrowRight") (e.preventDefault(), nav.forward());
      else if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, nav]);

  // ------------------------------------------------------------------ render

  const onContextMenu = (e: React.MouseEvent, node: TreeNode) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, node });
  };

  return (
    <div className={"app" + (showLeft ? "" : " no-left") + (showRight && active ? "" : " no-right")} onClick={() => setMenu(null)}>
      {showLeft && (
        <aside className="sidebar">
          <div className="sidebar-tabs">
            <button className={leftTab === "files" ? "active" : ""} onClick={() => setLeftTab("files")}>
              파일
            </button>
            <button className={leftTab === "tags" ? "active" : ""} onClick={() => setLeftTab("tags")}>
              태그
            </button>
          </div>
          {leftTab === "files" ? (
            <>
              <header className="vault-name">
                <span>{vault.name}</span>
                <span className="vault-actions">
                  <button title="새 노트" onClick={() => void createAndOpen("Untitled", active).then(setRenaming)}>
                    ＋
                  </button>
                  <button title="새 폴더" onClick={() => void newFolder("")}>
                    ▤
                  </button>
                </span>
              </header>
              {tree && (
                <FileTree
                  root={tree}
                  activePath={active}
                  renaming={renaming}
                  onOpen={openNote}
                  onContextMenu={onContextMenu}
                  onRename={(p, n) => void rename(p, n)}
                  onCancelRename={() => setRenaming(null)}
                />
              )}
            </>
          ) : (
            <TagPane index={index} selected={selectedTag} onSelect={setSelectedTag} onOpen={openNote} />
          )}
        </aside>
      )}

      <main className="workspace">
        <header className="toolbar">
          <button title="사이드바" onClick={() => setShowLeft(!showLeft)}>
            ☰
          </button>
          <button title="뒤로 (Alt+←)" disabled={!nav.canBack} onClick={nav.back}>
            ←
          </button>
          <button title="앞으로 (Alt+→)" disabled={!nav.canForward} onClick={nav.forward}>
            →
          </button>
          <button title="빠른 전환 (Ctrl/Cmd+O)" onClick={() => setSwitcher(true)}>
            🔍
          </button>
          <span className="spacer" />
          <div className="mode-switch" role="group" aria-label="보기 모드">
            {(
              [
                ["live", "편집"],
                ["source", "소스"],
                ["reading", "읽기"],
              ] as const
            ).map(([m, label]) => (
              <button key={m} className={mode === m ? "active" : ""} onClick={() => setMode(m)} aria-pressed={mode === m}>
                {label}
              </button>
            ))}
          </div>
          <button title="오른쪽 패널" className={showRight ? "active" : ""} onClick={() => setShowRight(!showRight)}>
            ⓘ
          </button>
        </header>

        {active ? (
          <>
            <TitleInput key={active} value={stem(active)} onCommit={(name) => void rename(active, name)} />
            <NoteEditor
              ref={editor}
              vault={vault}
              index={index}
              path={active}
              mode={mode}
              reveal={nav.current?.reveal}
              onOpenLink={(l, from) => void openLink(l, from)}
              onOpenTag={openTag}
              onSaveState={setSaveState}
            />
          </>
        ) : (
          <div className="empty">
            <p>열려 있는 노트가 없어요</p>
            <p>
              <button onClick={() => setSwitcher(true)}>노트 열기</button> <button onClick={() => void createAndOpen("Untitled", null)}>새 노트</button>
            </p>
          </div>
        )}
      </main>

      {showRight && active && (
        <RightPanel
          index={index}
          path={active}
          onOpen={openNote}
          onCreate={(target, from) => void openLink({ target }, from)}
          onTag={openTag}
        />
      )}

      <footer className="status-bar">
        <span>{platform === "desktop" ? "데스크톱" : "웹"}</span>
        <SyncBadge link={link} sync={sync} onClick={() => setSyncDialog(true)} />
        <span className="spacer" />
        <span>{active ?? ""}</span>
        {active && <span className={"save-state " + saveState}>{SAVE_LABEL[saveState]}</span>}
      </footer>

      {switcher && (
        <QuickSwitcher
          index={index}
          onClose={() => setSwitcher(false)}
          onOpen={(p) => (setSwitcher(false), openNote(p))}
          onCreate={(name) => (setSwitcher(false), void createAndOpen(name, active))}
        />
      )}

      {menu && (
        <ul className="context-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          {menu.node.kind === "folder" && (
            <>
              <li>
                <button onClick={() => (setMenu(null), void createAndOpen("Untitled", active, menu.node.path).then(setRenaming))}>새 노트</button>
              </li>
              <li>
                <button onClick={() => (setMenu(null), void newFolder(menu.node.path))}>새 폴더</button>
              </li>
            </>
          )}
          <li>
            <button onClick={() => (setMenu(null), setRenaming(menu.node.path))}>이름 바꾸기</button>
          </li>
          <li>
            <button className="danger" onClick={() => (setMenu(null), void remove(menu.node.path))}>
              삭제
            </button>
          </li>
        </ul>
      )}

      {syncDialog && (
        <SyncDialog
          platform={platform}
          vaultName={vault.name}
          local={vaultConfig.local}
          recentFolders={vaultConfig.recent}
          link={link}
          sync={sync}
          onClose={() => setSyncDialog(false)}
          onOpenFolder={() => void pickFolder().then((path) => path && switchVault({ kind: "fs", path }), (e) => say(`폴더를 열지 못했어요: ${e}`))}
          onSwitchLocal={switchVault}
          onLink={linkDrive}
          onUnlink={() => void unlinkDrive()}
          onOpenNote={(path) => (setSyncDialog(false), openNote(path))}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function flat(root: TreeNode): Set<string> {
  const out = new Set<string>();
  const walk = (n: TreeNode) => {
    out.add(n.path);
    n.children.forEach(walk);
  };
  walk(root);
  return out;
}

/** The note's name above the editor; editing it renames the file (and updates links to it). */
function TitleInput({ value, onCommit }: { value: string; onCommit: (name: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    if (text.trim() && text.trim() !== value) onCommit(text.trim());
    else setText(value);
  };
  return (
    <input
      className="note-title"
      value={text}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) (e.preventDefault(), e.currentTarget.blur());
        else if (e.key === "Escape") (setText(value), e.currentTarget.blur());
      }}
    />
  );
}
