# GAP IDE — implementation plan

A small, local IDE for GAP: edit `.g` files in a real editor, run whole files or
selections in a persistent GAP session, and read the output in a side panel.
PDF documentation is a later addition.

The target is a tool that starts in a second or two, stays well under the
footprint of an Electron IDE, and remains hackable. No Electron, no notebook
format, no language server in v1.

**Prototype status:** a working implementation of the MVP lives in this
repository: file tree and tabs, GAP highlighting, F5 file runs, Ctrl+Enter
selection evaluation, shared console, Stop/Restart, PDF report export with code
and output snapshots, and `.g` download. See [`README.md`](./README.md) for how
to run it. Autocomplete, error squiggles, and the documentation pane remain
future work.

---

## 1. Decisions at a glance

| Question | Recommendation |
|---|---|
| Form factor | Local web app: Node backend + React/CodeMirror frontend, opened at `127.0.0.1` |
| Editor | CodeMirror 6 with a custom GAP tokenizer |
| GAP integration | One persistent `gap` subprocess per project, driven through GAP's `-p` protocol |
| Run file | `Read("absolute/path/file.g")` in the persistent session |
| Run selection / line | Send the code to the same session's stdin, so it behaves like the REPL (echoes values) |
| Output | Two panels: **Output** for file runs, **Console** for interactive/selection runs |
| Session lifetime | Persistent; explicit Restart button; session state survives file runs |
| Assignment export | Server-generated PDF with exact code/output snapshots per run, plus a direct `.g` download; optional HTML/ZIP later |
| Docs PDF | Phase 3: embedded `pdf.js` panel plus the GAP reference/tutorial manuals |
| Native packaging | Later: wrap the same frontend in Tauri, or port the ~500-line driver to Rust |

Why a local web app: the hard parts are the editor and the GAP process driver,
both of which are easier and faster to build in TypeScript. A browser tab is
enough for a single-user local tool. If a real desktop window is wanted later,
the backend and frontend can stay; only the shell changes.

Why not Jupyter: the existing GAP Jupyter kernel is notebook-oriented and has a
heavy ZeroMQ/package dependency chain. Here `.g` files are first-class, and the
output/error handling is tailored to GAP.

Why not a VS Code extension: VS Code already solves editing, but the GAP
session integration (persistent state, run selection, structured output, error
jumps) would still have to be written, and VS Code is heavier than necessary.
It remains a sensible fallback if editor polish matters more than a custom tool.

Stack alternatives, if preferences differ:

- **Python backend + the same web frontend**: FastAPI instead of Fastify. The
  GAP driver is ordinary subprocess/stream code, so this is a small swap.
- **PySide6/Qt**: one language and a native window, but the editor, tabs, and
  completion UI become significantly more work than CodeMirror.
- **Rust + Tauri**: smallest native binary and the best long-term packaging, but
  slower to iterate on the protocol and UI.

---

## 2. What the MVP must do

- Open a project directory and browse/edit/save `.g` files in tabs.
- Highlight GAP syntax: keywords, strings, characters, comments, numbers,
  operators.
- Press F5 to save and run the current file in a persistent GAP session.
- Stream stdout/stderr into an **Output** panel, with run duration and status.
- Turn GAP's `file.g:line` errors into clickable links that jump to the editor.
- Press Ctrl+Enter to evaluate the current line/selection in a **Console** panel,
  with REPL semantics (a bare expression prints its value).
- Type commands directly into the console; history with Up/Down.
- Stop an infinite computation with SIGINT and keep the session usable.
- Restart the session after a crash or `quit;`.
- Show GAP version, session state, cursor position, and file status in a status bar.
- Export selected runs as a PDF containing the exact code that was executed and
  its output, ready to submit.
- Export the current editor buffer as a `.g` file (unsaved changes included).

Explicitly out of scope for v1: break-loop debugging, autocomplete, go-to-definition,
PDF documentation viewing, Windows, remote/multi-user use, package manager UI.

---

## 3. Validated GAP behaviour

These points were checked against GAP 4.16.1 on this machine; they drive the
architecture.

### 3.1 Running files

