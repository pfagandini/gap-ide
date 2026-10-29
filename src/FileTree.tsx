import { useState } from "react";
import type { TreeNode } from "../shared/types";

interface FileTreeProps {
  tree: TreeNode | null;
  activePath: string | null;
  onOpen: (path: string) => void;
  onNewFile: () => void;
  onRefresh: () => void;
}

export function FileTree(props: FileTreeProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="sidebar-title">Files</span>
        <div className="sidebar-actions">
          <button className="icon-button" title="New file" onClick={props.onNewFile}>
            +
          </button>
          <button className="icon-button" title="Refresh" onClick={props.onRefresh}>
            ↻
          </button>
        </div>
      </div>
      <div className="tree">
        {props.tree ? (
          <TreeDir
            node={props.tree}
            depth={0}
            activePath={props.activePath}
            onOpen={props.onOpen}
            defaultOpen
          />
        ) : (
          <div className="muted pad">Loading…</div>
        )}
      </div>
    </aside>
  );
}

function TreeDir({
  node,
  depth,
  activePath,
  onOpen,
  defaultOpen = false
}: {
  node: TreeNode;
  depth: number;
  activePath: string | null;
  onOpen: (path: string) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        className="tree-row dir-row"
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onClick={() => setOpen((value) => !value)}
        title={node.path || "/"}
      >
        <span className="twisty">{open ? "▾" : "▸"}</span>
        <span className="folder-icon">▣</span>
        <span className="tree-name">{node.name}</span>
      </button>
      {open &&
        node.children?.map((child) =>
          child.type === "dir" ? (
            <TreeDir
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              onOpen={onOpen}
            />
          ) : (
            <button
              key={child.path}
              className={`tree-row file-row ${
                activePath === child.path ? "active" : ""
              }`}
              style={{ paddingLeft: `${8 + (depth + 1) * 14 + 14}px` }}
              onClick={() => onOpen(child.path)}
              title={child.path}
            >
              <span
                className={`file-dot ${
                  /\.(g|gi|gd|tst)$/i.test(child.name) ? "gap-file" : ""
                }`}
              />
              <span className="tree-name">{child.name}</span>
            </button>
          )
        )}
    </div>
  );
}
