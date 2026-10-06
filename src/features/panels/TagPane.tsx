import { useMemo } from "react";
import type { NoteIndex } from "@/core/index";
import { stem } from "@/core/vault";
import { useIndexVersion } from "@/app/useIndexVersion";

interface Props {
  index: NoteIndex;
  selected: string | null;
  onSelect(tag: string | null): void;
  onOpen(path: string): void;
}

/** Every tag in the vault with its note count; a nested tag like `a/b` is listed under `a`. */
export function TagPane({ index, selected, onSelect, onOpen }: Props) {
  const version = useIndexVersion(index);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tags = useMemo(() => [...index.tags()], [index, version]);

  if (tags.length === 0) return <p className="muted pane-empty">아직 태그가 없어요. 노트에 #태그 를 써 보세요.</p>;
  return (
    <ul className="tag-list">
      {tags.map(([tag, paths]) => {
        const depth = tag.split("/").length - 1;
        const open = selected === tag;
        return (
          <li key={tag}>
            <button className={"tree-row" + (open ? " active" : "")} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onSelect(open ? null : tag)}>
              <span className="chevron">{open ? "▾" : "▸"}</span>#{tag.split("/").pop()} <span className="count">{paths.length}</span>
            </button>
            {open && (
              <ul className="tag-notes">
                {paths.map((p) => (
                  <li key={p}>
                    <button className="tree-row file" style={{ paddingLeft: 28 + depth * 14 }} onClick={() => onOpen(p)} title={p}>
                      {stem(p)}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}
