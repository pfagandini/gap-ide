# GAP IDE

A small local IDE for [GAP](https://www.gap-system.org/): edit `.g` files in a
real editor, run whole files or selections in a persistent GAP session, collect
the output, and export a PDF report or the `.g` source for an assignment.

This is a prototype; see [`PLAN.md`](./PLAN.md) for the longer-term design.

## Features

- File tree, tabs, save, and GAP syntax highlighting in CodeMirror 6.
- **Run file (F5)**: saves the buffer and runs it in a persistent GAP session,
  printing each result as the `gap>` prompt would. Output and errors stream into the **Output** panel.
- **Cells, notebook style (Shift+Enter)**: a cell is a block of lines between
  blank lines. Shift+Enter runs the cell under the cursor, shows its output
  right below it in the editor, and moves to the next cell. **Run all cells**
  (Ctrl+Shift+Enter) runs every cell in order. Re-running a cell replaces its
  output; × hides one. The file itself stays a plain `.g` file.
- **Export LaTeX**: the cells shown with output, in file order, as a GAP
  session (`gap> ` input, output below) inside `\begin{verbatim}`, ready to
  copy into a LaTeX assignment.
- **Clear** empties the Output or Console panel (clearing the Console also
  removes the outputs shown in the editor).
- **Run selection (Ctrl+Enter)**: sends the current line or selection to the
  same session's stdin, so it behaves like the GAP REPL (`2+2;` prints `4`).
  Output goes to the **Console** panel.
- Interactive GAP console with history (Up/Down) and shared state.
- **Stop** sends SIGINT to a running computation; **Restart** gives a fresh
  session.
- Tick runs in the output panel (or leave none ticked to use every completed
  run) and click **Export PDF** to download a formatted report with the exact
  code that was executed and its output. Title, author, and course are optional.
- **Export .g** downloads the current editor buffer as a `.g` file, including
  unsaved changes.

## Requirements

- Node.js 20 or newer.
- GAP 4.16 (or a recent 4.x) available as `gap` on `PATH`. A custom path can be
  passed with `--gap`.
- For PDF export, a Unicode monospace font is auto-detected (DejaVu Sans Mono or
  Noto Sans Mono on Linux). Without one, PDFKit falls back to Courier and
  non-Latin characters are replaced with `?`.

## Run it as an app (no browser tab, no address)

```bash
scripts/install-desktop.sh ~/path/to/course   # once: app menu entry + ~/.local/bin/gap-ide
gap-ide [folder]                               # or pick "GAP IDE" in the app menu
```

`bin/gap-ide` installs and builds on first use, starts the server on a free
local port, and opens it as a standalone window (Chromium, Chrome or Brave in
`--app` mode, one private profile per project folder). Closing the window stops
the server. Logs go to `~/.local/state/gap-ide/server.log`.

## Run it for development

```bash
npm install
npm run dev
```

Open <http://127.0.0.1:5173>. The backend listens on
<http://127.0.0.1:3001>.

For a single production process:

```bash
npm run build
npm start
```

Open <http://127.0.0.1:3001>.

The project root defaults to the current directory. Other options:

```bash
npm start -- --root ~/repos/algebra --gap /usr/bin/gap --port 3001
```

### First steps

1. Expand `examples/`, open `demo.g`.
2. Press **F5** to run it, or put the cursor on one line and press
   **Ctrl+Enter**.
3. Open `error.g` and run it to see the error and line number in the Output
   panel.
4. Type `G;` or `mySquare(7);` in the Console tab after running `demo.g`.
5. Tick the run(s) you want and click **Export PDF**; click **Export .g** to
   download the current buffer.

## How it works

The server spawns:

```text
gap -q -b -p -T -E -x 120
```

`-p` is GAP's machine-readable frontend protocol: `@i` means ready for input,
`@n`/`@f` switch between normal and error output, `@J` is a newline, and `@r` is
input echo. `-T` disables the interactive break loop so errors return to the top
level, and SIGINT interrupts a long computation cleanly.

File runs read the file statement by statement with `READ_STREAM_LOOP`, so
they behave like pasting the file at the `gap>` prompt: `Size(G);` prints its
value, `;;` stays silent, and an error is reported (as `file.g:LINE`) without
stopping the rest of the file. Selection and console runs go through stdin and
echo values the same way.

Every run stores a snapshot of the code that was executed. PDF export renders
those snapshots plus stdout/stderr with PDFKit, so editing the file afterwards
does not silently change the report.

## Layout

```text
server/
  gap.ts       GAP process, -p protocol decoder, run lifecycle, interrupt
  index.ts     Fastify REST + WebSocket server, PDF route
  pdf.ts       A4 assignment report renderer
  project.ts   file tree, safe path handling, atomic save
src/
  App.tsx      layout, file tabs, WebSocket state, export actions
  Editor.tsx   CodeMirror editor and shortcuts
  gapLanguage.ts
  FileTree.tsx
  OutputPanel.tsx
  ConsolePanel.tsx
  RunBlock.tsx
  ExportDialog.tsx
examples/
  demo.g
  error.g
```

## Known limitations

- Break loops are disabled (`-T`); errors are reported but cannot be inspected
  in a `brk>` prompt.
- GAP's `?topic` help pager is not supported in the managed session yet.
- No autocomplete/diagnostics squiggles yet; the prototype focuses on run,
  output, and export.
- Run history is in memory. Restarting the server or reloading the page keeps
  the GAP session via WebSocket reconnect, but a server restart loses history.
- The local server has no authentication. It binds to `127.0.0.1` and refuses
  requests whose `Host` is not a loopback name (DNS rebinding) or whose
  `Origin` is another site (a web page opening the WebSocket and running GAP
  `Exec` commands). Do not expose it to a network.
- File watching, multiple projects, and PDF documentation viewing are later
  steps in `PLAN.md`.

## Development notes

```bash
npm run build     # typecheck + production frontend
npm start         # serve dist and API on 3001
npm run smoke     # with the server running: run demo.g and verify the PDF
```

`npm run smoke` writes `/tmp/gap-ide-smoke.pdf`.

The API is intentionally small:

- `GET /api/tree`, `GET/PUT/POST /api/file`, `GET /api/download`
- `POST /api/export/pdf` with `{ runIds?, title?, author?, course? }`
- `POST /api/export/latex` with `{ runIds }` returns `{ text }`
- `GET /api/info`
- `WS /ws` with `run_file`, `eval`, `eval_blocks`, `clear_runs`, `interrupt`,
  `restart`
