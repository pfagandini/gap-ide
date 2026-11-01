import { useEffect, useRef, useState } from "react";
import { basicSetup } from "codemirror";
import {
  EditorSelection,
  EditorState,
  Prec,
  StateEffect,
  StateField,
  type Text
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
  keymap
} from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import type { Run } from "../shared/types";
import { gapLanguage } from "./gapLanguage";

export interface SelectionInfo {
  text: string;
  startLine: number;
  isSelection: boolean;
}

/** A "cell": a run of non-blank lines, separated from the next by blank lines. */
export interface Block {
  code: string;
  startLine: number;
}

export interface EditorApi {
  /** The file's blocks ("Run all cells"). */
  blocks: () => Block[];
  /** Ids of the runs whose output is shown inline, top to bottom. */
  shownRunIds: () => string[];
}

interface EditorProps {
  fileKey: string;
  value: string;
  /** Runs started from this file's editor; shown under the code they ran. */
  inlineRuns: Run[];
  onChange: (value: string) => void;
  onCursor: (line: number, column: number) => void;
  onSelection: (selection: SelectionInfo) => void;
  onRunFile: () => void;
  onRunSelection: () => void;
  onRunBlock: (block: Block) => boolean;
  onRunAllBlocks: (blocks: Block[]) => void;
  onSave: () => void;
  /** Lets the parent query the editor (toolbar buttons). */
  apiRef?: React.MutableRefObject<EditorApi | null>;
}

const isBlank = (doc: Text, line: number) => doc.line(line).text.trim().length === 0;

/** The block containing `line`, or the next one below it if `line` is blank. */
function blockAt(doc: Text, line: number): { from: number; to: number } | null {
  let start = line;
  while (start <= doc.lines && isBlank(doc, start)) start++;
  if (start > doc.lines) return null;
  while (start > 1 && !isBlank(doc, start - 1)) start--;
  let end = start;
  while (end < doc.lines && !isBlank(doc, end + 1)) end++;
  return { from: start, to: end };
}

function blockText(doc: Text, from: number, to: number): string {
  return doc.sliceString(doc.line(from).from, doc.line(to).to);
}

export function allBlocks(doc: Text): Block[] {
  const blocks: Block[] = [];
  let line = 1;
  while (line <= doc.lines) {
    const block = blockAt(doc, line);
    if (!block) break;
    blocks.push({ code: blockText(doc, block.from, block.to), startLine: block.from });
    line = block.to + 1;
  }
  return blocks;
}

/** Last line a run covers (selection text may end with a newline). */
function runEndLine(run: Run): number {
  const lines = run.code.replace(/\r?\n$/, "").split(/\r?\n/).length;
  return (run.startLine ?? 1) + lines - 1;
}

// ---- Inline output widgets -------------------------------------------------

interface InlineItem {
  run: Run;
  pos: number; // end of the run's last line; mapped through edits
}

class OutputWidget extends WidgetType {
  constructor(
    readonly run: Run,
    readonly onDismiss: (id: string) => void
  ) {
    super();
  }

  eq(other: OutputWidget) {
    return (
      other.run.id === this.run.id &&
      other.run.stdout === this.run.stdout &&
      other.run.stderr === this.run.stderr &&
      other.run.status === this.run.status
    );
  }

  toDOM() {
    const run = this.run;
    // CodeMirror measures block widgets by their box, so spacing must be
    // padding on this wrapper, not margins (margins misalign the gutter).
    const wrap = document.createElement("div");
    wrap.className = "inline-wrap";
    const box = document.createElement("div");
    box.className = `inline-output status-${run.status}`;
    wrap.appendChild(box);

    const head = document.createElement("div");
    head.className = "inline-head";
    const status = document.createElement("span");
    status.className = `status-chip status-${run.status}`;
    status.textContent = run.status;
    head.appendChild(status);
    if (run.durationMs !== undefined) {
      const time = document.createElement("span");
      time.className = "run-time";
      time.textContent = `${(run.durationMs / 1000).toFixed(2)} s`;
      head.appendChild(time);
    }
    const close = document.createElement("button");
    close.className = "inline-close";
    close.textContent = "×";
    close.title = "Hide this output";
    close.addEventListener("mousedown", (event) => event.preventDefault());
    close.addEventListener("click", () => this.onDismiss(run.id));
    head.appendChild(close);
    box.appendChild(head);

    const addPre = (text: string, className: string) => {
      const pre = document.createElement("pre");
      pre.className = className;
      pre.textContent = text.replace(/\n+$/, "");
      box.appendChild(pre);
    };
    if (run.stdout.trim()) addPre(run.stdout, "inline-text");
    if (run.stderr.trim()) addPre(run.stderr, "inline-text inline-stderr");
    if (!run.stdout.trim() && !run.stderr.trim()) {
      const empty = document.createElement("div");
      empty.className = "muted inline-empty";
      empty.textContent = run.status === "running" ? "Running…" : "(no output)";
      box.appendChild(empty);
    }
    return wrap;
  }

  ignoreEvent() {
    return true;
  }
}

const setInline = StateEffect.define<{ items: InlineItem[]; onDismiss: (id: string) => void }>();

interface InlineState {
  items: InlineItem[];
  onDismiss: (id: string) => void;
  deco: DecorationSet;
}

function buildDecorations(items: InlineItem[], onDismiss: (id: string) => void) {
  const sorted = [...items].sort((a, b) => a.pos - b.pos);
  return Decoration.set(
    sorted.map((item) =>
      Decoration.widget({
        widget: new OutputWidget(item.run, onDismiss),
        block: true,
        side: 1
      }).range(item.pos)
    )
  );
}

