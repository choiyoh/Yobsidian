import { useState } from "react";
import { stem, type TreeNode } from "@/core/vault";

interface Props {
  root: TreeNode;
  activePath: string | null;
  onOpen: (path: string) => void;
}

export function FileTree({ root, activePath, onOpen }: Props) {
  return (
    <ul className="tree" role="tree">
      {root.children.map((node) => (
        <TreeItem key={node.path} node={node} activePath={activePath} onOpen={onOpen} />
      ))}
    </ul>
  );
}

function TreeItem({ node, activePath, onOpen }: { node: TreeNode } & Omit<Props, "root">) {
  const [open, setOpen] = useState(true);

  if (node.kind === "folder") {
    return (
      <li role="treeitem" aria-expanded={open}>
        <button className="tree-row folder" onClick={() => setOpen(!open)}>
          <span className="chevron">{open ? "▾" : "▸"}</span>
          {node.name}
        </button>
        {open && (
          <ul role="group">
            {node.children.map((child) => (
              <TreeItem key={child.path} node={child} activePath={activePath} onOpen={onOpen} />
            ))}
          </ul>
        )}
      </li>
    );
  }

  return (
    <li role="treeitem" aria-selected={node.path === activePath}>
      <button
        className={"tree-row file" + (node.path === activePath ? " active" : "")}
        onClick={() => onOpen(node.path)}
        title={node.path}
      >
        {node.name.endsWith(".md") ? stem(node.name) : node.name}
      </button>
    </li>
  );
}
