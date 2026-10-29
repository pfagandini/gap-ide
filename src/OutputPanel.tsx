import { useEffect, useRef } from "react";
import type { Run } from "../shared/types";
import { RunBlock } from "./RunBlock";

interface OutputPanelProps {
  runs: Run[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
}

export function OutputPanel({ runs, selectedIds, onToggle }: OutputPanelProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileRuns = runs.filter((run) => run.kind === "file");

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [runs]);

  return (
    <div className="panel-scroll" ref={scrollRef}>
      {fileRuns.length === 0 ? (
        <div className="empty-state">
          <div className="empty-title">No file runs yet</div>
          <div className="muted">
            Open a <code>.g</code> file and press <kbd>F5</kbd>.
          </div>
        </div>
      ) : (
        fileRuns.map((run) => (
          <RunBlock
            key={run.id}
            run={run}
            selected={selectedIds.has(run.id)}
            onToggle={onToggle}
          />
        ))
      )}
    </div>
  );
}
