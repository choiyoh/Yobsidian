import { useEffect, useRef, useState } from "react";
import { stem, type TreeNode } from "@/core/vault";

interface Props {
  root: TreeNode;
  activePath: string | null;
  renaming: string | null;
  onOpen: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, node: TreeNode) => void;
  onRename: (path: string, name: string) => void;
  onCancelRename: () => void;
}

export function FileTree({ root, ...rest }: Props) {
  return (
    <ul className="tree" role="tree">
      {root.children.map((node) => (
        <TreeItem key={node.path} node={node} {...rest} />
      ))}
    </ul>
  );
}

function displayName(node: TreeNode) {
  return node.kind === "file" && node.name.endsWith(".md") ? stem(node.name) : node.name;
}

function TreeItem({ node, ...rest }: { node: TreeNode } & Omit<Props, "root">) {
  const { activePath, renaming, onOpen, onContextMenu, onRename, onCancelRename } = rest;
  const [open, setOpen] = useState(true);

  const label =
    renaming === node.path ? (
      <RenameInput initial={displayName(node)} onCommit={(name) => onRename(node.path, name)} onCancel={onCancelRename} />
    ) : (
      displayName(node)
    );

  if (node.kind === "folder") {
    return (
      <li role="treeitem" aria-expanded={open}>
        <button className="tree-row folder" onClick={() => setOpen(!open)} onContextMenu={(e) => onContextMenu(e, node)}>
          <span className="chevron">{open ? "▾" : "▸"}</span>
          {label}
        </button>
        {open && (
          <ul role="group">
            {node.children.map((child) => (
              <TreeItem key={child.path} node={child} {...rest} />
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
        onContextMenu={(e) => onContextMenu(e, node)}
        title={node.path}
      >
        {label}
      </button>
    </li>
  );
}

function RenameInput({ initial, onCommit, onCancel }: { initial: string; onCommit: (name: string) => void; onCancel: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit && value.trim() && value.trim() !== initial) onCommit(value.trim());
    else onCancel();
  };
  return (
    <input
      ref={ref}
      className="rename-input"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) finish(true);
        else if (e.key === "Escape") finish(false);
        e.stopPropagation();
      }}
    />
  );
}
