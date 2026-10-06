import { useDeferredValue, useEffect, useMemo, useRef } from "react";
import type { NoteIndex } from "@/core/index";
import { dirname } from "@/core/vault";
import { useIndexVersion } from "@/app/useIndexVersion";

interface Props {
  index: NoteIndex;
  query: string;
  onQuery(query: string): void;
  /** Bumped to move focus into the box (Ctrl/Cmd+Shift+F). */
  focusNonce: number;
  onOpen(path: string, reveal?: { line: number }): void;
}

const MAX_RESULTS = 100;

/** Full-text search across the vault; results show matching lines with the hits highlighted. */
export function SearchPane({ index, query, onQuery, focusNonce, onOpen }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const version = useIndexVersion(index);
  const deferred = useDeferredValue(query);
  const results = useMemo(
    () => (deferred.trim() ? index.searchContent(deferred, { limit: MAX_RESULTS }) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [index, deferred, version],
  );

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusNonce]);

  return (
    <div className="search-pane">
      <input
        ref={input}
        className="search-input"
        value={query}
        placeholder="볼트에서 검색…"
        spellCheck={false}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onQuery("");
          else if (e.key === "Enter" && !e.nativeEvent.isComposing && results[0]) onOpen(results[0].path, results[0].matches[0] && { line: results[0].matches[0].line });
        }}
      />
      {!query.trim() && (
        <p className="muted search-help">
          <code>"정확한 문구"</code> · <code>-제외</code> · <code>path:폴더</code> · <code>file:이름</code> · <code>tag:태그</code> · <code>content:본문</code>
        </p>
      )}
      {query.trim() && (
        <p className="muted search-count">{results.length === 0 ? "결과가 없어요" : `${results.length}${results.length >= MAX_RESULTS ? "+" : ""}개 노트`}</p>
      )}
      <ul className="search-results">
        {results.map((r) => (
          <li key={r.path}>
            <button className="search-note" onClick={() => onOpen(r.path, r.matches[0] && { line: r.matches[0].line })} title={r.path}>
              <span className="search-title">{r.name}</span>
              {dirname(r.path) && <span className="muted search-dir"> {dirname(r.path)}</span>}
              {r.count > 0 && <span className="count">{r.count}</span>}
            </button>
            {r.matches.map((m) => (
              <button key={m.line} className="search-line" onClick={() => onOpen(r.path, { line: m.line })}>
                <Highlighted text={m.text} ranges={m.ranges} />
              </button>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Highlighted({ text, ranges }: { text: string; ranges: [number, number][] }) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  ranges.forEach(([s, e], i) => {
    if (s > at) parts.push(text.slice(at, s));
    parts.push(<mark key={i}>{text.slice(s, e)}</mark>);
    at = e;
  });
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}
