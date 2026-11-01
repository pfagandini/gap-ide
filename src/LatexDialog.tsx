import { useState } from "react";

interface LatexDialogProps {
  text: string;
  count: number;
  onClose: () => void;
}

/** Shows the LaTeX verbatim transcript, ready to copy into an assignment. */
export function LatexDialog({ text, count, onClose }: LatexDialogProps) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (caught) {
      setError(
        `Could not copy (${caught instanceof Error ? caught.message : String(caught)}). ` +
          "Select the text and press Ctrl+C."
      );
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal modal-wide" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-title">Export as LaTeX verbatim</div>
            <div className="muted">
              {count} cell{count === 1 ? "" : "s"}, in file order, as a GAP session
            </div>
          </div>
          <button className="icon-button" onClick={onClose} title="Close">
            ×
          </button>
        </div>
        <textarea
          className="latex-text"
          readOnly
          value={text}
          onFocus={(event) => event.currentTarget.select()}
          spellCheck={false}
        />
        {error && <div className="inline-error">{error}</div>}
        <div className="modal-actions">
          <button className="button subtle" onClick={onClose}>
            Close
          </button>
          <button className="button primary" onClick={() => void copy()} autoFocus>
            {copied ? "Copied ✓" : "Copy to clipboard"}
          </button>
        </div>
      </div>
    </div>
  );
}
