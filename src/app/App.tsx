import { useEffect, useMemo, useState } from "react";
import { buildTree, stem, type TreeNode, type VaultAdapter } from "@/core/vault";
import { createSampleVault } from "@/core/vault/sample-vault";
import { detectPlatform } from "@/core/platform";
import { FileTree } from "./FileTree";

export function App() {
  // Real backends (local folder, Google Drive) replace this in later stages.
  const vault: VaultAdapter = useMemo(() => createSampleVault(), []);
  const platform = useMemo(() => detectPlatform(), []);
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [activePath, setActivePath] = useState<string | null>("Welcome.md");
  const [content, setContent] = useState("");

  useEffect(() => {
    const refresh = () => vault.list().then((entries) => setTree(buildTree(entries)));
    refresh();
    return vault.watch?.(refresh);
  }, [vault]);

  useEffect(() => {
    if (!activePath) return;
    let cancelled = false;
    vault.readText(activePath).then((text) => !cancelled && setContent(text));
    return () => {
      cancelled = true;
    };
  }, [vault, activePath]);

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="vault-name">{vault.name}</header>
        {tree && <FileTree root={tree} activePath={activePath} onOpen={setActivePath} />}
      </aside>
      <main className="workspace">
        {activePath ? (
          <>
            <header className="tab-title">{stem(activePath)}</header>
            {/* Placeholder: the CodeMirror 6 editor replaces this view. */}
            <pre className="note-source">{content}</pre>
          </>
        ) : (
          <p className="empty">노트를 선택하세요</p>
        )}
      </main>
      <footer className="status-bar">
        <span>{platform === "desktop" ? "데스크톱" : "웹"}</span>
        <span>{activePath ?? ""}</span>
      </footer>
    </div>
  );
}
