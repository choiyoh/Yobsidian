import { useEffect, useRef, useState } from "react";
import { dirname, isWithin, stem, type TreeNode } from "@/core/vault";

interface Props {
  root: TreeNode;
  activePath: string | null;
  renaming: string | null;
  onOpen: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, node: TreeNode) => void;
  onRename: (path: string, name: string) => void;
  onCancelRename: () => void;
  /** Move `path` into the folder `folder` ("" is the vault root). */
  onMove: (path: string, folder: string) => void;
}

/** Drag-and-drop state shared by every row: what is being dragged and which folder would receive it. */
interface Drag {
  source: string | null;
  target: string | null;
  start: (path: string) => void;
  over: (folder: string) => void;
  end: () => void;
}

/** A path can move into `folder` unless it is already there, or the folder is the path itself or inside it. */
export function canMoveInto(path: string, folder: string): boolean {
  return dirname(path) !== folder && !isWithin(folder, path);
}

export function FileTree({ root, onMove, ...rest }: Props) {
  const [source, setSource] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const end = () => (setSource(null), setTarget(null));
  const drag: Drag = {
    source,
    target,
    start: setSource,
    over: (folder) => setTarget(source !== null && canMoveInto(source, folder) ? folder : null),
    end,
  };
  const drop = (e: React.DragEvent, folder: string) => {
    e.preventDefault();
    e.stopPropagation();
    const path = source ?? e.dataTransfer.getData("text/plain");
    end();
    if (path && canMoveInto(path, folder)) onMove(path, folder);
  };
  // Dropping anywhere that is not a folder row (the gaps, below the last row) means the vault root.
  return (
    <div
      className={"tree-root" + (target === "" ? " drop-target" : "")}
      onDragOver={(e) => {
        if (source === null) return;
        drag.over("");
        if (canMoveInto(source, "")) e.preventDefault();
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setTarget(null);
      }}
      onDrop={(e) => drop(e, "")}
    >
      <ul className="tree" role="tree">
        {root.children.map((node) => (
          <TreeItem key={node.path} node={node} drag={drag} onDrop={drop} {...rest} />
        ))}
      </ul>
    </div>
  );
}

function displayName(node: TreeNode) {
  return node.kind === "file" && node.name.endsWith(".md") ? stem(node.name) : node.name;
}

type ItemProps = { node: TreeNode; drag: Drag; onDrop: (e: React.DragEvent, folder: string) => void } & Omit<Props, "root" | "onMove">;

function TreeItem({ node, ...rest }: ItemProps) {
  const { activePath, renaming, onOpen, onContextMenu, onRename, onCancelRename, drag, onDrop } = rest;
  const [open, setOpen] = useState(true);
  // Rows drop into their own folder (folders) or their parent folder (files).
  const dropFolder = node.kind === "folder" ? node.path : dirname(node.path);
  const dragProps = {
    draggable: renaming !== node.path,
    onDragStart: (e: React.DragEvent) => {
      e.stopPropagation();
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", node.path);
      drag.start(node.path);
    },
    onDragEnd: drag.end,
    onDragOver: (e: React.DragEvent) => {
      if (drag.source === null) return;
      e.stopPropagation();
      drag.over(dropFolder);
      if (canMoveInto(drag.source, dropFolder)) e.preventDefault();
    },
    onDrop: (e: React.DragEvent) => onDrop(e, dropFolder),
  };
  const dropping = node.kind === "folder" && drag.target === node.path;

  const label =
    renaming === node.path ? (
      <RenameInput initial={displayName(node)} onCommit={(name) => onRename(node.path, name)} onCancel={onCancelRename} />
    ) : (
      displayName(node)
    );

  if (node.kind === "folder") {
    return (
      <li role="treeitem" aria-expanded={open} {...dragProps}>
        <button className={"tree-row folder" + (dropping ? " drop-target" : "")} onClick={() => setOpen(!open)} onContextMenu={(e) => onContextMenu(e, node)}>
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
    <li role="treeitem" aria-selected={node.path === activePath} {...dragProps}>
      <button
        className={"tree-row file" + (node.path === activePath ? " active" : "") + (drag.source === node.path ? " dragging" : "")}
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
