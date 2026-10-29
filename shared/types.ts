export type SessionState = "starting" | "idle" | "running" | "exited" | "failed";
export type RunKind = "file" | "console";
export type RunStatus = "running" | "ok" | "error" | "interrupted" | "exited";

export interface Run {
  id: string;
  kind: RunKind;
  label: string;
  sourcePath?: string;
  startLine?: number;
  code: string;
  stdout: string;
  stderr: string;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
}

export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: TreeNode[];
}

export interface FilePayload {
  path: string;
  content: string;
  mtimeMs: number;
}

export type ClientMsg =
  | { type: "run_file"; path: string }
  | {
      type: "eval";
      code: string;
      label: string;
      sourcePath?: string;
      startLine?: number;
    }
  | { type: "interrupt" }
  | { type: "restart" };

export type ServerMsg =
  | {
      type: "hello";
      root: string;
      gapVersion: string;
      state: SessionState;
      runs: Run[];
    }
  | { type: "run_started"; run: Run }
  | {
      type: "run_output";
      runId: string;
      stream: "stdout" | "stderr";
      text: string;
    }
  | {
      type: "run_finished";
      runId: string;
      status: RunStatus;
      endedAt: number;
      durationMs: number;
    }
  | { type: "session_state"; state: SessionState; message?: string }
  | { type: "error"; message: string };
