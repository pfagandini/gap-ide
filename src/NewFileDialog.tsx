import { FormEvent, useState } from "react";

interface NewFileDialogProps {
  onClose: () => void;
  onCreate: (path: string) => Promise<void>;
}

/** Asks for a new file name (window.prompt does not exist in Electron). */
export function NewFileDialog({ onClose, onCreate }: NewFileDialogProps) {
  const [path, setPath] = useState("new.g");
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!path.trim()) return;
    setWorking(true);
    setError(null);
    try {
      await onCreate(path.trim());
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setWorking(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => void submit(event)}
      >
        <div className="modal-head">
          <div className="modal-title">New file</div>
          <button type="button" className="icon-button" onClick={onClose} title="Close">
            ×
          </button>
        </div>
        <label className="field">
          <span>Name (folders allowed, e.g. ficha2/q1.g)</span>
          <input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            onFocus={(event) => {
              const dot = event.currentTarget.value.lastIndexOf(".");
              event.currentTarget.setSelectionRange(0, dot > 0 ? dot : event.currentTarget.value.length);
            }}
            onKeyDown={(event) => event.key === "Escape" && onClose()}
            autoFocus
            spellCheck={false}
          />
        </label>
        {error && <div className="inline-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="button subtle" onClick={onClose} disabled={working}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={working}>
            Create
          </button>
        </div>
      </form>
    </div>
  );
}