- `Read("file.g");` executes a file in the global namespace. Definitions persist
  for the rest of the session.
- `Read` does **not** echo expression values. A file must use `Print`/`View` to
  produce output. This is normal GAP script behaviour.
- A runtime error aborts the remainder of the file and returns to the top level.
  A syntax error is reported with `file:line` and also aborts the file.
- Therefore file runs use `Read` and are "script semantics"; interactive
  evaluation is done through stdin and is "REPL semantics".

### 3.2 GAP's machine-readable frontend mode

GAP has a `-p` mode used by Sage and XGAP. It emits control sequences that make a
frontend much more robust than parsing prompts:

| Sequence | Meaning |
|---|---|
| `@i` | GAP is ready for the next input line |
| `@n` | following text is normal output |
| `@f` | following text is error output |
| `@r` | following text is the echo of the input (discard) |
| `@J` | newline / end of an output line |
| `@e` | break loop or pager |
| `@p1.` | protocol version at startup |
| `@!…+`, `@"…+`, … | terminal capability queries; ignore up to `+` |

A working invocation is:

```text
gap -q -b -p -T -E -x 120
```

- `-p`: frontend protocol.
- `-T`: no interactive break loop; errors return to the top level.
- `-E`: no readline; avoids terminal escape noise.
- `-x 120`: readable output width. Long lines are wrapped with `\` + newline and
  can be rejoined for display.
- `--alwaystrace`: optional; prints a stack trace on errors even with `-T`.

Other verified facts:

- `SIGINT` during `while true do od;` produces `Error, user interrupt` and then
  `@i`. The session survives. This is the Stop button.
- `Read` returns `void`, so success/failure cannot be read from its return value.
  Treat any `@f` output as an error (with `Syntax warning` as a warning at most).
- `NamesGVars()` returns about 15,700 names. This is a ready-made completion
  dictionary, fetched once per session.
- GAP documentation PDFs exist at `/usr/share/gap/doc/ref/manual.pdf`,
  `/usr/share/gap/doc/tut/manual.pdf`, and `/usr/share/gap/doc/hpc/manual.pdf`.
  `gap --print-gaproot` and `GAPInfo.RootPaths` help locate the installation.
- The `?topic` help command uses an interactive pager that fights a pipe. Do not
  use it in the managed session in v1. If `@e` appears, send `q` to leave the
  pager; the Docs panel is the long-term answer.

### 3.3 What this means for the execution model

| User action | Mechanism | Echo of values | Output panel | State persists |
|---|---|---|---|---|
| Run file (F5) | save, then `Read(abs path)` | no (`Print` required) | Output | yes |
| Run line/cell/selection (Ctrl+Enter) | send code to stdin line by line | yes | Console | yes |
| Type in console | send line to stdin | yes | Console | yes |
| Stop | SIGINT to GAP | — | marks run interrupted | yes |
| Restart | kill + respawn | — | new session | no (fresh state) |

The split is deliberate: a full file is a script, while a selection is an
interactive experiment. Trying to make one mechanism do both produces surprising
results either way.

---

## 4. Architecture

```text
┌──────────────────────────────────────────────────────────────┐
│ Browser                                                      │
│  React + CodeMirror 6                                        │
│  file tree · tabs · editor · Output · Console · Docs (later) │
└───────────────┬──────────────────────────────┬───────────────┘
                │ REST (files)                 │ WebSocket (session)
                ▼                              ▼
┌──────────────────────────────────────────────────────────────┐
│ Node/TypeScript server (Fastify)                             │
│  Project service: tree, read, write, path guard              │
│  GapSession: spawn, protocol decoder, queue, interrupt       │
└───────────────┬──────────────────────────────────────────────┘
                │ stdin / stdout pipes
                ▼
