import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { GapLauncher } from "./launcher";
import { randomUUID } from "node:crypto";
import type { Run, RunKind, RunStatus, SessionState } from "../shared/types";

type StreamName = "stdout" | "stderr";

interface DecoderEvents {
  output: (stream: StreamName, text: string) => void;
  ready: () => void;
  break: () => void;
}

/**
 * GAP's -p frontend protocol decoder.
 *
 * @n/@f switch the output stream, @J adds a newline, @r is input echo and @i
 * means "ready for the next input line". Capability queries such as @!123+ are
 * terminal handshakes and are ignored.
 */
export class GapProtocolDecoder {
  private buffer = "";
  private target: StreamName | "discard" = "discard";
  // True while inside an @r input echo. The echo of one line ends at its @J;
  // output written straight to OutputTextUser() (e.g. READ_STREAM_LOOP in file
  // runs) follows without a fresh @n, so it is normal output.
  private inEcho = false;
  private capability = false;

  constructor(private readonly events: DecoderEvents) {}

  reset() {
    this.buffer = "";
    this.target = "discard";
    this.capability = false;
    this.inEcho = false;
  }

  push(chunk: string) {
    this.buffer += chunk;

    while (this.buffer.length > 0) {
      if (this.capability) {
        const end = this.buffer.indexOf("+");
        if (end === -1) return;
        this.buffer = this.buffer.slice(end + 1);
        this.capability = false;
        continue;
      }

      const at = this.buffer.indexOf("@");
      if (at === -1) {
        this.emit(this.buffer);
        this.buffer = "";
        return;
      }
      if (at > 0) {
        this.emit(this.buffer.slice(0, at));
        this.buffer = this.buffer.slice(at);
      }

      if (this.buffer.length < 2) return;
      const code = this.buffer[1];

      switch (code) {
        case "n":
        case "f":
        case "r":
          this.target =
            code === "n" ? "stdout" : code === "f" ? "stderr" : "discard";
          this.inEcho = code === "r";
          this.buffer = this.buffer.slice(2);
          break;
        case "J":
          if (this.inEcho) {
            this.inEcho = false;
            this.target = "stdout";
          } else if (this.target !== "discard") {
            this.events.output(this.target, "\n");
          }
          this.buffer = this.buffer.slice(2);
          break;
        case "i":
          this.inEcho = false;
          this.target = "discard";
          this.buffer = this.buffer.slice(2);
          this.events.ready();
          break;
        case "e":
          this.buffer = this.buffer.slice(2);
          this.events.break();
          break;
        case "h":
          this.target = "stdout";
          this.buffer = this.buffer.slice(2);
          break;
        case "p": {
          const dot = this.buffer.indexOf(".");
          if (dot === -1) return;
          this.buffer = this.buffer.slice(dot + 1);
          break;
        }
        case "!":
        case '"':
        case "#":
        case "$":
        case "%":
        case "&":
        case "w":
          this.capability = true;
          this.buffer = this.buffer.slice(2);
          break;
        case "s": {
          let i = 2;
          while (i < this.buffer.length && /[0-9]/.test(this.buffer[i])) i++;
          this.buffer = this.buffer.slice(i);
          break;
        }
        case "@":
          if (this.target !== "discard") this.events.output(this.target, "@");
          this.buffer = this.buffer.slice(2);
          break;
        case "m":
        case "x":
        case "z":
        case "c":
          // Miscellaneous control notifications. Drop any payload until the
          // next control marker rather than leaking it into the output.
          this.target = "discard";
          this.buffer = this.buffer.slice(2);
          break;
        default:
          this.buffer = this.buffer.slice(2);
          break;
      }
    }
  }

  private emit(text: string) {
    if (text && this.target !== "discard") {
      this.events.output(this.target, text);
    }
  }
}

interface SessionEvents {
  state: (state: SessionState, message?: string) => void;
  runStarted: (run: Run) => void;
  runOutput: (runId: string, stream: StreamName, text: string) => void;
  runFinished: (run: Run) => void;
}

interface SessionOptions {
  root: string;
  /** How to start GAP, or why it could not be found. */
  launcher: GapLauncher | { error: string };
  events: SessionEvents;
}

