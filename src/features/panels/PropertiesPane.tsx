import { useEffect, useMemo, useState } from "react";
import type { NoteIndex } from "@/core/index";
import { convertValue, removeProperty, setProperty, type Property, type PropertyType, type PropertyValue } from "@/core/index/properties";
import { useIndexVersion } from "@/app/useIndexVersion";

interface Props {
  index: NoteIndex;
  path: string;
  /** Apply an edit to the open note's text. */
  onEdit(edit: (text: string) => string): void;
  addNonce: number;
}

const TYPE_LABEL: Record<Exclude<PropertyType, "raw">, string> = { text: "텍스트", list: "목록", number: "숫자", checkbox: "체크박스", date: "날짜" };
const LIST_KEYS = new Set(["tags", "aliases", "cssclasses"]);

/** Front matter as a form: one row per property, edited in place. Anything unrecognised is shown read-only. */
export function PropertiesPane({ index, path, onEdit, addNonce }: Props) {
  const version = useIndexVersion(index);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const props = useMemo(() => index.propertiesOf(path), [index, path, version]);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    if (addNonce > 0) setAdding(true);
  }, [addNonce]);

  const set = (key: string, value: PropertyValue, type?: PropertyType) => onEdit((t) => setProperty(t, key, value, type));

  return (
    <details className="section" open>
      <summary>
        속성 <span className="count">{props.length}</span>
      </summary>
      {props.length === 0 && !adding && <p className="muted">속성이 없어요</p>}
      <div className="properties">
        {props.map((p) => (
          <PropertyRow key={p.key} prop={p} onSet={(v, t) => set(p.key, v, t)} onRemove={() => onEdit((t) => removeProperty(t, p.key))} />
        ))}
      </div>
      {adding ? (
        <AddProperty
          existing={props.map((p) => p.key)}
          onAdd={(key) => {
            set(key, LIST_KEYS.has(key.toLowerCase()) ? [] : "");
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button className="link-button add-property" onClick={() => setAdding(true)}>
          ＋ 속성 추가
        </button>
      )}
    </details>
  );
}

function AddProperty({ existing, onAdd, onCancel }: { existing: string[]; onAdd(key: string): void; onCancel(): void }) {
  const [key, setKey] = useState("");
  const clean = key.trim();
  const taken = existing.includes(clean);
  return (
    <div className="property-add">
      <input
        autoFocus
        value={key}
        placeholder="속성 이름"
        spellCheck={false}
        onChange={(e) => setKey(e.target.value)}
        onBlur={() => !clean && onCancel()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          else if (e.key === "Enter" && !e.nativeEvent.isComposing && clean && !taken) onAdd(clean);
        }}
      />
      {taken && <span className="muted"> 이미 있어요</span>}
    </div>
  );
}

function PropertyRow({ prop, onSet, onRemove }: { prop: Property; onSet(value: PropertyValue, type?: PropertyType): void; onRemove(): void }) {
  return (
    <div className="property">
      <div className="property-head">
        <span className="property-key" title={prop.key}>
          {prop.key}
        </span>
        {prop.type !== "raw" && (
          <select
            className="property-type"
            value={prop.type}
            title="형식"
            onChange={(e) => {
              const type = e.target.value as PropertyType;
              onSet(convertValue(prop.value, type), type);
            }}
          >
            {Object.entries(TYPE_LABEL).map(([t, label]) => (
              <option key={t} value={t}>
                {label}
              </option>
            ))}
          </select>
        )}
        <button className="property-remove" title="속성 삭제" onClick={onRemove}>
          ×
        </button>
      </div>
      <PropertyValueEditor prop={prop} onSet={onSet} />
    </div>
  );
}

function PropertyValueEditor({ prop, onSet }: { prop: Property; onSet(value: PropertyValue, type?: PropertyType): void }) {
  switch (prop.type) {
    case "checkbox":
      return <input type="checkbox" checked={prop.value === true} onChange={(e) => onSet(e.target.checked, "checkbox")} />;
    case "list":
      return <ListEditor items={prop.value as string[]} onChange={(items) => onSet(items, "list")} />;
    case "raw":
      return <pre className="property-raw">{String(prop.value)}</pre>;
    case "number":
      return <DraftInput type="number" value={String(prop.value)} onCommit={(v) => onSet(v.trim() === "" ? 0 : Number(v), "number")} />;
    case "date":
      return <DraftInput type="date" value={String(prop.value)} onCommit={(v) => onSet(v, "date")} />;
    default:
      return <DraftInput type="text" value={String(prop.value)} onCommit={(v) => onSet(v, "text")} />;
  }
}

/** An input that keeps its own draft while typing and commits on Enter or blur. */
function DraftInput({ value, type, onCommit }: { value: string; type: string; onCommit(value: string): void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft !== value && onCommit(draft);
  return (
    <input
      className="property-input"
      type={type}
      value={draft}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) e.currentTarget.blur();
        else if (e.key === "Escape") (setDraft(value), e.currentTarget.blur());
      }}
    />
  );
}

function ListEditor({ items, onChange }: { items: string[]; onChange(items: string[]): void }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    setDraft("");
    if (v && !items.includes(v)) onChange([...items, v]);
  };
  return (
    <div className="chips property-list">
      {items.map((item) => (
        <span key={item} className="chip">
          {item}
          <button className="chip-remove" title="삭제" onClick={() => onChange(items.filter((i) => i !== item))}>
            ×
          </button>
        </span>
      ))}
      <input
        className="property-input property-list-input"
        value={draft}
        placeholder="추가…"
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) (e.preventDefault(), add());
          else if (e.key === "Backspace" && draft === "" && items.length) onChange(items.slice(0, -1));
        }}
      />
    </div>
  );
}