┌──────────────────────────────────────────────────────────────┐
│ gap -q -b -p -T -E -x 120                                    │
│ persistent GAP session                                       │
└──────────────────────────────────────────────────────────────┘
```

One server process, one GAP process, one browser tab. The server binds to
`127.0.0.1`. The prototype has no authentication; a random per-launch token and
an Origin check are planned before any wider exposure. File APIs are confined to
the project root after `realpath`.

### 4.1 GAP session driver

`GapSession` is the most important class. It owns:

- spawn/restart/shutdown;
- a decoded event stream (`stdout`, `stderr`, `ready`, `break`, `exit`);
- a FIFO queue with one active request;
- a bounded transcript for reconnect/reload;
- run metadata: id, kind, label, source path, start line, timings, status.

State machine:

```text
stopped ──spawn──▶ starting ──@i──▶ idle ──request──▶ running ──@i──▶ idle
                       │                                  │
                       └──timeout/exit──▶ exited ◀────────┘
```

- **starting**: wait for the first `@i`; 10 s timeout; on failure show GAP's
  stderr and a "GAP not found / failed to start" banner.
- **running**: exactly one request. New file runs are rejected with "session
  busy"; console input is disabled in the UI. A run has no default timeout
  (GAP calculations can be long); Stop is always available.
- **interrupt**: send SIGINT, wait up to 2 s for `@i`; if it does not return,
  kill and respawn, and mark the run as interrupted.
- **exit**: broadcast the session state; offer Restart. Do not auto-restart, so
  the user sees what happened.

Startup sequence:

1. Spawn in the project root with the flags above.
2. Skip `@p1.` and all capability queries until the first `@i`. Keep any other
   pre-ready text in a startup buffer so a failed start can show GAP's own
   diagnostic instead of just "timeout".
3. Send `SetUserPreference("UseColorsInTerminal", false);;` and
   `SizeScreen([120, 40]);;` as hidden setup commands.
4. Optionally load a project startup file if configured (not `init.g` by
   default; a GAP package's `init.g` is not always safe to read twice).
5. Fetch the GAP version and loaded-package count for the status bar, and
   `NamesGVars()` for completion.

Protocol decoder rules:

- Accumulate bytes in a `StringDecoder` (UTF-8, replacement for invalid bytes).
- Any unrecognized `@X…+` capability query is discarded through `+`.
- `@n` / `@f` / `@r` switch the current target; `@J` writes a newline to the
  current target; `@i` flushes and resolves the active request.
- Text outside a marked stream is input echo and is discarded.
- `@e` means pager or break loop. With `-T`, this should only be the pager;
  send `q\n`, and if it persists send `quit;\n`. Never leave the session stuck.
- Output chunks are streamed to the client as they arrive; do not wait for
  `@i` before showing progress.

### 4.2 Run file

1. Client saves the active buffer (auto-save is on by default). A "save all
   before run" setting can extend this to every dirty buffer.
2. Client sends `run_file { path }`.
3. Server sends `Read("<escaped absolute path>");\n` to GAP.
4. Server streams `stdout` and `stderr` under the run id until `@i`.
5. Server parses errors, maps them to files/lines, and sends
   `run_finished { status, durationMs, diagnostics }`.
6. Client appends the completed block to Output, adds squiggles for the
   diagnostics, and records the run in history.

Notes:

- Paths are absolute and escaped for GAP strings.
- `Read` errors quote the real path, so line mapping is exact.
- A file that calls `QUIT;` kills the session; if EOF arrives while the run is
  active, mark it `exited` and tell the user.
- The run continues on the server even if the browser disconnects; the client
  receives the transcript on reconnect.

### 4.3 Run selection / line and console input

The same request type is used: `eval { code, label, sourcePath, startLine }`.

- The server splits `code` into lines (or sends the block as one write) and
  sends them to GAP's stdin, waiting for `@i` after each line. This keeps the
  UI responsive and lets Stop work between lines.
- Output is grouped into one console entry with the submitted code as its input.
- REPL semantics: `2+2;` prints `4`; `x := 5;` prints nothing; `x;` prints `5`.
- GAP's input echo is discarded because the UI already renders the submitted
  code.
- If the block ends in the middle of a construct, GAP waits for more input.
  A client-side block counter (`function/end`, `if/fi`, `for/od`, `while/od`,
  `repeat/until`, `rec/end`, brackets) decides whether the next prompt is
  `gap>` or `>`. This is a hint, not a parser; a wrong hint is harmless.
- For a selection that should get precise `file:line` diagnostics and script
  semantics, offer a secondary "Run as script" command later. It writes a temp
  file and uses `Read`, mapping temp lines back to the source offset.

Console UI:

- A transcript of entries, not a raw terminal emulator. Each entry has the
  submitted code, stdout, stderr, status, and timestamp.
- Input at the bottom; Enter submits; Up/Down recalls history; Tab completion
  inserts the selected name; Ctrl+C (or a Stop button) interrupts.
- `Clear console` clears the view, not the GAP state.
- `Restart session` is explicit and also clears the prompt state.

### 4.4 File/project service

REST endpoints, all rooted at the project directory:

```text
GET    /api/tree?path=.          one directory level, lazy expansion
GET    /api/file?path=...        { content, mtimeMs, encoding }
PUT    /api/file?path=...        save; optional baseMtimeMs for conflict detection
POST   /api/file                 create (path, kind: file|dir)
POST   /api/rename               rename/move
DELETE /api/file?path=...        delete file (and empty dir)
GET    /api/raw?path=...         binary/PDF stream, range-capable
GET    /api/docs                 known GAP manuals and package PDFs
```

- Resolve every project path against the root, then `realpath`, and reject
  anything outside it. Reject NUL bytes and binary files for the text API.
- `GET /api/docs` and the manual endpoints serve only a whitelist of known GAP
  documentation paths; they are not a general "read any absolute path" API.
- Ignore `.git`, `node_modules`, and other noise in the tree by default.
- Save atomically: write a sibling temp file, fsync, rename. Preserve mode.
- Watch the project with `chokidar` in phase 2; reload clean buffers silently,
  warn on dirty ones.
- The root defaults to the server's cwd; CLI `--root` and a "Change folder"
  dialog cover the rest. A native folder picker arrives with Tauri.

### 4.5 Editor

CodeMirror 6 with:

- A custom `StreamLanguage` tokenizer rather than a full Lezer grammar. GAP is
  small enough for this, and a grammar can replace it later without changing
  the UI.
- Keywords: `function end if then elif else fi for in do od while repeat until
  break continue return local global rec true false fail not and or mod quit`.
  Also highlight the common declaration/installation functions (`Declare*`,
  `Install*`, `BindGlobal`) as built-ins.
- Comments `#…`, strings `"…"` with escapes, characters `'x'`, numbers,
  operators (`:=`, `<>`, `<=`, `>=`, `->`, `..`, `;;`, …).
