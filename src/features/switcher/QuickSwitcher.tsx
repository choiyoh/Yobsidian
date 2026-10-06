import { useEffect, useMemo, useRef, useState } from "react";
import type { NoteIndex } from "@/core/index";
import { dirname } from "@/core/vault";

interface Props {
  index: NoteIndex;
  onClose(): void;
  onOpen(path: string): void;
  onCreate(name: string): void;
}

/** Ctrl/Cmd+O: type to find a note by name or alias; Enter opens it, or creates it if nothing matches. */
export function QuickSwitcher({ index, onClose, onOpen, onCreate }: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const results = useMemo(() => index.search(query, 12), [index, query]);
  const trimmed = query.trim();
  const canCreate = trimmed !== "" && !results.some((r) => r.name.toLowerCase() === trimmed.toLowerCase());
  const total = results.length + (canCreate ? 1 : 0);

  useEffect(() => input.current?.focus(), []);

  const choose = (i: number) => {
    if (i < results.length) onOpen(results[i].path);
    else if (canCreate) onCreate(trimmed);
  };

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="switcher" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="빠른 전환">
        <input
          ref={input}
          value={query}
          placeholder="노트 이름 입력…"
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") (e.preventDefault(), setSelected((s) => Math.min(s + 1, total - 1)));
            else if (e.key === "ArrowUp") (e.preventDefault(), setSelected((s) => Math.max(s - 1, 0)));
            else if (e.key === "Enter" && !e.nativeEvent.isComposing) (e.preventDefault(), choose(selected));
          }}
        />
        <ul>
          {results.map((r, i) => (
            <li key={r.path + (r.alias ?? "")}>
              <button className={i === selected ? "active" : ""} onMouseEnter={() => setSelected(i)} onClick={() => choose(i)}>
                <span>{r.alias ?? r.name}</span>
                {r.alias && <span className="muted"> → {r.name}</span>}
                {dirname(r.path) && <span className="muted path"> {dirname(r.path)}</span>}
              </button>
            </li>
          ))}
          {canCreate && (
            <li>
              <button className={selected === results.length ? "active" : ""} onMouseEnter={() => setSelected(results.length)} onClick={() => choose(results.length)}>
                <span className="muted">새 노트 만들기: </span>
                <span>{trimmed}</span>
              </button>
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
