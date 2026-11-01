import { useEffect, useRef, useState } from "react";
import type {
  ClientMsg,
  FilePayload,
  Run,
  ServerMsg,
  SessionState,
  TreeNode
} from "../shared/types";
import { FileTree } from "./FileTree";
import { Editor, type Block, type EditorApi, type SelectionInfo } from "./Editor";
import { OutputPanel } from "./OutputPanel";
import { ConsolePanel } from "./ConsolePanel";
import { ExportDialog, type ExportMeta } from "./ExportDialog";
import { LatexDialog } from "./LatexDialog";

interface OpenFile {
  path: string;
  name: string;
  content: string;
  saved: string;
}

type PanelTab = "output" | "console";

const basename = (value: string) => value.split("/").pop() || value;

export default function App() {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [sessionState, setSessionState] = useState<SessionState>("starting");
  const [gapVersion, setGapVersion] = useState("…");
  const [root, setRoot] = useState("…");
  const [panelTab, setPanelTab] = useState<PanelTab>("output");
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [banner, setBanner] = useState<string | null>(null);
  const [exportIds, setExportIds] = useState<string[] | null>(null);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [latex, setLatex] = useState<{ text: string; count: number } | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const editorApi = useRef<EditorApi | null>(null);

  const activeFile =
    openFiles.find((file) => file.path === activePath) ?? null;
  const dirty = activeFile ? activeFile.content !== activeFile.saved : false;
  const sessionBusy = sessionState === "running";
  const sessionReady = sessionState === "idle";

  useEffect(() => {
    void fetchTree();
    fetch("/api/info")
      .then((response) => response.json())
      .then((info) => {
        setRoot(info.root);
        setGapVersion(info.gapVersion);
        setSessionState(info.state);
      })
      .catch((error) => setBanner(String(error)));
  }, []);

  useEffect(() => {
    if (!banner) return;
    const timer = setTimeout(() => setBanner(null), 7000);
    return () => clearTimeout(timer);
  }, [banner]);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${location.host}/ws`);
      wsRef.current = socket;

      socket.onmessage = (event) => {
        let message: ServerMsg;
        try {
          message = JSON.parse(event.data) as ServerMsg;
        } catch {
          return;
        }
        handleServerMessage(message);
      };

      socket.onclose = () => {
        if (closed) return;
        retry = setTimeout(connect, 1200);
      };
    };

    const handleServerMessage = (message: ServerMsg) => {
      if (message.type === "hello") {
        setRoot(message.root);
        setGapVersion(message.gapVersion);
        setSessionState(message.state);
        setRuns(message.runs);
      } else if (message.type === "run_started") {
        setRuns((previous) =>
          previous.some((run) => run.id === message.run.id)
            ? previous
            : [...previous, message.run]
        );
        if (message.run.kind === "file") setPanelTab("output");
        else if (!message.run.sourcePath) setPanelTab("console");
        setBusyLabel(message.run.label);
      } else if (message.type === "run_output") {
        setRuns((previous) =>
          previous.map((run) =>
            run.id === message.runId
              ? {
                  ...run,
                  [message.stream]: run[message.stream] + message.text
                }
              : run
          )
        );
      } else if (message.type === "run_finished") {
        setRuns((previous) =>
          previous.map((run) =>
            run.id === message.runId
              ? {
                  ...run,
                  status: message.status,
                  endedAt: message.endedAt,
                  durationMs: message.durationMs
                }
              : run
          )
        );
        setBusyLabel(null);
      } else if (message.type === "runs_cleared") {
        setRuns((previous) =>
          previous.filter((run) => run.kind !== message.kind || run.status === "running")
        );
      } else if (message.type === "session_state") {
        setSessionState(message.state);
        if (message.state !== "running") setBusyLabel(null);
        if (message.state === "failed" && message.message) {
          setBanner(message.message);
        }
      } else if (message.type === "error") {
        setBanner(message.message);
      }
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      wsRef.current?.close();
    };
  }, []);

  const send = (message: ClientMsg) => {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setBanner("Not connected to the GAP IDE server.");
      return false;
    }
    socket.send(JSON.stringify(message));
    return true;
  };

  const fetchTree = async () => {
    try {
      const response = await fetch("/api/tree");
      if (!response.ok) throw new Error(await errorText(response));
      setTree((await response.json()) as TreeNode);
    } catch (error) {
      setBanner(messageOf(error));
    }
  };

  const openFile = async (path: string) => {
    const existing = openFiles.find((file) => file.path === path);
    if (existing) {
      setActivePath(path);
      return;
    }
    try {
      const response = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
      if (!response.ok) throw new Error(await errorText(response));
      const payload = (await response.json()) as FilePayload;
      setOpenFiles((previous) => [
        ...previous,
        {
          path,
          name: basename(path),
          content: payload.content,
          saved: payload.content
        }
      ]);
      setActivePath(path);
    } catch (error) {
      setBanner(messageOf(error));
    }
  };

  const saveActive = async (): Promise<boolean> => {
    if (!activeFile) return false;
    try {
      const response = await fetch("/api/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: activeFile.path,
          content: activeFile.content
        })
      });
      if (!response.ok) throw new Error(await errorText(response));
      const content = activeFile.content;
      setOpenFiles((previous) =>
        previous.map((file) =>
          file.path === activeFile.path ? { ...file, saved: content } : file
        )
      );
      return true;
    } catch (error) {
      setBanner(messageOf(error));
      return false;
    }
  };

  const runFile = async () => {
    if (!activeFile) {
      setBanner("Open a .g file first.");
      return;
    }
    if (!sessionReady) {
      setBanner(
        sessionBusy
          ? "GAP is still running. Press Stop or wait for it to finish."
          : "The GAP session is not ready. Press Restart."
      );
      return;
    }
    if (!(await saveActive())) return;
    setPanelTab("output");
    send({ type: "run_file", path: activeFile.path });
  };

  const runSelection = () => {
    if (!activeFile) {
      setBanner("Open a .g file first.");
      return;
    }
    if (!selection || selection.text.trim().length === 0) {
      setBanner("Put the cursor on a line or select some code.");
      return;
    }
    if (!sessionReady) {
      setBanner(
        sessionBusy
          ? "GAP is still running. Press Stop or wait for it to finish."
          : "The GAP session is not ready. Press Restart."
      );
      return;
    }
    const label = selection.isSelection
      ? `Selection ${activeFile.name}:${selection.startLine}`
      : `Line ${activeFile.name}:${selection.startLine}`;
    send({
      type: "eval",
      code: selection.text,
      label,
      sourcePath: activeFile.path,
      startLine: selection.startLine
    });
  };

  const notReady = () => {
    if (sessionReady) return false;
    setBanner(
      sessionBusy
        ? "GAP is still running. Press Stop or wait for it to finish."
        : "The GAP session is not ready. Press Restart."
    );
    return true;
  };

  // Shift+Enter: run one cell; its output appears under it in the editor.
  const runBlock = (block: Block): boolean => {
    if (!activeFile || notReady()) return false;
    return send({
      type: "eval",
      code: block.code,
      label: `Cell ${activeFile.name}:${block.startLine}`,
      sourcePath: activeFile.path,
      startLine: block.startLine
    });
  };

  const runAllBlocks = (blocks?: Block[]) => {
    if (!activeFile || notReady()) return;
    const list = blocks ?? editorApi.current?.blocks() ?? [];
    if (list.length === 0) {
      setBanner("This file has no code to run.");
      return;
    }
    send({
      type: "eval_blocks",
      sourcePath: activeFile.path,
      blocks: list.map((block) => ({
        ...block,
        label: `Cell ${activeFile.name}:${block.startLine}`
      }))
    });
  };

  const exportLatex = async () => {
    const ids = editorApi.current?.shownRunIds() ?? [];
    if (!activeFile || ids.length === 0) {
      setBanner(
        "Run the cells first (Shift+Enter, or Run all cells); the export uses the outputs shown in the editor."
      );
      return;
    }
    try {
      const response = await fetch("/api/export/latex", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runIds: ids })
      });
      if (!response.ok) throw new Error(await errorText(response));
      const { text } = (await response.json()) as { text: string };
      setLatex({ text, count: ids.length });
    } catch (error) {
      setBanner(messageOf(error));
    }
  };

  const clearPanel = () => {
    send({ type: "clear_runs", kind: panelTab === "output" ? "file" : "console" });
  };

  const evaluateInConsole = (code: string) => {
    if (!sessionReady) {
      setBanner(
        sessionBusy
          ? "GAP is still running."
          : "The GAP session is not ready. Press Restart."
      );
      return;
    }
    setPanelTab("console");
    send({ type: "eval", code, label: "Console" });
  };

  const closeFile = (path: string) => {
    const file = openFiles.find((item) => item.path === path);
    if (file && file.content !== file.saved) {
      if (!window.confirm(`Discard unsaved changes in ${file.name}?`)) return;
    }
    const remaining = openFiles.filter((item) => item.path !== path);
    setOpenFiles(remaining);
    if (activePath === path) {
      setActivePath(remaining.length > 0 ? remaining[remaining.length - 1].path : null);
    }
  };

  const createFile = async () => {
    const path = window.prompt("New file (relative to project root):", "new.g");
    if (!path) return;
    try {
      const response = await fetch("/api/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path })
      });
      if (!response.ok) throw new Error(await errorText(response));
      await fetchTree();
      await openFile(path);
    } catch (error) {
      setBanner(messageOf(error));
    }
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const completedRuns = runs.filter((run) => run.status !== "running");
  const chooseExportIds = () => {
    const selected = [...selectedIds].filter((id) =>
      completedRuns.some((run) => run.id === id)
    );
    if (selected.length > 0) return selected;
    return completedRuns.map((run) => run.id);
  };

  const openExport = () => {
    const ids = chooseExportIds();
    if (ids.length === 0) {
      setBanner("Run something first; there is nothing to export.");
      return;
    }
    setExportIds(ids);
  };

  const exportPdf = async (meta: ExportMeta) => {
    if (!exportIds) return;
    const response = await fetch("/api/export/pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runIds: exportIds, ...meta })
    });
    if (!response.ok) throw new Error(await errorText(response));
    const blob = await response.blob();
    downloadBlob(blob, `gap-report-${stamp()}.pdf`);
  };

  const exportGFile = () => {
    if (!activeFile) {
      setBanner("Open a .g file first.");
      return;
    }
    const name = /\.(g|gi|gd|tst)$/i.test(activeFile.name)
      ? activeFile.name
      : `${activeFile.name}.g`;
    downloadBlob(
      new Blob([activeFile.content], { type: "text/plain;charset=utf-8" }),
      name
    );
  };

  const restart = () => {
    setSelectedIds(new Set());
    send({ type: "restart" });
  };

  const statusLabel = busyLabel ?? sessionState;

  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand">
          <span className="brand-mark">GAP</span>
          <span className="brand-sub">IDE</span>
        </div>
        <div className="root-label" title={root}>
          {root === "…" ? "Loading project…" : root}
        </div>

        <div className="toolbar-group">
          <button
            className="button"
            onClick={() => void saveActive()}
            disabled={!activeFile || !dirty}
            title="Save (Ctrl+S)"
          >
            Save
          </button>
          <button
            className="button primary"
            onClick={() => void runFile()}
            disabled={!activeFile || !sessionReady}
            title="Run file (F5)"
          >
            ▶ Run file
          </button>
          <button
            className="button"
            onClick={runSelection}
            disabled={!activeFile || !sessionReady}
            title="Evaluate selection or current line (Ctrl+Enter)"
          >
            ⚡ Run selection
          </button>
          <button
            className="button"
            onClick={() => runAllBlocks()}
            disabled={!activeFile || !sessionReady}
            title="Run every cell (blocks separated by blank lines) and show each output under it (Ctrl+Shift+Enter). Shift+Enter runs one cell."
          >
            ▶▶ Run all cells
          </button>
          <button
            className="button danger"
            onClick={() => send({ type: "interrupt" })}
            disabled={!sessionBusy}
            title="Interrupt GAP (SIGINT)"
          >
            ⏹ Stop
          </button>
          <button
            className="button"
            onClick={restart}
            disabled={sessionBusy}
            title="Restart the GAP session"
          >
            ↻ Restart
          </button>
        </div>

        <div className="toolbar-spacer" />

        <div className="toolbar-group">
          <button
            className="button"
            onClick={openExport}
            disabled={completedRuns.length === 0}
            title="Export selected runs (or all completed runs) as a PDF"
          >
            Export PDF
            {selectedIds.size > 0 ? ` (${selectedIds.size})` : ""}
          </button>
          <button
            className="button"
            onClick={exportGFile}
            disabled={!activeFile}
            title="Download the current editor buffer as a .g file"
          >
            Export .g
          </button>
          <button
            className="button"
            onClick={() => void exportLatex()}
            disabled={!activeFile}
            title="Copy the cells and their outputs as a LaTeX verbatim GAP session"
          >
            Export LaTeX
          </button>
        </div>
      </header>

      {banner && (
        <div className="banner" role="alert">
          <span>{banner}</span>
          <button className="banner-close" onClick={() => setBanner(null)}>
            ×
          </button>
        </div>
      )}

      <div className="workbench">
        <FileTree
          tree={tree}
          activePath={activePath}
          onOpen={(path) => void openFile(path)}
          onNewFile={() => void createFile()}
          onRefresh={() => void fetchTree()}
        />

        <main className="editor-area">
          <div className="tabs">
            {openFiles.map((file) => (
              <button
                key={file.path}
                className={`tab ${file.path === activePath ? "active" : ""}`}
                onClick={() => setActivePath(file.path)}
                title={file.path}
              >
                <span className="tab-name">{file.name}</span>
                {file.content !== file.saved && <span className="dirty-dot" />}
                <span
                  className="tab-close"
                  role="button"
                  tabIndex={0}
                  onClick={(event) => {
                    event.stopPropagation();
                    closeFile(file.path);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") closeFile(file.path);
                  }}
                >
                  ×
                </span>
              </button>
            ))}
          </div>
          <div className="editor-wrap">
            {activeFile ? (
              <Editor
                key={activeFile.path}
                fileKey={activeFile.path}
                value={activeFile.content}
                inlineRuns={runs.filter(
                  (run) => run.kind === "console" && run.sourcePath === activeFile.path
                )}
                onRunBlock={runBlock}
                onRunAllBlocks={(blocks) => runAllBlocks(blocks)}
                apiRef={editorApi}
                onChange={(content) =>
                  setOpenFiles((previous) =>
                    previous.map((file) =>
                      file.path === activeFile.path ? { ...file, content } : file
                    )
                  )
                }
                onCursor={(line, column) => setCursor({ line, column })}
                onSelection={setSelection}
                onRunFile={() => void runFile()}
                onRunSelection={runSelection}
                onSave={() => void saveActive()}
              />
            ) : (
              <div className="welcome">
                <div className="welcome-mark">GAP</div>
                <h1>Small IDE for GAP</h1>
                <p>
                  Open a <code>.g</code> file from the tree. Press <kbd>F5</kbd>{" "}
                  to run the whole file, <kbd>Shift</kbd>+<kbd>Enter</kbd> to run
                  the cell under the cursor (lines between blank lines) with its
                  output shown right below it, or <kbd>Ctrl</kbd>+<kbd>Enter</kbd>{" "}
                  for the current line or selection.
                </p>
                <p className="muted">
                  Run output is collected on the right. Select runs with the
                  checkboxes and export them as a PDF, or download the current
                  buffer as a <code>.g</code> file.
                </p>
              </div>
            )}
          </div>
        </main>

        <aside className="right-panel">
          <div className="panel-tabs">
            <button
              className={panelTab === "output" ? "active" : ""}
              onClick={() => setPanelTab("output")}
            >
              Output
            </button>
            <button
              className={panelTab === "console" ? "active" : ""}
              onClick={() => setPanelTab("console")}
            >
              Console
            </button>
            <div className="panel-state">
              <span className={`state-dot state-${sessionState}`} />
              {sessionState}
            </div>
            <button
              className="panel-clear"
              onClick={clearPanel}
              disabled={
                !runs.some(
                  (run) =>
                    run.kind === (panelTab === "output" ? "file" : "console") &&
                    run.status !== "running"
                )
              }
              title={
                panelTab === "output"
                  ? "Clear file-run output"
                  : "Clear the console (and the outputs shown in the editor)"
              }
            >
              Clear
            </button>
          </div>
          <div className="panel-body">
            {panelTab === "output" ? (
              <OutputPanel
                runs={runs}
                selectedIds={selectedIds}
                onToggle={toggleSelected}
              />
            ) : (
              <ConsolePanel
                runs={runs}
                selectedIds={selectedIds}
                onToggle={toggleSelected}
                onEval={evaluateInConsole}
                sessionState={sessionState}
              />
            )}
          </div>
        </aside>
      </div>

      <footer className="statusbar">
        <span>GAP {gapVersion}</span>
        <span className={`status-state state-${sessionState}`}>
          {statusLabel}
        </span>
        <span>{root}</span>
        <span className="status-spacer" />
        {activeFile && (
          <>
            <span>{activeFile.path}</span>
            <span>
              Ln {cursor.line}, Col {cursor.column}
            </span>
            <span>{dirty ? "modified" : "saved"}</span>
          </>
        )}
      </footer>

      {latex && (
        <LatexDialog text={latex.text} count={latex.count} onClose={() => setLatex(null)} />
      )}

      {exportIds && (
        <ExportDialog
          count={exportIds.length}
          onClose={() => setExportIds(null)}
          onExport={exportPdf}
        />
      )}
    </div>
  );
}

async function errorText(response: Response) {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error || response.statusText;
  } catch {
    return response.statusText;
  }
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