- Line numbers, bracket matching, auto-close, fold gutter, search, undo/redo,
  active-line highlight, indent-on-input.
- Snippets: `if`, `for`, `while`, `function`, `rec`, common test/assert blocks.
- Completion (phase 2): GAP global names from the session, plus keywords,
  snippets, and names assigned in the current file. Show a small kind icon only
  if the kind is cheaply known; otherwise show plain names.
- Diagnostics (phase 2): squiggles from the last run's `file:line` errors,
  with the message in a hover/tooltip. Clicking an output error opens the file.
- Tabs with dirty indicators; Ctrl+S saves; Ctrl+W closes with confirmation;
  Ctrl+P quick-open (phase 2); Ctrl+F search; Ctrl+/ comment toggle.
- Theme via CSS variables; one dark and one light theme initially.

### 4.6 Output and console panels

**Output** is a list of run blocks, newest last:

```text
▾ Run groups.g                         14:32:05   0.04 s   ok
  120
  15

▾ Run selections.g:20-24               14:33:10   1.21 s   error
  Error, Variable: 'H' must have a value
  at selections.g:22
```

- Stream output live; auto-scroll only if the user is already at the bottom.
- Render stderr in a distinct style, keep `\n` and tabs, strip ANSI in v1
  (add a small SGR renderer later).
- Clickable `path:line` links, a "copy output" button, and an export checkbox
  per run.
- Every run stores a **code snapshot** of what was actually executed, not the
  current buffer. For a file run the server reads the file immediately before
  `Read`; for a console/selection run the submitted text is already the snapshot.
- Cap the rendered DOM per block (e.g. 20 MB or 200k lines), but keep the full
  output in the run record/log so an export cannot silently lose the tail. If a
  hard cap is hit, mark the run `outputTruncated` and show a warning.

