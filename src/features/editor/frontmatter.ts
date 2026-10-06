import type { MarkdownConfig } from "@lezer/markdown";
import { FRONTMATTER } from "@/core/index/parse";

/**
 * Teaches the Markdown parser about YAML front matter: a `---` fenced block at
 * the very start of the document becomes one `Frontmatter` node instead of a
 * horizontal rule plus a setext heading.
 */
export const frontmatterExtension: MarkdownConfig = {
  defineNodes: [{ name: "Frontmatter", block: true }],
  parseBlock: [
    {
      name: "Frontmatter",
      before: "HorizontalRule",
      parse(cx, line) {
        if (cx.lineStart !== 0 || !/^---[ \t]*$/.test(line.text)) return false;
        // `input` exists at runtime but is missing from @lezer/markdown's typings; we need it to
        // look ahead for the closing fence without consuming lines.
        const input = (cx as unknown as { input: { length: number; read(from: number, to: number): string } }).input;
        const m = FRONTMATTER.exec(input.read(0, Math.min(input.length, 65536)));
        if (!m) return false;
        const end = m[0].replace(/\r?\n$/, "").length;
        while (cx.lineStart + line.text.length < end) if (!cx.nextLine()) break;
        cx.addElement(cx.elt("Frontmatter", 0, end));
        cx.nextLine();
        return true;
      },
    },
  ],
};
