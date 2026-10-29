import { useEffect, useState } from "react";

export interface ExportMeta {
  title: string;
  author: string;
  course: string;
}

interface ExportDialogProps {
  count: number;
  onClose: () => void;
  onExport: (meta: ExportMeta) => Promise<void>;
}

export function ExportDialog({ count, onClose, onExport }: ExportDialogProps) {
  const [title, setTitle] = useState("GAP Assignment");
  const [author, setAuthor] = useState("");
  const [course, setCourse] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const stored = localStorage.getItem("gap-ide-export-meta");
      if (!stored) return;
      const parsed = JSON.parse(stored) as Partial<ExportMeta>;
      if (parsed.title) setTitle(parsed.title);
      if (parsed.author) setAuthor(parsed.author);
      if (parsed.course) setCourse(parsed.course);
    } catch {
      // Ignore malformed local preferences.
    }
  }, []);

  const submit = async () => {
    setWorking(true);
    setError(null);
    try {
      await onExport({ title, author, course });
      try {
        localStorage.setItem(
          "gap-ide-export-meta",
          JSON.stringify({ title, author, course })
        );
      } catch {
        // Downloading the PDF is more important than remembering the header.
      }
      setWorking(false);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setWorking(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-title">Export PDF</div>
            <div className="muted">{count} run{count === 1 ? "" : "s"} selected</div>
          </div>
          <button className="icon-button" onClick={onClose} title="Close">
            ×
          </button>
        </div>
        <label className="field">
          <span>Title</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            autoFocus
          />
        </label>
        <div className="field-row">
          <label className="field">
            <span>Author</span>
            <input
              value={author}
              onChange={(event) => setAuthor(event.target.value)}
              placeholder="Your name"
            />
          </label>
          <label className="field">
            <span>Course</span>
            <input
              value={course}
              onChange={(event) => setCourse(event.target.value)}
              placeholder="Optional"
            />
          </label>
        </div>
        <p className="muted export-note">
          The PDF contains the source code that was executed and its output,
          together with the GAP version and timestamps.
        </p>
        {error && <div className="inline-error">{error}</div>}
        <div className="modal-actions">
          <button className="button subtle" onClick={onClose} disabled={working}>
            Cancel
          </button>
          <button className="button primary" onClick={submit} disabled={working}>
            {working ? "Generating…" : "Download PDF"}
          </button>
        </div>
      </div>
    </div>
  );
}
