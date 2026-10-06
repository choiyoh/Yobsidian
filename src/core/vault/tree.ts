import { basename, dirname, isHidden } from "./paths";
import type { VaultEntry } from "./types";

export interface TreeNode {
  path: string;
  name: string;
  kind: VaultEntry["kind"];
  children: TreeNode[];
}

/**
 * Build the file-explorer tree from a flat listing. Hidden paths (`.obsidian`,
 * `.trash`, ...) are left out. Folders sort before files, then by name,
 * matching Obsidian's default explorer order.
 */
export function buildTree(entries: VaultEntry[]): TreeNode {
  const root: TreeNode = { path: "", name: "", kind: "folder", children: [] };
  const byPath = new Map<string, TreeNode>([["", root]]);

  const visible = entries.filter((e) => !isHidden(e.path)).sort((a, b) => a.path.localeCompare(b.path));
  for (const entry of visible) {
    byPath.set(entry.path, { path: entry.path, name: basename(entry.path), kind: entry.kind, children: [] });
  }
  for (const entry of visible) {
    const parent = byPath.get(dirname(entry.path)) ?? root;
    parent.children.push(byPath.get(entry.path)!);
  }
  for (const node of byPath.values()) node.children.sort(compareNodes);
  return root;
}

function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}
