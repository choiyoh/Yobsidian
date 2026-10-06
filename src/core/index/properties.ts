import { FRONTMATTER } from "./parse";

/**
 * Reading and editing YAML front matter ("properties" in Obsidian) without
 * round-tripping the whole block through a YAML library: an edit only touches
 * the lines of the one key, so comments, key order and exotic values the app
 * doesn't understand stay exactly as the user wrote them.
 */

export type PropertyType = "text" | "number" | "checkbox" | "date" | "list" | "raw";
export type PropertyValue = string | number | boolean | string[];

export interface Property {
  key: string;
  type: PropertyType;
  /** Typed value. For `raw` (nested maps, multi-line scalars) this is the source text. */
  value: PropertyValue;
}

interface Block {
  key: string;
  /** First and last line index (inclusive) in the front matter lines. */
  start: number;
  end: number;
}

interface Parts {
  /** `---` and its newline. */
  head: string;
  lines: string[];
  /** The closing `---` line and everything after it. */
  closing: string;
  /** Everything after the front matter block. */
  after: string;
  eol: string;
}

const KEY_LINE = /^([^\s#:\-"'][^:]*?|"[^"]+"|'[^']+'):(?:[ \t]+(.*)|[ \t]*)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)$/;

function split(text: string): Parts | null {
  const m = FRONTMATTER.exec(text);
  if (!m) return null;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const bodyStart = text.indexOf("\n") + 1;
  const yaml = m[1] ?? "";
  let closingAt = bodyStart;
  if (m[1] !== undefined) closingAt = bodyStart + yaml.length + (text[bodyStart + yaml.length] === "\r" ? 2 : 1);
  return {
    head: text.slice(0, bodyStart),
    lines: yaml.trim() === "" ? [] : yaml.split(/\r?\n/),
    closing: text.slice(closingAt),
    after: text.slice(m[0].length),
    eol,
  };
}

function join(p: Parts): string {
  return p.head + (p.lines.length ? p.lines.join(p.eol) + p.eol : "") + p.closing;
}

function blocks(lines: string[]): Block[] {
  const out: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = KEY_LINE.exec(lines[i]);
    if (!m) continue;
    let end = i;
    let j = i + 1;
    while (j < lines.length && !KEY_LINE.exec(lines[j])) {
      if (lines[j].trim() !== "" && !/^\s*#/.test(lines[j])) end = j;
      j++;
    }
    out.push({ key: unquoteKey(m[1]), start: i, end });
    i = end;
  }
  return out;
}

function unquoteKey(k: string): string {
  return /^(["']).*\1$/.test(k) ? k.slice(1, -1) : k.trim();
}

export function readProperties(text: string): Property[] {
  const parts = split(text);
  if (!parts) return [];
  return blocks(parts.lines).map((b) => parseBlock(parts.lines.slice(b.start, b.end + 1), b.key));
}

function parseBlock(lines: string[], key: string): Property {
  const m = KEY_LINE.exec(lines[0])!;
  const inline = (m[2] ?? "").trim();
  const rest = lines.slice(1);
  if (inline === "") {
    if (rest.length === 0) return { key, type: "text", value: "" };
    if (rest.every((l) => /^\s*-(\s|$)/.test(l))) return { key, type: "list", value: rest.map((l) => scalarText(l.replace(/^\s*-\s*/, ""))) };
    return { key, type: "raw", value: rest.join("\n") };
  }
  if (rest.length > 0 || /^[|>{]/.test(inline)) return { key, type: "raw", value: [inline, ...rest].join("\n") };
  if (inline.startsWith("[") && inline.endsWith("]")) return { key, type: "list", value: flowList(inline.slice(1, -1)) };
  return typedScalar(key, inline);
}

function typedScalar(key: string, s: string): Property {
  if (/^["']/.test(s)) return { key, type: "text", value: scalarText(s) };
  const bare = s.replace(/\s+#.*$/, "").trim();
  if (/^(true|false)$/i.test(bare)) return { key, type: "checkbox", value: bare.toLowerCase() === "true" };
  if (NUMBER.test(bare)) return { key, type: "number", value: Number(bare) };
  if (DATE.test(bare)) return { key, type: "date", value: bare };
  if (/^(null|~)$/i.test(bare)) return { key, type: "text", value: "" };
  return { key, type: "text", value: bare };
}

/** Text of a scalar: strips quotes (handling escapes) or a trailing ` # comment`. */
function scalarText(s: string): string {
  s = s.trim();
  if (s.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"/.exec(s);
    if (m) return m[1].replace(/\\(["\\nt])/g, (_, c) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
  } else if (s.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'/.exec(s);
    if (m) return m[1].replace(/''/g, "'");
  }
  return s.replace(/\s+#.*$/, "");
}

function flowList(s: string): string[] {
  const items: string[] = [];
  let cur = "";
  let quote = "";
  for (const ch of s) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ",") {
      items.push(cur);
      cur = "";
    } else cur += ch;
  }
  items.push(cur);
  return items.map(scalarText).filter((x) => x !== "");
}

// ------------------------------------------------------------------ writing

function needsQuotes(s: string, forText: boolean): boolean {
  if (s === "" || s !== s.trim()) return true;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return true;
  if (/: |:$| #|\n|\t/.test(s)) return true;
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(s)) return true;
  if (forText && (NUMBER.test(s) || DATE.test(s))) return true;
  return false;
}

function quote(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t") + '"';
}

function scalar(s: string, type: PropertyType): string {
  if (type === "date" && DATE.test(s)) return s;
  return needsQuotes(s, true) ? quote(s) : s;
}

function keyText(key: string): string {
  return /^[^\s#:\-"'][^:]*$/.test(key) && key === key.trim() ? key : quote(key);
}

/** The YAML lines that express `key: value`. */
function render(key: string, value: PropertyValue, type: PropertyType): string[] {
  const k = keyText(key);
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${k}: []`];
    return [`${k}:`, ...value.map((v) => `  - ${needsQuotes(v, false) ? quote(v) : v}`)];
  }
  if (typeof value === "boolean") return [`${k}: ${value}`];
  if (typeof value === "number") return [`${k}: ${Number.isFinite(value) ? value : 0}`];
  if (type === "raw") return `${k}: ${value}`.split("\n");
  return [`${k}: ${scalar(value, type)}`];
}

/** Set (or add) one property. Creates the front matter block if the note has none. */
export function setProperty(text: string, key: string, value: PropertyValue, type: PropertyType = inferType(value)): string {
  const parts = split(text);
  const lines = render(key, value, type);
  if (!parts) {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    return `---${eol}${lines.join(eol)}${eol}---${eol}${text}`;
  }
  const found = blocks(parts.lines).find((b) => b.key === key);
  if (found) parts.lines.splice(found.start, found.end - found.start + 1, ...lines);
  else parts.lines.push(...lines);
  return join(parts);
}

/** Remove a property; drops the whole front matter block if it ends up empty. */
export function removeProperty(text: string, key: string): string {
  const parts = split(text);
  if (!parts) return text;
  const found = blocks(parts.lines).find((b) => b.key === key);
  if (!found) return text;
  parts.lines.splice(found.start, found.end - found.start + 1);
  if (parts.lines.every((l) => l.trim() === "")) {
    // Nothing left: remove the `---` fences too.
    return parts.after;
  }
  return join(parts);
}

export function inferType(value: PropertyValue): PropertyType {
  if (Array.isArray(value)) return "list";
  if (typeof value === "boolean") return "checkbox";
  if (typeof value === "number") return "number";
  return "text";
}

/** Convert a value to another type for the type menu (best effort, never throws). */
export function convertValue(value: PropertyValue, to: PropertyType): PropertyValue {
  const asText = Array.isArray(value) ? value.join(", ") : String(value);
  switch (to) {
    case "list":
      return Array.isArray(value) ? value : asText.trim() === "" ? [] : asText.split(",").map((s) => s.trim()).filter(Boolean);
    case "number": {
      const n = Number(asText);
      return Number.isFinite(n) && asText.trim() !== "" ? n : 0;
    }
    case "checkbox":
      return value === true || /^(true|yes|1)$/i.test(asText);
    case "date":
      return DATE.test(asText) ? asText : "";
    default:
      return asText;
  }
}
