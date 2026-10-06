import { useEffect, useMemo, useRef, useState } from "react";
import type { NoteIndex } from "@/core/index";
import { useIndexVersion } from "@/app/useIndexVersion";
import { GraphCanvas } from "./GraphCanvas";
import { buildGraph, groupColor, groupOf, type ColorMode, type GraphFilter, type GraphModel } from "./model";

interface Settings {
  scope: "global" | "local";
  depth: number;
  query: string;
  colorMode: ColorMode;
  showOrphans: boolean;
}

const KEY = "yobsidian.graph";
const DEFAULTS: Settings = { scope: "global", depth: 2, query: "", colorMode: "folder", showOrphans: true };

function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Settings>;
    return {
      scope: raw.scope === "local" ? "local" : "global",
      depth: typeof raw.depth === "number" ? Math.min(5, Math.max(1, Math.round(raw.depth))) : DEFAULTS.depth,
      query: "",
      colorMode: raw.colorMode === "tag" || raw.colorMode === "none" || raw.colorMode === "folder" ? raw.colorMode : DEFAULTS.colorMode,
      showOrphans: raw.showOrphans ?? DEFAULTS.showOrphans,
    };
  } catch {
    return DEFAULTS;
  }
}

/** Rebuilds the model only when the notes, links or tags really changed, so typing in a note does not restart the layout. */
export function useGraphModel(index: NoteIndex, filter: GraphFilter): GraphModel {
  const version = useIndexVersion(index);
  const last = useRef<GraphModel | null>(null);
  return useMemo(() => {
    const next = buildGraph(index.graph(), filter);
    if (last.current && last.current.signature === next.signature) return last.current;
    return (last.current = next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, version, filter.scope, filter.center, filter.depth, filter.query, filter.showOrphans]);
}

interface Props {
  index: NoteIndex;
  activePath: string | null;
  /** `keepGraph` is true for Ctrl/Cmd+click, which opens the note without leaving the graph. */
  onOpen(path: string, keepGraph: boolean): void;
}

/** The full-size graph view: whole vault or the open note's neighbourhood, with search and colouring. */
export function GraphView({ index, activePath, onOpen }: Props) {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const set = (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch }));
  useEffect(() => {
    try {
      const { query: _q, ...rest } = settings;
      localStorage.setItem(KEY, JSON.stringify(rest));
    } catch {
      // not persisted; fine
    }
  }, [settings]);

  const scope = settings.scope === "local" && activePath ? "local" : "global";
  const filter = useMemo<GraphFilter>(
    () => ({ scope, center: activePath, depth: settings.depth, query: settings.query, showOrphans: settings.showOrphans }),
    [scope, activePath, settings.depth, settings.query, settings.showOrphans],
  );
  const model = useGraphModel(index, filter);
  const positions = useRef(new Map<string, { x: number; y: number }>());

  // Tidy view for each new scope, centre note or filter, but not for edits to the same graph.
  const fitKey = `${scope}|${scope === "local" ? activePath : ""}|${settings.depth}|${settings.query}|${settings.showOrphans}`;

  const legend = useMemo(() => {
    if (settings.colorMode === "none") return [];
    const counts = new Map<string, number>();
    for (const n of model.nodes) {
      const g = groupOf(n, settings.colorMode);
      if (g !== null) counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12);
  }, [model, settings.colorMode]);

  return (
    <div className="graph-view">
      <div className="graph-controls">
        <div className="mode-switch" role="group" aria-label="그래프 범위">
          <button className={scope === "global" ? "active" : ""} onClick={() => set({ scope: "global" })}>
            전체
          </button>
          <button className={scope === "local" ? "active" : ""} disabled={!activePath} onClick={() => set({ scope: "local" })} title="열려 있는 노트와 연결된 노트만">
            현재 노트
          </button>
        </div>
        {scope === "local" && (
          <label className="graph-field" title="현재 노트에서 몇 단계까지 보여줄지">
            깊이 {settings.depth}
            <input type="range" min={1} max={5} value={settings.depth} onChange={(e) => set({ depth: Number(e.target.value) })} />
          </label>
        )}
        <input
          className="graph-search"
          type="search"
          placeholder="이름 검색, #태그, path:폴더"
          value={settings.query}
          spellCheck={false}
          onChange={(e) => set({ query: e.target.value })}
        />
        <label className="graph-field">
          색상
          <select value={settings.colorMode} onChange={(e) => set({ colorMode: e.target.value as ColorMode })}>
            <option value="folder">폴더</option>
            <option value="tag">태그</option>
            <option value="none">없음</option>
          </select>
        </label>
        <label className="graph-field">
          <input type="checkbox" checked={settings.showOrphans} onChange={(e) => set({ showOrphans: e.target.checked })} />
          연결 없는 노트
        </label>
        <span className="spacer" />
        <span className="muted">
          노트 {model.nodes.length} · 링크 {model.edges.length}
        </span>
      </div>

      <div className="graph-stage">
        <GraphCanvas model={model} activePath={activePath} colorMode={settings.colorMode} fitKey={fitKey} positions={positions} onOpen={onOpen} />
        {model.nodes.length === 0 && <p className="graph-empty muted">표시할 노트가 없어요</p>}
        {legend.length > 0 && (
          <ul className="graph-legend">
            {legend.map(([name, count]) => (
              <li key={name}>
                <button onClick={() => set({ query: settings.colorMode === "tag" ? `#${name}` : `path:${name}/` })} title="이 그룹만 보기">
                  <span className="dot" style={{ background: groupColor(name) }} />
                  {settings.colorMode === "tag" ? "#" : ""}
                  {name} <span className="muted">{count}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="graph-hint muted">휠로 확대·축소, 드래그로 이동, 노드를 누르면 노트가 열려요 (Ctrl/⌘+클릭은 그래프 유지)</p>
      </div>
    </div>
  );
}

/** Small graph of the open note's direct neighbourhood for the right panel. */
export function LocalGraph({ index, path, onOpen }: { index: NoteIndex; path: string; onOpen(path: string): void }) {
  const [depth, setDepth] = useState(1);
  const filter = useMemo<GraphFilter>(() => ({ scope: "local", center: path, depth, query: "", showOrphans: true }), [path, depth]);
  const model = useGraphModel(index, filter);
  const positions = useRef(new Map<string, { x: number; y: number }>());
  return (
    <div className="local-graph">
      <div className="local-graph-stage">
        <GraphCanvas model={model} activePath={path} colorMode="none" fitKey={`${path}|${depth}`} positions={positions} alwaysLabels onOpen={(p) => onOpen(p)} />
        {model.nodes.length <= 1 && <p className="graph-empty muted">연결된 노트가 없어요</p>}
      </div>
      <label className="graph-field">
        깊이 {depth}
        <input type="range" min={1} max={4} value={depth} onChange={(e) => setDepth(Number(e.target.value))} />
      </label>
    </div>
  );
}
