import type { Run } from "../shared/types";

interface RunBlockProps {
  run: Run;
  selected: boolean;
  onToggle: (id: string) => void;
  showCode?: boolean;
}

export function RunBlock({ run, selected, onToggle, showCode }: RunBlockProps) {
  const statusClass = `status-${run.status}`;
  const hasOutput = run.stdout.length > 0 || run.stderr.length > 0;
  return (
    <section className={`run-block ${statusClass}`}>
      <header className="run-head">
        <input
          type="checkbox"
          checked={selected && run.status !== "running"}
          disabled={run.status === "running"}
          onChange={() => onToggle(run.id)}
          title={
            run.status === "running"
              ? "Wait for the run to finish before exporting it"
              : "Include this run in the PDF export"
          }
          aria-label={`Select ${run.label}`}
        />
        <div className="run-title">
          <span className="run-label">{run.label}</span>
          <span className={`status-chip ${statusClass}`}>{run.status}</span>
          {run.durationMs !== undefined && (
            <span className="run-time">{(run.durationMs / 1000).toFixed(2)} s</span>
          )}
        </div>
      </header>
      {showCode && run.code.trim().length > 0 && (
        <pre className="run-code">
          <span className="console-prompt">gap&gt; </span>
          {run.code}
        </pre>
      )}
      {run.stdout.length > 0 && <pre className="run-output">{run.stdout}</pre>}
      {run.stderr.length > 0 && (
        <pre className="run-output run-stderr">{run.stderr}</pre>
      )}
      {!hasOutput && run.status === "running" && (
        <div className="muted run-placeholder">Running…</div>
      )}
      {!hasOutput && run.status !== "running" && (
        <div className="muted run-placeholder">(no output)</div>
      )}
    </section>
  );
}
