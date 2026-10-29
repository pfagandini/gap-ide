import { FormEvent, useEffect, useRef, useState } from "react";
import type { Run, SessionState } from "../shared/types";
import { RunBlock } from "./RunBlock";

interface ConsolePanelProps {
  runs: Run[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onEval: (code: string) => void;
  sessionState: SessionState;
}

export function ConsolePanel({
  runs,
  selectedIds,
  onToggle,
  onEval,
  sessionState
}: ConsolePanelProps) {
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const consoleRuns = runs.filter((run) => run.kind === "console");

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [runs]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const code = input;
    if (code.trim().length === 0) return;
    setHistory((items) => [...items, code]);
    setHistoryIndex(-1);
    setInput("");
    onEval(code);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowUp" && history.length > 0) {
      event.preventDefault();
      const next =
        historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(next);
      setInput(history[next]);
    } else if (event.key === "ArrowDown" && historyIndex !== -1) {
      event.preventDefault();
      const next = historyIndex + 1;
      if (next >= history.length) {
        setHistoryIndex(-1);
        setInput("");
      } else {
        setHistoryIndex(next);
        setInput(history[next]);
      }
    }
  };

  const disabled = sessionState !== "idle";

  return (
    <div className="console-panel">
      <div className="panel-scroll console-scroll" ref={scrollRef}>
        {consoleRuns.length === 0 ? (
          <div className="empty-state">
            <div className="empty-title">GAP console</div>
            <div className="muted">
              Evaluate a selection with <kbd>Ctrl</kbd>+<kbd>Enter</kbd>, or type
              below. The session is shared with file runs.
            </div>
          </div>
        ) : (
          consoleRuns.map((run) => (
            <RunBlock
              key={run.id}
              run={run}
              selected={selectedIds.has(run.id)}
              onToggle={onToggle}
              showCode
            />
          ))
        )}
      </div>
      <form className="console-input-row" onSubmit={submit}>
        <span className="console-caret">gap&gt;</span>
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            sessionState === "running"
              ? "GAP is running… press Stop to interrupt"
              : sessionState === "idle"
                ? "Type GAP code and press Enter"
                : `Session ${sessionState} — press Restart`
          }
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
        />
        <button
          className="icon-button"
          type="submit"
          disabled={disabled || input.trim().length === 0}
          title="Evaluate"
        >
          ↵
        </button>
      </form>
    </div>
  );
}