const inlineField = StateField.define<InlineState>({
  create: () => ({ items: [], onDismiss: () => {}, deco: Decoration.none }),
  update(value, tr) {
    let { items, onDismiss } = value;
    let changed = false;
    if (tr.docChanged) {
      items = items.map((item) => ({ ...item, pos: tr.changes.mapPos(item.pos, 1) }));
      changed = true;
    }
    for (const effect of tr.effects) {
      if (effect.is(setInline)) {
        items = effect.value.items;
        onDismiss = effect.value.onDismiss;
        changed = true;
      }
    }
    if (!changed) return value;
    if (tr.docChanged && !tr.effects.some((e) => e.is(setInline))) {
      return { items, onDismiss, deco: value.deco.map(tr.changes) };
    }
    return { items, onDismiss, deco: buildDecorations(items, onDismiss) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.deco)
});

// ---- Editor component --------------------------------------------------------

export function Editor(props: EditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  const dismissed = useRef<Set<string>>(new Set());
  // Runs already given a position. A placed run missing from the field was
  // replaced by a newer run on its line and must not come back.
  const placed = useRef<Set<string>>(new Set());
  const [, forceRender] = useForceRender();

  useEffect(() => {
    if (!host.current) return;

    const selectionInfo = (view: EditorView): SelectionInfo => {
      const state = view.state;
      const selection = state.selection.main;
      const selected = state.sliceDoc(selection.from, selection.to);
      const line = state.doc.lineAt(selection.from);
      return {
        text: selected.length > 0 ? selected : line.text,
        startLine: line.number,
        isSelection: selected.length > 0
      };
    };

    const runBlockAtCursor = (view: EditorView) => {
      const doc = view.state.doc;
      const line = doc.lineAt(view.state.selection.main.head).number;
      const block = blockAt(doc, line);
      if (!block) return true;
      const started = callbacks.current.onRunBlock({
        code: blockText(doc, block.from, block.to),
        startLine: block.from
      });
      if (!started) return true;
      // Like Jupyter: move to the start of the next block (or the end).
      const next = block.to < doc.lines ? blockAt(doc, block.to + 1) : null;
      const target = next ? doc.line(next.from).from : doc.line(block.to).to;
      view.dispatch({
        selection: EditorSelection.cursor(target),
        scrollIntoView: true
      });
      return true;
    };

    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          basicSetup,
          gapLanguage,
          oneDark,
          EditorView.lineWrapping,
          inlineField,
          EditorView.theme({
            "&": { height: "100%" },
            ".cm-scroller": {
              overflow: "auto",
              fontFamily:
                '"DejaVu Sans Mono", "Noto Sans Mono", ui-monospace, monospace',
              fontSize: "13px",
              lineHeight: "1.55"
            },
            ".cm-content": { paddingBottom: "40px" }
          }),
          Prec.highest(
            keymap.of([
              {
                key: "F5",
                run: () => {
                  callbacks.current.onRunFile();
                  return true;
                }
              },
              {
                key: "Shift-Enter",
                run: runBlockAtCursor
              },
              {
                key: "Mod-Shift-Enter",
                run: (v) => {
                  callbacks.current.onRunAllBlocks(allBlocks(v.state.doc));
                  return true;
                }
              },
              {
                key: "Mod-Enter",
                run: () => {
                  callbacks.current.onRunSelection();
                  return true;
                }
              },
              {
                key: "Mod-s",
                run: () => {
                  callbacks.current.onSave();
                  return true;
                }
              }
            ])
          ),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              callbacks.current.onChange(update.state.doc.toString());
            }
            if (update.selectionSet || update.docChanged) {
              const head = update.state.selection.main.head;
              const line = update.state.doc.lineAt(head);
              callbacks.current.onCursor(line.number, head - line.from + 1);
              callbacks.current.onSelection(selectionInfo(update.view));
            }
          })
        ]
      })
    });
    viewRef.current = view;
    if (props.apiRef) {
      props.apiRef.current = {
        blocks: () => allBlocks(view.state.doc),
        shownRunIds: () =>
          [...view.state.field(inlineField).items]
            .sort((a, b) => a.pos - b.pos)
            .map((item) => item.run.id)
      };
    }

    view.focus();
    callbacks.current.onSelection(selectionInfo(view));

    return () => {
      viewRef.current = null;
      if (props.apiRef) props.apiRef.current = null;
      view.destroy();
    };
    // The editor is intentionally remounted when the open file changes; `value`
    // is the initial document, not a controlled prop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.fileKey]);

  // Place each run's output under the code it ran. Positions already known are
  // kept (they follow edits); new runs are placed at their last line. On any
  // line only the newest output is shown, so re-running a cell replaces it.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const doc = view.state.doc;
    const known = new Map(
      view.state.field(inlineField).items.map((item) => [item.run.id, item.pos])
    );
    const newestByLine = new Map<number, InlineItem>();
    const ordered = [...props.inlineRuns].sort((a, b) => a.startedAt - b.startedAt);
    for (const run of ordered) {
      if (dismissed.current.has(run.id)) continue;
      let pos = known.get(run.id);
      if (pos === undefined) {
        if (placed.current.has(run.id)) continue;
        placed.current.add(run.id);
        pos = doc.line(Math.min(Math.max(runEndLine(run), 1), doc.lines)).to;
      }
      pos = Math.min(pos, doc.length);
      newestByLine.set(doc.lineAt(pos).number, { run, pos });
    }
    const onDismiss = (id: string) => {
      dismissed.current.add(id);
      forceRender();
    };
    view.dispatch({ effects: setInline.of({ items: [...newestByLine.values()], onDismiss }) });
  });

  return <div className="editor-host" ref={host} />;
}

function useForceRender(): [number, () => void] {
  const [tick, setTick] = useState(0);
  return [tick, () => setTick((value) => value + 1)];
}