**Console** is the interactive transcript described in 4.3. It shares the same
GAP process, so `G := SymmetricGroup(5);;` in the console is visible to a later
file run, and definitions from a file run are visible in the console.

### 4.7 Diagnostics

`parseGapErrors(text, sourcePath, lineOffset)` handles the common forms:

```text
Syntax error: expression expected in file.g:12
Error, Variable: 'x' must have a value
not in any function at file.g:3
Error, boom
*[1] Error( "boom" );
   @ file.g:7
called from read-eval loop at file.g:12
```

- Join GAP's `\`+newline continuations before parsing.
- Produce `{ file, line, severity, message }`.
- For `Read` runs, line numbers are exact. For temp-file selection runs, add the
  selection's start offset and rewrite the temp path to the source path.
- Ignore `*stdin*` locations for console runs; they are not mappable in v1.
- A file can have several diagnostics; deduplicate by file/line/message.

### 4.8 Export for assignments

The export is a first-class feature, not an afterthought: runs already carry the
code that produced them and their full output, so a report is a pure rendering
of stored data.

**Scopes**

- Latest run of the current file (toolbar default).
- A single run (export icon on its block).
- Checked runs in Output/Console.
- All runs in the session.

**Formats**

1. **PDF (required, implemented).** A server-generated A4 report built with
   PDFKit. The PDF contains the assignment header, GAP version, and one block per
   run with line-numbered source, stdout, and stderr. It is downloaded directly;
   there is no browser print dialog and no headless-Chromium dependency. A
   Unicode monospace font is embedded when available (DejaVu Sans Mono or Noto
   Sans Mono), so Greek letters and other math characters survive the export.
2. **`.g` source download (required, implemented).** The toolbar's **Export .g**
   downloads the current editor buffer, including unsaved changes, with its
   original filename. A server-side `GET /api/download?path=...` also exists for
   a saved copy.
3. **Optional later.** HTML, Markdown, or a ZIP bundle (source files plus a
   transcript and manifest) can be added for submission portals that want more
   than one file. They are not needed for the first assignment workflow.

**Report contents**

- Assignment title, author, course, and date (optional and remembered in the
  browser).
- GAP version and export timestamp.
- Runs in execution order, each with: label, source path and line range, status,
  duration, source code with line numbers, stdout, and stderr.
- Failed runs are included and clearly marked in red; the user can select which
  runs to export with checkboxes.
- A4 margins, wrapped long lines, code/output page breaks, and page footers.

**Correctness rules**

- Export uses `codeSnapshot`, never the current editor contents. If the file has
  changed since the run, the report still shows the code that produced the
  output; the UI may add a note "file changed since this run".
- GAP output is drawn as text, not interpreted as markup. A `Print("<script>…")`
  appears literally in the PDF.
- If a run hit the output cap, the export shows a truncation warning instead of
  pretending the output is complete.
- All export happens locally; nothing is uploaded.
- PDF font fallback is explicit: if no Unicode mono font is found, Courier is
  used and unsupported characters become `?` rather than failing the export.

**REST endpoint**

```text
POST /api/export/pdf
  { runIds?: string[], title?, author?, course? }
  -> application/pdf
GET /api/download?path=...   -> .g file attachment
```

The frontend downloads the PDF as a Blob, so the exact filename and selected run
set are controlled by the client.

---

## 5. WebSocket protocol and data model

```ts
// client -> server
type ClientMsg =
  | { type: "run_file"; path: string }
  | { type: "eval"; code: string; label: string;
      sourcePath?: string; startLine?: number }
  | { type: "interrupt" }
  | { type: "restart" }
  | { type: "refresh_names" };

// server -> client
type ServerMsg =
  | { type: "hello"; gapVersion: string; cwd: string;
      state: SessionState; runs: Run[]; names: string[] }
  | { type: "run_started"; run: Run }
  | { type: "run_output"; runId: string;
      stream: "stdout" | "stderr"; text: string }
  | { type: "run_finished"; runId: string; status: RunStatus;
      durationMs: number; diagnostics: Diagnostic[] }
  | { type: "session_state"; state: SessionState; message?: string }
  | { type: "names"; names: string[] }
  | { type: "error"; message: string };
```

