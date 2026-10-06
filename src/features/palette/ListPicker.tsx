import { useEffect, useMemo, useRef, useState } from "react";

export interface PickerItem {
  id: string;
  label: string;
  /** Muted text after the label (a shortcut, a folder). */
  detail?: string;
}

interface Props {
  title: string;
  placeholder: string;
  items: PickerItem[];
  empty?: string;
  onChoose(id: string): void;
  onClose(): void;
}

/** Score `label` against `query`: contiguous matches beat word starts beat scattered letters; 0 = no match. */
export function fuzzyScore(label: string, query: string): number {
  const l = label.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return 1;
  if (l === q) return 100;
  if (l.startsWith(q)) return 80;
  const at = l.indexOf(q);
  if (at !== -1) return 60 - Math.min(at, 20) * 0.5;
  let i = 0;
  for (const ch of l) if (ch === q[i] && ++i === q.length) return 20;
  return 0;
}

export function filterItems(items: PickerItem[], query: string): PickerItem[] {
  if (!query.trim()) return items;
  return items
    .map((item, order) => ({ item, order, score: fuzzyScore(item.label, query) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((x) => x.item);
}

/** A modal list with a filter box: the shared shell of the command palette and the template chooser. */
export function ListPicker({ title, placeholder, items, empty = "결과가 없어요", onChoose, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const shown = useMemo(() => filterItems(items, query), [items, query]);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    list.current?.children[selected]?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="switcher" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <input
          ref={input}
          value={query}
          placeholder={placeholder}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") (e.preventDefault(), setSelected((s) => Math.min(s + 1, shown.length - 1)));
            else if (e.key === "ArrowUp") (e.preventDefault(), setSelected((s) => Math.max(s - 1, 0)));
            else if (e.key === "Enter" && !e.nativeEvent.isComposing && shown[selected]) (e.preventDefault(), onChoose(shown[selected].id));
          }}
        />
        <ul ref={list}>
          {shown.map((item, i) => (
            <li key={item.id}>
              <button className={i === selected ? "active" : ""} onMouseEnter={() => setSelected(i)} onClick={() => onChoose(item.id)}>
                <span>{item.label}</span>
                {item.detail && <span className="muted path"> {item.detail}</span>}
              </button>
            </li>
          ))}
          {shown.length === 0 && <li className="muted picker-empty">{empty}</li>}
        </ul>
      </div>
    </div>
  );
}
