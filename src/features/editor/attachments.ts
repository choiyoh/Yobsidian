import { EditorView } from "@codemirror/view";
import { isImageMime } from "@/core/attachments";
import { editorEnv } from "./env";

/**
 * Pasting or dropping files into the editor saves them to the vault and inserts a link:
 * `![[image.png]]` for images, `[[file.pdf]]` for everything else.
 */
export const attachmentHandlers = EditorView.domEventHandlers({
  paste(event, view) {
    const files = [...(event.clipboardData?.files ?? [])];
    if (!files.length || view.state.readOnly) return false;
    event.preventDefault();
    void insertFiles(view, files, undefined, true);
    return true;
  },
  drop(event, view) {
    const files = [...(event.dataTransfer?.files ?? [])];
    if (!files.length || view.state.readOnly) return false;
    event.preventDefault();
    const at = view.posAtCoords({ x: event.clientX, y: event.clientY });
    void insertFiles(view, files, at ?? undefined);
    return true;
  },
});

async function insertFiles(view: EditorView, files: File[], at?: number, pasted = false) {
  const env = view.state.facet(editorEnv);
  const links: string[] = [];
  for (const file of files) {
    try {
      const path = await env.saveAttachment({ bytes: new Uint8Array(await file.arrayBuffer()), name: pasted && isImageMime(file.type) ? undefined : file.name, mime: file.type });
      const link = `[[${env.index.linkTextFor(path)}]]`;
      links.push(isImageMime(file.type) || /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(path) ? "!" + link : link);
    } catch (e) {
      env.notify(`첨부 파일을 저장하지 못했어요: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (!links.length) return;
  const text = links.join("\n");
  const pos = Math.min(at ?? view.state.selection.main.head, view.state.doc.length);
  const from = at === undefined ? view.state.selection.main.from : pos;
  const to = at === undefined ? view.state.selection.main.to : pos;
  view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: "input.paste", scrollIntoView: true });
  view.focus();
}