```ts
type SessionState = "stopped" | "starting" | "idle" | "running" | "exited";
type RunStatus = "running" | "ok" | "error" | "interrupted" | "exited";

interface Run {
  id: string;
  kind: "file" | "console";
  label: string;
  sourcePath?: string;
  startLine?: number;
  code?: string;
  startedAt: number;
  endedAt?: number;
  status: RunStatus;
  stdout: string;
  stderr: string;
  diagnostics: Diagnostic[];
}
```

- Client reconnects with exponential backoff; on `hello` it replaces local state
  with the server's recent runs (bounded, e.g. last 50 runs or 2 MB).
- Output chunks are sent as they are decoded; the server does not merge them
  into one giant message.
- Any save/run race is avoided by saving before sending `run_file`; if the save
  fails, do not run.

---

## 6. UI layout

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ GAP IDE   [folder]   groups.g ×  helpers.g ×   ▶ Run  ⏹ Stop  ⟳ Restart     │
├──────────────┬───────────────────────────────────────────┬───────────────────┤
│ FILES        │  groups.g                                 │ OUTPUT │ CONSOLE │
│ ▾ project    │   1  # compute with S5                    │ ───────────────── │
│   groups.g   │   2  G := SymmetricGroup(5);;             │ ▾ Run groups.g    │
│   helpers.g  │   3  Print(Order(G), "\n");               │   120             │
│   docs/      │   4                                       │   0.04 s    ok    │
│              │   5  for x in [1..3] do                   │                   │
│              │   6    Print(x, "\n");                    │ ▾ Error           │
│              │   7  od;                                  │   groups.g:12     │
├──────────────┴───────────────────────────────────────────┴───────────────────┤
│ GAP 4.16.1 · idle · 31 packages · Ln 3, Col 12 · UTF-8 · LF                  │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Left file tree ~220 px, collapsible.
- Center editor tabs, fills remaining width.
- Right panel ~380 px, resizable, with Output/Console/Docs tabs. Auto-switch:
  F5 selects Output, Ctrl+Enter selects Console.
- Status bar: GAP version, session state, loaded package count, file encoding,
  line/column, dirty state.
- Toolbar: folder name, Run, Stop, Restart, settings.
- On narrow windows the file tree and right panel collapse into toggles.

---

## 7. Project layout

```text
gap-ide/
├── PLAN.md
├── package.json
├── tsconfig.base.json
├── server/
│   ├── src/
│   │   ├── index.ts            Fastify bootstrap, static frontend, WS
│   │   ├── config.ts           CLI flags, config file, defaults
│   │   ├── project.ts          tree/read/write, path guard, atomic save
│   │   ├── routes.ts           REST + WS handlers
│   │   └── gap/
│   │       ├── session.ts      spawn, queue, lifecycle, interrupt
│   │       ├── protocol.ts     -p decoder state machine
│   │       ├── errors.ts       diagnostics parser
│   │       └── names.ts        completion-name fetch/cleanup
│   └── test/
│       ├── protocol.test.ts
│       ├── errors.test.ts
│       └── fixtures/*.g
├── web/
│   ├── index.html
│   ├── vite.config.ts
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── ws.ts               reconnecting client, message types
│       ├── components/
│       │   ├── FileTree.tsx
│       │   ├── EditorTabs.tsx
│       │   ├── Editor.tsx
│       │   ├── OutputPanel.tsx
│       │   ├── ConsolePanel.tsx
│       │   ├── DocsPanel.tsx   phase 3
│       │   ├── Toolbar.tsx
│       │   └── StatusBar.tsx
│       ├── editor/
│       │   ├── gap.ts          StreamLanguage tokenizer
│       │   ├── completions.ts
│       │   └── snippets.ts
│       └── styles.css
└── shared/
    └── protocol.ts             message and model types
```

Keep dependencies few:

- Server: `fastify`, `@fastify/websocket`, `@fastify/static`, `chokidar`
  (phase 2), `tsx`/`typescript`, `vitest`.
- Web: `react`, `react-dom`, CodeMirror packages, `@lezer/highlight`,
  `react-resizable-panels`, `lucide-react`, `pdfjs-dist` (phase 3).
