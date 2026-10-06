import { useEffect, useState } from "react";
import type { DriveClient, DriveFile } from "@/core/sync/drive-client";

interface Props {
  client: DriveClient;
  onPick(folder: { id: string; name: string }): void;
  onCancel(): void;
}

const ROOT = { id: "root", name: "내 드라이브" };

/** Browse Google Drive folders (only folders) and choose the one that holds the vault. */
export function DriveFolderPicker({ client, onPick, onCancel }: Props) {
  const [trail, setTrail] = useState([ROOT]);
  const [folders, setFolders] = useState<DriveFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const here = trail[trail.length - 1]!;

  useEffect(() => {
    let live = true;
    setFolders(null);
    setError(null);
    client.listChildren(here.id, true).then(
      (list) => live && setFolders(list.sort((a, b) => a.name.localeCompare(b.name, "ko"))),
      (e) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => void (live = false);
  }, [client, here.id]);

  const create = async () => {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const folder = await client.createFolder(name, here.id);
      setNewName("");
      setTrail([...trail, { id: folder.id, name: folder.name }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="drive-picker">
      <nav className="drive-crumbs" aria-label="현재 위치">
        {trail.map((t, i) => (
          <span key={t.id}>
            {i > 0 && " / "}
            <button className="link" onClick={() => setTrail(trail.slice(0, i + 1))}>
              {t.name}
            </button>
          </span>
        ))}
      </nav>
      <ul className="drive-folders">
        {folders === null && !error && <li className="muted">불러오는 중…</li>}
        {folders?.length === 0 && <li className="muted">하위 폴더가 없어요</li>}
        {folders?.map((f) => (
          <li key={f.id}>
            <button onClick={() => setTrail([...trail, { id: f.id, name: f.name }])}>📁 {f.name}</button>
          </li>
        ))}
      </ul>
      {error && <p className="sync-error">{error}</p>}
      <div className="drive-new">
        <input value={newName} placeholder="새 폴더 이름" onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && void create()} />
        <button disabled={!newName.trim() || busy} onClick={() => void create()}>
          만들기
        </button>
      </div>
      <div className="dialog-actions">
        <button onClick={onCancel}>취소</button>
        <button className="primary" disabled={here.id === ROOT.id} title={here.id === ROOT.id ? "내 드라이브 전체는 볼트로 쓸 수 없어요. 폴더를 골라 주세요" : undefined} onClick={() => onPick(here)}>
          “{here.name}” 폴더를 볼트로 사용
        </button>
      </div>
    </div>
  );
}
