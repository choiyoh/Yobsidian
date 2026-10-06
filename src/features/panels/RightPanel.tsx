import { useMemo } from "react";
import type { NoteIndex } from "@/core/index";
import { stem } from "@/core/vault";
import { useIndexVersion } from "@/app/useIndexVersion";
import { LocalGraph } from "@/features/graph/GraphView";

interface Props {
  index: NoteIndex;
  path: string;
  onOpen(path: string, reveal?: { heading?: string }): void;
  onCreate(target: string, from: string): void;
  onTag(tag: string): void;
}

/** Backlinks, outgoing links, tags and outline of the open note. */
export function RightPanel({ index, path, onOpen, onCreate, onTag }: Props) {
  const version = useIndexVersion(index);
  const data = useMemo(() => {
    const backlinks = new Map<string, string[]>();
    for (const b of index.backlinksTo(path)) (backlinks.get(b.source) ?? backlinks.set(b.source, []).get(b.source)!).push(b.context);
    const outgoing = new Map<string, { target: string; resolved: string | null }>();
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

  return (
    <aside className="panel right-panel">
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

      <details className="section" open>
        <summary>로컬 그래프</summary>
        <LocalGraph index={index} path={path} onOpen={(p) => onOpen(p)} />
      </details>

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