- No UI framework, no Tailwind, no state library. A `SessionProvider` with
  `useReducer` is enough.

Commands:

```text
npm install
npm run dev          # server :3001 + Vite :5173
npm run build
npm start -- --root ~/repos/algebra
npm run smoke        # end-to-end run + PDF check (server must be running)
```

The root defaults to the current directory, so `cd my-gap-project && gap-ide`
is the intended daily workflow.

---

## 8. Milestones

Estimates are focused working days; double them for calendar time with testing
and polish.

| Milestone | Work | Estimate |
|---|---|---|
| M0 — protocol spike | Node script: spawn GAP, decode `-p`, run a file, print/stream output, SIGINT, restart. Record fixtures for tests. | 0.5 d |
| M1 — skeleton | Fastify + Vite + WS + typed protocol; file tree; editor + GAP highlighting; open/save; tabs; status bar. | 1 d |
| M2 — run file | Save-before-run, `Read`, streaming Output, error parsing, clickable `file:line`, Stop, Restart, run history, reconnect replay. | 1 d |
| M3 — console | Interactive entries, history, REPL echo, shared state, interrupt, prompt/continuation hint, clear. | 1 d |
| M4 — selection | Ctrl+Enter current line/cell/selection; cell = blank-line-delimited block; group output per submission; console auto-switch. | 0.5 d |
| M5 — assignment export | PDFKit report with code snapshots, stdout/stderr, metadata; `.g` download; selection checkboxes and export dialog. | 1 d |
| M6 — polish | Autocomplete from GAP names + file assignments; snippets; diagnostics squiggles; settings; themes; ANSI colors; file watcher; quick open. | 1.5 d |
| M7 — docs | PDF list (reference/tutorial/HPC/package docs), embedded pdf.js viewer or new-tab fallback, manual shortcut. | 1 d |
| M8 — optional native | Tauri shell around the same frontend, native folder picker, packaging. Or a Rust backend if a single binary is required. | 2–4 d |

MVP after M0–M5: about 5 focused days. A solid tool after M6–M7: about
7.5 focused days.

### Acceptance criteria for MVP

- Open a folder, edit two `.g` files in tabs, save both.
- F5 on a file with `Print` output shows the output within 100 ms of GAP
  producing it, and the run status is correct.
- A syntax error is shown with the right `file:line`; clicking it jumps there.
- Ctrl+Enter on `2+2;` in the editor prints `4` in Console; Ctrl+Enter on a
  function definition does not print a value and keeps the definition.
- An infinite loop can be stopped and the next command still works.
- `quit;` or a crash is detected, and Restart gives a usable session.
- Reloading the browser reconnects to the same session and restores recent output.
- Export PDF produces a valid PDF containing the executed source and its output.
- Export .g downloads the current buffer, including unsaved changes.
- No file outside the project root can be read or written through the API.

---

## 9. Testing

Unit tests (Vitest):

- Protocol decoder: feed recorded byte streams for startup, normal output,
  errors, input echo, multiline input, pager `@e`, partial chunks split at every
  byte boundary.
