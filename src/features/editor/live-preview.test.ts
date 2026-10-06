import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { GFM } from "@lezer/markdown";
import { describe, expect, it } from "vitest";
import { NoteIndex } from "@/core/index";
import { MemoryAdapter } from "@/core/vault";
import { editorEnv, editorMode, type EditorEnv, type EditorMode } from "./env";
import { frontmatterExtension } from "./frontmatter";
import { buildDecorations } from "./live-preview";

interface Item {
  text: string;
  kind: string;
}

async function decorate(doc: string, opts: { cursor?: number; mode?: EditorMode; files?: Record<string, string> } = {}) {
  const vault = new MemoryAdapter("t", { "Cur.md": doc, "Other.md": "# Head\n", "pic.png": "x", ...opts.files });
  const index = new NoteIndex();
  await index.load(vault);
  const env: EditorEnv = { index, vault, path: "Cur.md", openLink() {}, openUrl() {}, openTag() {}, saveAttachment: async () => "", notify() {} };
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(Math.min(opts.cursor ?? doc.length, doc.length)),
    extensions: [
      markdown({ base: markdownLanguage, extensions: [GFM, frontmatterExtension] }),
      editorEnv.of(env),
      editorMode.of(opts.mode ?? "live"),
    ],
  });
  const items: Item[] = [];
  const set = buildDecorations(state);
  set.between(0, doc.length, (from, to, deco) => {
    const spec = deco.spec as { class?: string; widget?: { constructor: { name: string } } };
    const kind = spec.widget ? spec.widget.constructor.name : spec.class ? spec.class : "hide";
    items.push({ text: doc.slice(from, to), kind: from === to ? `line:${kind}` : kind });
  });
  return items;
}

const kinds = (items: Item[]) => items.map((i) => i.kind);

describe("live preview decorations", () => {
  it("styles headings and hides the # marker away from the cursor", async () => {
    const items = await decorate("# Title\n\ntext", { cursor: 12 });
    expect(items).toContainEqual({ text: "", kind: "line:cm-heading cm-h1" });
    expect(items).toContainEqual({ text: "# ", kind: "hide" });
  });

  it("reveals markers on the cursor line", async () => {
    const items = await decorate("# Title\n\ntext", { cursor: 3 });
    expect(items.some((i) => i.kind === "hide")).toBe(false);
  });

  it("hides emphasis markers unless the cursor is inside", async () => {
    const away = await decorate("a **bold** b", { cursor: 0 });
    expect(away.filter((i) => i.kind === "hide").map((i) => i.text)).toEqual(["**", "**"]);
    expect(away).toContainEqual({ text: "**bold**", kind: "cm-strong" });
    const inside = await decorate("a **bold** b", { cursor: 5 });
    expect(inside.some((i) => i.kind === "hide")).toBe(false);
  });

  it("renders wikilinks as widgets, flags unresolved ones, and shows raw text under the cursor", async () => {
    const doc = "see [[Other|alias]] and [[Nope]]";
    const away = await decorate(doc, { cursor: 0 });
    expect(away.map((i) => [i.text, i.kind])).toEqual([
      ["[[Other|alias]]", "WikilinkWidget"],
      ["[[Nope]]", "WikilinkWidget"],
    ]);
    const on = await decorate(doc, { cursor: 8 });
    expect(on[0]).toEqual({ text: "[[Other|alias]]", kind: "cm-wikilink cm-wikilink-raw" });
    expect(on[1].kind).toBe("WikilinkWidget");
  });

  it("does not treat [[links]] in code as links, nor squares as markers", async () => {
    const items = await decorate("`[[X]]` and [plain] text\n\n```\n[[Y]] #z\n```\n", { cursor: 0 });
    expect(items.some((i) => i.kind === "WikilinkWidget" || i.kind === "cm-tag")).toBe(false);
    expect(items.some((i) => i.text === "[" || i.text === "]")).toBe(false);
  });

  it("embeds images and notes", async () => {
    const items = await decorate("![[pic.png]]\n\n![[Other#Head]]\n\nend");
    expect(kinds(items.filter((i) => i.text.startsWith("!")))).toEqual(["ImageWidget", "NoteEmbedWidget"]);
  });

  it("marks tags but not heading text or numbers", async () => {
    const items = await decorate("# Heading\n#tag and #2024 and a#b\n", { cursor: 0 });
    expect(items.filter((i) => i.kind === "cm-tag").map((i) => i.text)).toEqual(["#tag"]);
  });

  it("hides markdown link syntax and keeps the text clickable", async () => {
    const items = await decorate("go [home](https://x.dev) now", { cursor: 0 });
    expect(items.filter((i) => i.kind === "hide").map((i) => i.text)).toEqual(["[", "](https://x.dev)"]);
    expect(items).toContainEqual({ text: "home", kind: "cm-md-link" });
  });

  it("renders task checkboxes and bullets", async () => {
    const items = await decorate("- [ ] todo\n- [x] done\n- item\n", { cursor: 100 });
    expect(items.filter((i) => i.kind === "CheckboxWidget")).toHaveLength(2);
    expect(items.filter((i) => i.kind === "BulletWidget")).toHaveLength(1);
    expect(items).toContainEqual({ text: " done", kind: "cm-task-done" });
  });

  it("treats front matter as one block, not a rule or heading", async () => {
    const items = await decorate("---\ntags: [a]\n---\n# Real\n", { cursor: 100 });
    expect(kinds(items).filter((k) => k.startsWith("line:cm-frontmatter"))).toHaveLength(3);
    expect(items.filter((i) => i.kind.includes("cm-h")).map((i) => i.kind)).toEqual(["line:cm-heading cm-h1"]);
    expect(items.some((i) => i.kind === "RuleWidget")).toBe(false);
  });

  it("source mode keeps all text visible and only styles links and tags", async () => {
    const items = await decorate("# T\n**b** [[Other]] #tag", { cursor: 0, mode: "source" });
    expect(kinds(items).sort()).toEqual(["cm-tag", "cm-wikilink"].sort());
  });

  it("reading mode never reveals markers", async () => {
    const items = await decorate("# Title\ntext", { cursor: 2, mode: "reading" });
    expect(items).toContainEqual({ text: "# ", kind: "hide" });
  });
});
