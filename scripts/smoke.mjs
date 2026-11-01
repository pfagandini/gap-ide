// End-to-end smoke test against a running server (`npm start`, or
// `tsx server/index.ts --port N` with GAP_IDE_PORT=N). Checks, in order:
// session ready, file run (paths reach GAP), eval, interrupt + recovery,
// PDF export, LaTeX export. Used in CI on Linux, macOS and Windows.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const port = process.env.GAP_IDE_PORT || "3001";
const base = `http://127.0.0.1:${port}`;
const READY_TIMEOUT = Number(process.env.GAP_IDE_READY_TIMEOUT || 120_000);

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};

// The server refuses WebSockets without a local Origin (see server/app.ts).
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: base });
ws.on("error", () => fail(`could not connect; is the server running on ${base}?`));

let state = "starting";
let stateWaiters = [];
const runs = new Map(); // id -> { stdout, stderr, status }
let finishWaiter = null;

ws.on("message", (data) => {
  const message = JSON.parse(data.toString());
  if (message.type === "hello" || message.type === "session_state") {
    state = message.state;
    if (message.type === "session_state" && message.state === "failed") {
      fail(`GAP session failed: ${message.message}`);
    }
    stateWaiters = stateWaiters.filter((waiter) => !waiter());
  } else if (message.type === "run_started") {
    runs.set(message.run.id, { stdout: "", stderr: "", status: "running" });
  } else if (message.type === "run_output") {
    const run = runs.get(message.runId);
    if (run) run[message.stream] += message.text;
  } else if (message.type === "run_finished") {
    const run = runs.get(message.runId);
    if (run) run.status = message.status;
    if (finishWaiter) finishWaiter(message.runId);
  } else if (message.type === "error") {
    fail(`server error: ${message.message}`);
  }
});

const waitIdle = (timeout) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`not idle after ${timeout} ms (state ${state})`)), timeout);
    const check = () => {
      if (state !== "idle") return false;
      clearTimeout(timer);
      resolve();
      return true;
    };
    if (!check()) stateWaiters.push(check);
  });

/** Sends a message that starts one run; resolves with that run when it finishes. */
const runOnce = (message, timeout = 60_000, onStart) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`run timed out: ${JSON.stringify(message)}`)), timeout);
    finishWaiter = (id) => {
      clearTimeout(timer);
      finishWaiter = null;
      resolve({ id, ...runs.get(id) });
    };
    ws.send(JSON.stringify(message));
    if (onStart) onStart();
  });

const step = async (name, body) => {
  try {
    await body();
    console.log(`ok   ${name}`);
  } catch (error) {
    fail(`${name}: ${error instanceof Error ? error.message : error}`);
  }
};

await new Promise((resolve) => ws.on("open", resolve));

await step("GAP session ready", () => waitIdle(READY_TIMEOUT));

let fileRunId;
await step("run file examples/demo.g", async () => {
  const run = await runOnce({ type: "run_file", path: "examples/demo.g" });
  if (run.status !== "ok") throw new Error(`status ${run.status}: ${run.stderr || run.stdout}`);
  if (!run.stdout.includes("Order of S5: 120")) throw new Error(`unexpected output: ${run.stdout}`);
  fileRunId = run.id;
});

let evalRunId;
await step("eval 2+2", async () => {
  await waitIdle(10_000);
  const run = await runOnce({ type: "eval", code: "x := 2+2;", label: "smoke" });
  if (run.stdout.trim() !== "4") throw new Error(`expected 4, got ${JSON.stringify(run.stdout)}`);
  evalRunId = run.id;
});

await step("interrupt a long loop", async () => {
  await waitIdle(10_000);
  const run = await runOnce(
    { type: "eval", code: "for i in [1..10^10] do od;", label: "loop" },
    60_000,
    () => setTimeout(() => ws.send(JSON.stringify({ type: "interrupt" })), 2000)
  );
  if (run.status !== "interrupted") throw new Error(`status ${run.status}`);
});

await step("session usable after interrupt", async () => {
  await waitIdle(30_000);
  const run = await runOnce({ type: "eval", code: "x * 3;", label: "after" });
  if (run.stdout.trim() !== "12") throw new Error(`expected 12, got ${JSON.stringify(run.stdout)}`);
});

await step("PDF export", async () => {
  const response = await fetch(`${base}/api/export/pdf`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runIds: [fileRunId, evalRunId], title: "Smoke test", author: "GAP IDE" })
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  const pdf = Buffer.from(await response.arrayBuffer());
  if (pdf.subarray(0, 4).toString() !== "%PDF") throw new Error("not a PDF");
  const out = path.join(os.tmpdir(), "gap-ide-smoke.pdf");
  fs.writeFileSync(out, pdf);
  console.log(`     ${pdf.length} bytes -> ${out}`);
});

await step("LaTeX export", async () => {
  const response = await fetch(`${base}/api/export/latex`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runIds: [evalRunId] })
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  const { text } = await response.json();
  if (!text.includes("gap> x := 2+2;\n4\n")) throw new Error(`unexpected: ${text}`);
});

console.log("OK: all smoke checks passed");
ws.close();
process.exit(0);