- Error parser: syntax error, runtime error with traceback, multiple files,
  wrapped `\` lines, warnings.
- Path guard: `..`, absolute paths, symlinks, NUL bytes, binary files.
- Block counter / completion name cleanup.

Integration tests (spawn real GAP, skip if `gap` is missing):

```text
hello.g          Print("hello\n");                  -> stdout, ok
syntax-error.g   x := ;                             -> stderr, line 2
runtime-error.g  Error("boom"); Print("after\n");   -> error, no "after"
quit.g           QUIT;                              -> session exited
infinite.g       while true do od;                  -> interrupt, session survives
unicode.g        Print("αβγ\n");                     -> UTF-8 intact
```

PDF tests:

- Exported file starts with `%PDF`, has the expected page count, and contains
  the title, code, stdout, and stderr in extracted text.
- Unicode output (Greek letters, `∈`, `ℤ`) survives with an embedded font.
- Long output crosses page boundaries with correct footers.
- A run with an error includes the red stderr block and error status.
- Selecting one run excludes the others; selecting none exports all completed
  runs.

UI smoke test (Playwright, optional): open fixture, run, assert output block and
error link, export a PDF and a `.g` file. Manual checklist for GAP versions and
package-loading differences.

CI can run unit tests without GAP; the integration suite runs locally or in a
job that installs GAP.

---

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `-p` is a legacy protocol and could change | Isolate it in `protocol.ts`; version-check `@p1.`; record fixtures; fallback to a sentinel protocol (`Read` + `Print("__DONE__")`) if needed. |
| `Read` does not echo values | Console/selection path uses stdin REPL semantics; document that files need `Print`. |
| GAP's `?` pager hangs the session | Detect `@e`, send `q`/`quit;`, avoid `?` in managed mode; docs panel later. |
| Console line numbers are `*stdin*`, hard to map | Only file runs get diagnostics in v1; secondary "run as script" uses temp files with offset mapping. |
| `@i` is emitted even for an incomplete console block | Treat it as "ready for another line", not "statement complete"; show a `>` hint from a block counter, and let Stop reset a stuck block. |
| A long computation blocks the only session | Stop button via SIGINT (verified); later a second background session if needed. |
| Huge output freezes the browser | Stream, cap per run, offer full log download, virtualize or truncate the transcript. |
| GAP output wrapping breaks parsing | Set width 120, rejoin `\`+newline before parsing, parse errors from stderr only. |
| Session state diverges from UI after crash | Server is the single source of truth; `hello` replays state; no optimistic status changes. |
| Local server is reachable by other local users/sites | Bind 127.0.0.1; add a random token and Origin check before exposing; path guard; no arbitrary shell endpoint. |
| Windows/macOS differences | Defer; the driver is small and platform-specific bits are path escaping and SIGINT. |
| Custom tokenizer is incomplete | It only affects colors, not correctness; a Lezer grammar can replace it later. |

---

## 11. Open decisions

1. **Native window now or later?** Recommendation: local web app for MVP,
   Tauri wrapper later. If a native window is required from day one, keep the
   same frontend and move the session driver into the Tauri Rust side.
2. **Selection semantics.** Recommendation: Ctrl+Enter goes to the console
   (REPL echo), F5 is script semantics. A separate "run as script" command can
   be added for precise diagnostics on selections.
3. **Session persistence.** Recommendation: persistent session with an explicit
   Restart; document that errors abort the rest of the current file but keep
   prior definitions.
4. **Docs PDF experience.** Recommendation: new-tab browser viewer first (zero
   dependencies), then embedded `pdf.js` with page navigation and the GAP
   reference/tutorial manuals. Assignment export is already a direct PDF and is
   a separate feature.
5. **Completion scope.** Recommendation: GAP global names + current-file
   assignments + snippets. Do not attempt signatures or hover docs until the
   docs pipeline exists.

---

## 12. First implementation checklist

- [x] Create the repo skeleton and `package.json` scripts.
- [x] Write the protocol spike and record fixtures:
  - [x] spawn `gap -q -b -p -T -E -x 120`
  - [x] decode `@i`, `@n`, `@f`, `@r`, `@J`, `@e`, capability junk
  - [x] run `Read("/abs/hello.g")` and stream output
  - [x] run a syntax error and a runtime error, capture `file:line`
  - [x] SIGINT `while true do od;`, verify `@i` afterwards
  - [x] `quit;`, verify EOF and restart
- [x] Implement `GapSession` with the state machine and request queue.
- [x] Implement the project API with the path guard and atomic save.
- [x] Build the editor shell: file tree, tabs, CodeMirror, save, status bar.
- [x] Wire F5 to `run_file`, stream Output, and show errors.
- [x] Add the console transcript and Ctrl+Enter selection evaluation.
- [x] Add Stop/Restart and the session state banner.
- [ ] Write the decoder/error/path tests.
- [ ] Add completion, diagnostics squiggles, settings, and themes.
- [ ] Add the Docs panel and PDF viewer.
- [x] Add PDF report export (code snapshot + output) and `.g` download.

The protocol spike is the go/no-go step. Everything else is ordinary UI work
once the driver is reliable.
