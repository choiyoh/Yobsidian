import { Annotation, EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { NoteIndex } from "@/core/index";
import type { VaultAdapter } from "@/core/vault";
import type { EditorEnv, EditorMode, LinkTarget } from "./env";
import { createExtensions, reconfigureMode } from "./extensions";
import { refreshPreview } from "./live-preview";

export type SaveState = "saved" | "dirty" | "saving" | "error";

export interface NoteEditorHandle {
  /** Write any unsaved edits now. Await before renaming or deleting the open note. */
  flush(): Promise<void>;
  focus(): void;
}

interface Props {
  vault: VaultAdapter;
  index: NoteIndex;
  path: string;
  mode: EditorMode;
  reveal?: { heading?: string; block?: string; nonce: number };
  onOpenLink(link: LinkTarget, from: string): void;
  onOpenTag(tag: string): void;
  onSaveState(state: SaveState): void;
}

const SAVE_DELAY_MS = 600;
const External = Annotation.define<boolean>();

/**
 * One CodeMirror editor that shows whichever note is open. It loads the note from the
 * vault, autosaves through the VaultAdapter after a short pause, keeps the note index
 * in step with the text, and picks up changes made outside the app.
 */
export const NoteEditor = forwardRef<NoteEditorHandle, Props>(function NoteEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef(props);
  latest.current = props;

  const session = useRef({ path: null as string | null, dirty: false, timer: 0, lastSaved: "", loaded: false, openedBefore: false, saving: Promise.resolve() });

  const flush = (): Promise<void> => {
    const s = session.current;
    window.clearTimeout(s.timer);
    const v = view.current;
    if (!s.dirty || !v || s.path === null) return s.saving;
    const { vault, index, onSaveState } = latest.current;
    const path = s.path;
    const text = v.state.doc.toString();
    s.dirty = false;
    onSaveState("saving");
    s.saving = s.saving
      .then(async () => {
        await vault.writeText(path, text);
        index.setNote(path, text, (await vault.stat(path)) ?? undefined);
        s.lastSaved = text;
        if (!s.dirty) latest.current.onSaveState("saved");
      })
      .catch((e) => {
        console.error("save failed", e);
        s.dirty = true;
        latest.current.onSaveState("error");
      });
    return s.saving;
  };

  useImperativeHandle(ref, () => ({ flush, focus: () => view.current?.focus() }));

  const revealIn = (v: EditorView, path: string, reveal: Props["reveal"]) => {
    if (!reveal) return;
    const doc = v.state.doc;
    let pos: number | null = null;
    if (reveal.heading) {
      const want = reveal.heading.trim().toLowerCase();
      const h = latest.current.index.headingsOf(path).find((x) => x.text.toLowerCase() === want);
      if (h && h.line < doc.lines) pos = doc.line(h.line + 1).from;
    } else if (reveal.block) {
      const marker = "^" + reveal.block;
      for (let n = 1; n <= doc.lines && pos === null; n++) if (doc.line(n).text.trimEnd().endsWith(marker)) pos = doc.line(n).from;
    }
    if (pos !== null) v.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 24 }) });
  };

  // Create the editor view once.
  useEffect(() => {
    const v = new EditorView({ parent: host.current! });
    view.current = v;
    const unsubscribe = latest.current.index.subscribe(() => v.dispatch({ effects: refreshPreview.of(null) }));
    const onHide = () => {
      if (document.visibilityState === "hidden") void flush();
    };
    const onBeforeUnload = () => void flush();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
      unsubscribe();
      void flush();
      v.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load a note whenever the path (or vault) changes.
  useEffect(() => {
    const v = view.current!;
    const s = session.current;
    let cancelled = false;
    const { path, vault, index } = props;

    void (async () => {
      await flush(); // write the previous note before leaving it
      const text = await vault.readText(path).catch(() => "");
      if (cancelled) return;
      const env: EditorEnv = {
        index,
        vault,
        path,
        openLink: (link) => latest.current.onOpenLink(link, path),
        openUrl: (url) => window.open(url, "_blank", "noopener,noreferrer"),
        openTag: (tag) => latest.current.onOpenTag(tag),
      };
      const onChange = () => {
        if (s.path !== path) return;
        s.dirty = true;
        latest.current.onSaveState("dirty");
        window.clearTimeout(s.timer);
        s.timer = window.setTimeout(() => void flush(), SAVE_DELAY_MS);
      };
      const state = EditorState.create({
        doc: text,
        extensions: [
          createExtensions(env, latest.current.mode, () => void flush()),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !u.transactions.some((tr) => tr.annotation(External))) onChange();
          }),
        ],
      });
      s.path = path;
      s.lastSaved = text;
      s.dirty = false;
      s.loaded = true;
      v.setState(state);
      latest.current.onSaveState("saved");
      v.scrollDOM.scrollTop = 0;
      revealIn(v, path, latest.current.reveal);
      if (s.openedBefore) v.focus();
      s.openedBefore = true;
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.path, props.vault, props.index]);

  useEffect(() => {
    const v = view.current;
    if (v && session.current.loaded) reconfigureMode(v, props.mode);
  }, [props.mode]);

  useEffect(() => {
    const v = view.current;
    const s = session.current;
    if (v && s.loaded && s.path === props.path) revealIn(v, props.path, props.reveal);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.reveal?.nonce]);

  // Pick up edits made outside the editor (another app, a sync pull) while there is nothing unsaved here.
  useEffect(() => {
    return props.vault.watch?.((change) => {
      const s = session.current;
      const v = view.current;
      if (!v || s.dirty || change.type !== "modify" || change.path !== s.path) return;
      const path = s.path;
      void props.vault
        .readText(path)
        .then((text) => {
          if (s.path !== path || s.dirty || text === v.state.doc.toString()) return;
          s.lastSaved = text;
          const head = Math.min(v.state.selection.main.head, text.length);
          v.dispatch({
            changes: { from: 0, to: v.state.doc.length, insert: text },
            selection: { anchor: head },
            annotations: [External.of(true), Transaction.addToHistory.of(false)],
          });
          props.index.setNote(path, text);
        })
        .catch(() => {});
    });
  }, [props.vault, props.index]);

  return <div className="note-editor" ref={host} />;
});
