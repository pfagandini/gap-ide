import { useState } from "react";
import type { TreeNode } from "../shared/types";

interface FileTreeProps {
  tree: TreeNode | null;
  activePath: string | null;
  onOpen: (path: string) => void;
  onNewFile: () => void;
  onRefresh: () => void;
}

const GAP_FILE = /\.(g|gi|gd|tst)$/i;

/** The tree with only GAP files, dropping folders that end up empty. */
function gapOnly(node: TreeNode): TreeNode | null {
  if (node.type === "file") return GAP_FILE.test(node.name) ? node : null;
  const children = (node.children ?? [])
    .map(gapOnly)
    .filter((child): child is TreeNode => child !== null);
  return children.length > 0 || node.path === "" ? { ...node, children } : null;
}

const SHOW_ALL_KEY = "gap-ide-show-all-files";

export function FileTree(props: FileTreeProps) {
  const [showAll, setShowAll] = useState(
    () => localStorage.getItem(SHOW_ALL_KEY) === "1"
  );
  const toggleShowAll = () => {
    setShowAll((value) => {
      localStorage.setItem(SHOW_ALL_KEY, value ? "0" : "1");
      return !value;
    });
  };
  const tree = props.tree && !showAll ? gapOnly(props.tree) : props.tree;
  const empty = !!tree && (tree.children ?? []).length === 0;

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="sidebar-title">Files</span>
        <div className="sidebar-actions">
          <button className="icon-button" title="New file" onClick={props.onNewFile}>
            +
          </button>
          <button
            className={`icon-button tree-filter ${showAll ? "" : "active"}`}
            title={
              showAll
                ? "Showing all files. Click to show only GAP files (.g, .gi, .gd, .tst)"
                : "Showing only GAP files (.g, .gi, .gd, .tst). Click to show all files"
            }
            onClick={toggleShowAll}
          >
            {showAll ? "All" : ".g"}
          </button>
          <button className="icon-button" title="Refresh" onClick={props.onRefresh}>
            ↻
          </button>
        </div>
      </div>
      <div className="tree">
        {tree ? (
          <TreeDir
            node={tree}
            depth={0}
            activePath={props.activePath}
            onOpen={props.onOpen}
            defaultOpen
          />
        ) : (
          <div className="muted pad">Loading…</div>
        )}
        {empty && !showAll && (
          <div className="muted pad">
            No GAP files here yet. Use + to create one, or click <b>.g</b> to show
            all files.
          </div>
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
