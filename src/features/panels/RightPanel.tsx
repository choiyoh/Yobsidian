import { useEffect, useMemo, useState } from "react";
import type { NoteIndex } from "@/core/index";
import { stem } from "@/core/vault";
import { useIndexVersion } from "@/app/useIndexVersion";
import { LocalGraph } from "@/features/graph/GraphView";
import { PropertiesPane } from "./PropertiesPane";

export type RightTab = "note" | "links" | "graph";

interface Props {
  index: NoteIndex;
  /** The open note; null when none is open (only the graph is useful then). */
  path: string | null;
  onOpen(path: string, reveal?: { heading?: string }): void;
  onCreate(target: string, from: string): void;
  onTag(tag: string): void;
  onEditNote(edit: (text: string) => string): void;
  /** Bumped by the "add property" command to open the new-property row. */
  addPropertyNonce: number;
  /** Show only the graph, filling the panel. */
  graphOnly: boolean;
  onGraphOnly(on: boolean): void;
  onClose(): void;
  /** Drag handle on the panel's left edge, supplied by the app so it owns the width. */
  resizeHandle: React.ReactNode;
}

const TAB_KEY = "yobsidian.rightTab";
const TABS: [RightTab, string][] = [
  ["note", "노트"],
  ["links", "링크"],
  ["graph", "그래프"],
];

function loadTab(): RightTab {
  try {
    const t = localStorage.getItem(TAB_KEY);
    if (t === "note" || t === "links" || t === "graph") return t;
  } catch {
    // storage unavailable: use the default
  }
  return "note";
}

/** Right panel: note info (properties, tags, outline), links (backlinks, outgoing) and the local graph, on tabs; or the graph alone. */
export function RightPanel({ index, path, onOpen, onCreate, onTag, onEditNote, addPropertyNonce, graphOnly, onGraphOnly, onClose, resizeHandle }: Props) {
  const version = useIndexVersion(index);
  const [tab, setTabState] = useState<RightTab>(loadTab);
  const setTab = (t: RightTab) => {
    setTabState(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      // not persisted; fine
    }
  };
  // "add property" lives on the note tab.
  useEffect(() => {
    if (addPropertyNonce > 0) setTabState("note");
  }, [addPropertyNonce]);

  const data = useMemo(() => {
    const backlinks = new Map<string, string[]>();
    const outgoing = new Map<string, { target: string; resolved: string | null }>();
    if (!path) return { backlinks, outgoing: [], tags: [] as string[], headings: [] as ReturnType<NoteIndex["headingsOf"]> };
    for (const b of index.backlinksTo(path)) (backlinks.get(b.source) ?? backlinks.set(b.source, []).get(b.source)!).push(b.context);
    for (const l of index.linksFrom(path)) {
      if (!l.target && l.resolved === path) continue; // [[#Heading]] inside the note
      const key = l.resolved ?? "?" + l.target;
      if (!outgoing.has(key)) outgoing.set(key, { target: l.target, resolved: l.resolved });
    }
    return { backlinks, outgoing: [...outgoing.values()], tags: index.tagsOf(path), headings: index.headingsOf(path) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, path, version]);

  const minLevel = Math.min(6, ...data.headings.map((h) => h.level));
  const backlinkCount = [...data.backlinks.values()].reduce((n, l) => n + l.length, 0);
  const linkCount = backlinkCount + data.outgoing.length;
  const current = !path ? "graph" : tab;

  return (
    <aside className={"panel right-panel" + (graphOnly ? " graph-only" : "")}>
      {resizeHandle}
      <header className="panel-header">
        {graphOnly ? (
          <span className="panel-title">그래프</span>
        ) : (
          <div className="panel-tabs" role="tablist">
            {TABS.map(([id, label]) => (
              <button key={id} role="tab" aria-selected={current === id} className={current === id ? "active" : ""} disabled={!path && id !== "graph"} onClick={() => setTab(id)}>
                {label}
                {id === "links" && path && linkCount > 0 && <span className="count">{linkCount}</span>}
              </button>
            ))}
          </div>
        )}
        <span className="spacer" />
        <button className={"icon-button" + (graphOnly ? " active" : "")} title={graphOnly ? "탭으로 돌아가기" : "그래프만 보기"} aria-pressed={graphOnly} onClick={() => onGraphOnly(!graphOnly)}>
          ◎
        </button>
        <button className="icon-button" title="패널 닫기" onClick={onClose}>
          ✕
        </button>
      </header>

      <div className="panel-body">
        {(graphOnly || current === "graph") && <LocalGraph index={index} path={path} onOpen={(p) => onOpen(p)} fill />}

        {!graphOnly && path && current === "note" && (
          <>
            <PropertiesPane index={index} path={path} onEdit={onEditNote} addNonce={addPropertyNonce} />
            <Section title="태그" count={data.tags.length}>
              {data.tags.length === 0 && <p className="muted">태그가 없어요</p>}
              <div className="chips">
                {data.tags.map((t) => (
                  <button key={t} className="chip" onClick={() => onTag(t)}>
                    #{t}
                  </button>
                ))}
              </div>
            </Section>
            <Section title="개요" count={data.headings.length}>
              {data.headings.length === 0 && <p className="muted">제목이 없어요</p>}
              <ul className="plain-list">
                {data.headings.map((h, i) => (
                  <li key={i} style={{ paddingLeft: (h.level - minLevel) * 12 }}>
                    <button className="link-button muted-link" onClick={() => onOpen(path, { heading: h.text })}>
                      {h.text}
                    </button>
                  </li>
                ))}
              </ul>
            </Section>
          </>
        )}

        {!graphOnly && path && current === "links" && (
          <>
            <Section title="백링크" count={backlinkCount}>
              {data.backlinks.size === 0 && <p className="muted">이 노트를 가리키는 링크가 없어요</p>}
              {[...data.backlinks].map(([source, contexts]) => (
                <div key={source} className="backlink">
                  <button className="link-button" onClick={() => onOpen(source)} title={source}>
                    {stem(source)}
                  </button>
                  {contexts.map((c, i) => (
                    <p key={i} className="backlink-context">
                      {c}
                    </p>
                  ))}
                </div>
              ))}
            </Section>
            <Section title="나가는 링크" count={data.outgoing.length}>
              {data.outgoing.length === 0 && <p className="muted">이 노트의 링크가 없어요</p>}
              <ul className="plain-list">
                {data.outgoing.map((o) => (
                  <li key={o.resolved ?? "?" + o.target}>
                    {o.resolved ? (
                      <button className="link-button" onClick={() => onOpen(o.resolved!)} title={o.resolved}>
                        {stem(o.resolved)}
                      </button>
                    ) : (
                      <button className="link-button unresolved" onClick={() => onCreate(o.target, path)} title="눌러서 새 노트 만들기">
                        {o.target}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          </>
        )}
      </div>
    </aside>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <details className="section" open>
      <summary>
        {title} <span className="count">{count}</span>
      </summary>
      {children}
    </details>
  );
}