export class GapSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private decoder: GapProtocolDecoder;
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private started = false;
  private stopping = false;
  private state: SessionState = "starting";
  private activeRun: Run | null = null;
  private interrupted = false;
  private cancelled = false;
  private runs: Run[] = [];
  private breakCount = 0;
  /** GAP's PID inside a wrapper (Cygwin/WSL), from the "@@pid N" line. */
  private gapPid: string | null = null;
  private pidBuffer = "";
  /** Collects output printed outside any run (startup queries). */
  private capture: string | null = null;
  private version = "unknown";
  // File runs print errors on the normal stream (see runFile), so they are
  // spotted from the text instead.
  private sawErrorText = false;

  constructor(private readonly options: SessionOptions) {
    this.decoder = new GapProtocolDecoder({
      output: (stream, text) => this.handleOutput(stream, text),
      ready: () => this.handleReady(),
      break: () => this.handleBreak()
    });
  }

  getState() {
    return this.state;
  }

  getVersion() {
    return this.version;
  }

  describeLauncher() {
    const launcher = this.options.launcher;
    return "error" in launcher ? "not found" : launcher.description;
  }

  getRuns() {
    return this.runs;
  }

  /** Forget finished runs of one kind (the panel's Clear button). */
  clearRuns(kind: RunKind) {
    this.runs = this.runs.filter((run) => run.kind !== kind || run.status === "running");
  }

  isBusy() {
    return this.activeRun !== null || this.state !== "idle";
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.decoder.reset();
    this.setState("starting");

    const launcher = this.options.launcher;
    if ("error" in launcher) {
      this.started = false;
      this.setState("failed", launcher.error);
      return;
    }
    this.gapPid = null;
    this.pidBuffer = "";

    const child = spawn(
      launcher.command,
      launcher.args(["-q", "-b", "-p", "-T", "-E", "-x", "120"]),
      {
        cwd: this.options.root,
        env: { ...process.env, TERM: "dumb", ...launcher.env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      }
    );
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (this.child !== child) return;
      if (launcher.reportsPid && this.gapPid === null) {
        // The wrapper's first line is "@@pid N"; everything after is GAP.
        this.pidBuffer += chunk;
        const match = this.pidBuffer.match(/@@pid (\d+)\r?\n/);
        if (!match || match.index === undefined) return;
        this.gapPid = match[1];
        chunk = this.pidBuffer.slice(match.index + match[0].length);
        this.pidBuffer = "";
        if (!chunk) return;
      }
      this.decoder.push(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      if (this.child === child && this.state === "starting") {
        console.error("[gap stderr]", chunk);
      }
    });

    child.on("error", (error) => {
      if (this.child !== child) return;
      this.setState("failed", `Could not start GAP: ${error.message}`);
      this.rejectPendingReady(new Error(error.message));
    });

    child.on("exit", (code, signal) => {
      // A restart may already have replaced this process. Ignore the old
      // child's exit so it cannot clobber the new session.
      if (this.child !== child) return;
      this.child = null;
      const reason = `GAP exited (${signal ?? code ?? "unknown"})`;
      if (this.activeRun) {
        this.finishRun(this.activeRun, "exited", reason);
      }
      this.setState(this.stopping ? "exited" : "exited", reason);
      this.rejectPendingReady(new Error(reason));
    });

    try {
      await this.waitForReady(15_000);
      await this.writeAndWait('SetUserPreference("UseColorsInTerminal", false);;\n', 5_000);
      await this.writeAndWait('SizeScreen([120, 40]);;\n', 5_000);
      this.capture = "";
      await this.writeAndWait('Print("GAPIDE-VERSION ", GAPInfo.Version, "\\n");;\n', 5_000);
      const version = this.capture.match(/GAPIDE-VERSION (\S+)/);
      if (version) this.version = version[1];
      this.capture = null;
      // Only advertise readiness after the setup commands have completed.
      this.setState("idle");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.capture = null;
      this.stopChild();
      this.setState("failed", message);
    }
  }

  async restart() {
    this.cancelled = true;
    this.finishRunIfActive("interrupted", "Session restarted.");
    this.rejectPendingReady(new Error("Session restarted."));
    this.stopping = true;
    this.stopChild();
    this.started = false;
    this.state = "starting";
    this.readyPromise = null;
    this.resolveReady = null;
    this.rejectReady = null;
    this.interrupted = false;
    this.cancelled = false;
    this.breakCount = 0;
    this.stopping = false;
    await this.start();
  }

  async shutdown() {
    this.stopping = true;
    this.rejectPendingReady(new Error("Session stopped."));
    this.stopChild();
  }

  /**
   * Ends the current GAP process. Behind a wrapper (Cygwin/WSL) killing the
   * wrapper may leave GAP running, so GAP itself is asked to quit and then
   * killed by PID.
   */
  private stopChild() {
    const child = this.child;
    const pid = this.gapPid;
    this.child = null;
    this.gapPid = null;
    if (!child) return;
    const launcher = this.options.launcher;
    try {
      if (!child.stdin.destroyed) child.stdin.end("QUIT;\n");
    } catch {
      // already gone
    }
    if (!("error" in launcher) && launcher.signalCommand && pid) {
      const { command, args } = launcher.signalCommand(pid, "KILL");
      setTimeout(() => {
        execFile(command, args, { windowsHide: true }, () => child.kill());
      }, 1500);
    } else {
      child.kill("SIGTERM");
    }
  }

  private sendInterrupt() {
    const launcher = this.options.launcher;
    if (!("error" in launcher) && launcher.signalCommand && this.gapPid) {
      const { command, args } = launcher.signalCommand(this.gapPid, "INT");
      execFile(command, args, { windowsHide: true }, () => {});
    } else {
      this.child?.kill("SIGINT");
    }
  }

  async interrupt() {
    if (!this.child || !this.activeRun) return;
    this.interrupted = true;
    this.cancelled = true;
    this.sendInterrupt();
    try {
      await this.waitForReady(3_000);
    } catch {
      this.finishRunIfActive("interrupted", "Interrupted; the session did not recover.");
      await this.restart();
    }
  }

  async runFile(
    filePath: string,
    code: string,
    displayPath = filePath
  ): Promise<Run> {
    if (this.isBusy()) throw new Error("The GAP session is busy.");
    if (!this.child) throw new Error("The GAP session is not running.");

    const run = this.newRun("file", displayPath, code, displayPath);
    this.beginRun(run);
    try {
      const launcher = this.options.launcher;
      const gapPath = "error" in launcher ? filePath : launcher.toGapPath(filePath);
      const escaped = gapPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      // Not Read(): that has script semantics and prints nothing for
      // `Size(G);`. READ_STREAM_LOOP evaluates the file statement by statement
      // like the gap> prompt: values are echoed, `;;` stays silent, and an
      // error does not stop the rest of the file (as when pasting into GAP).
      // Assignments go to the global scope, so the console sees them.
      await this.writeAndWait(
        `CallFuncList(function() local s; s := InputTextFile("${escaped}"); ` +
          `if s = fail then Error("cannot open file"); fi; ` +
          `READ_STREAM_LOOP(s, OutputTextUser(), false); CloseStream(s); end, []);;\n`
      );
      this.finishRun(run, this.statusForRun());
      return run;
    } catch (error) {
      this.finishRun(run, this.statusForFailure(), messageOf(error));
      throw error;
    }
  }

  async eval(
    code: string,
    label: string,
    sourcePath?: string,
    startLine?: number
  ): Promise<Run> {
    if (this.isBusy()) throw new Error("The GAP session is busy.");
    if (!this.child) throw new Error("The GAP session is not running.");

    const run = this.newRun("console", label, code, sourcePath, startLine);
    run.transcript = [];
    this.beginRun(run);
    try {
      const lines = code.split(/\r?\n/);
      for (const line of lines) {
        if (this.cancelled) break;
        // Output arriving before GAP asks for the next line belongs to this one.
        run.transcript.push({ input: line, output: "" });
        // Blank lines are sent too: GAP answers them with @i, and preserving
        // them matters inside multi-line strings.
        await this.writeAndWait(`${line}\n`);
      }
      this.finishRun(run, this.statusForRun());
      return run;
    } catch (error) {
      this.finishRun(run, this.statusForFailure(), messageOf(error));
      throw error;
    }
  }

  private newRun(
    kind: RunKind,
    label: string,
    code: string,
    sourcePath?: string,
    startLine?: number
  ): Run {
    return {
      id: randomUUID(),
      kind,
      label,
      sourcePath,
      startLine,
      code,
      stdout: "",
      stderr: "",
      status: "running",
      startedAt: Date.now()
    };
  }

  private beginRun(run: Run) {
    this.activeRun = run;
    this.interrupted = false;
    this.cancelled = false;
    this.breakCount = 0;
    this.sawErrorText = false;
    this.runs.push(run);
    this.setState("running");
    this.options.events.runStarted(run);
  }

  private finishRun(run: Run, status: RunStatus, message?: string) {
    if (run.status !== "running") return;
    const endedAt = Date.now();
    run.status = status;
    run.endedAt = endedAt;
    run.durationMs = endedAt - run.startedAt;
    if (message && !run.stderr) {
      run.stderr = message;
      this.options.events.runOutput(run.id, "stderr", message);
    }
    this.activeRun = null;
    this.setState("idle");
    this.options.events.runFinished(run);
  }

  private finishRunIfActive(status: RunStatus, message?: string) {
    if (this.activeRun) this.finishRun(this.activeRun, status, message);
  }

  private statusForRun(): RunStatus {
    if (this.interrupted) return "interrupted";
    const run = this.activeRun;
    if (run && (run.stderr.trim().length > 0 || this.sawErrorText)) return "error";
    return "ok";
  }

  private statusForFailure(): RunStatus {
    if (this.interrupted) return "interrupted";
    if (!this.child) return "exited";
    return "error";
  }

  private handleOutput(stream: StreamName, text: string) {
    const run = this.activeRun;
    if (!run) {
      if (this.capture !== null) this.capture += text;
      return;
    }
    // File runs read from a stream, so GAP reports error locations as
    // "stream:LINE"; show the file name instead.
    if (run.kind === "file") {
      const name = run.label.split("/").pop() ?? run.label;
      text = text.replace(/\bstream:(\d+)/g, `${name}:$1`);
      if (/^(Error, |Syntax error)/m.test(text)) this.sawErrorText = true;
    }
    if (run.transcript && run.transcript.length > 0) {
      run.transcript[run.transcript.length - 1].output += text;
    }
    if (stream === "stdout") run.stdout += text;
    else run.stderr += text;
    this.options.events.runOutput(run.id, stream, text);
  }

  private handleReady() {
    const resolve = this.resolveReady;
    this.resolveReady = null;
    this.rejectReady = null;
    this.readyPromise = null;
    if (resolve) resolve();
  }

  private handleBreak() {
    // With -T this is normally GAP's pager, not a break loop. Try to leave it,
    // but do not wedge the session.
    this.breakCount += 1;
    if (this.breakCount <= 2) {
      this.child?.stdin.write("q\n");
    } else {
      this.sendInterrupt();
    }
  }

  private waitForReady(timeoutMs?: number): Promise<void> {
    if (this.state === "failed") {
      return Promise.reject(new Error("GAP failed to start."));
    }
    if (this.readyPromise) return this.readyPromise;

    const promise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.resolveReady = null;
        this.rejectReady = null;
        this.readyPromise = null;
        resolve();
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.resolveReady = null;
        this.rejectReady = null;
        this.readyPromise = null;
        reject(error);
      };
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(
              () => fail(new Error("Timed out waiting for GAP.")),
              timeoutMs
            );

      this.resolveReady = finish;
      this.rejectReady = fail;
    });
    this.readyPromise = promise;
    return promise;
  }

  private async writeAndWait(text: string, timeoutMs?: number): Promise<void> {
    const child = this.child;
    if (!child || child.stdin.destroyed) {
      throw new Error("The GAP session is not running.");
    }
    const ready = this.waitForReady(timeoutMs);
    child.stdin.write(text);
    await ready;
  }

  private rejectPendingReady(error: Error) {
    const reject = this.rejectReady;
    this.resolveReady = null;
    this.rejectReady = null;
    this.readyPromise = null;
    if (reject) reject(error);
  }

  private setState(state: SessionState, message?: string) {
    this.state = state;
    this.options.events.state(state, message);
  }
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
