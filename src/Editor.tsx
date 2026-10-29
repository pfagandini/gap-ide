import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import { gapLanguage } from "./gapLanguage";

export interface SelectionInfo {
  text: string;
  startLine: number;
  isSelection: boolean;
}

interface EditorProps {
  fileKey: string;
  value: string;
  onChange: (value: string) => void;
  onCursor: (line: number, column: number) => void;
  onSelection: (selection: SelectionInfo) => void;
  onRunFile: () => void;
  onRunSelection: () => void;
  onSave: () => void;
}

export function Editor(props: EditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;

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

    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          basicSetup,
          gapLanguage,
          oneDark,
          EditorView.lineWrapping,
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

    view.focus();
    callbacks.current.onSelection(selectionInfo(view));

    return () => view.destroy();
    // The editor is intentionally remounted when the open file changes; `value`
    // is the initial document, not a controlled prop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.fileKey]);

  return <div className="editor-host" ref={host} />;
}
