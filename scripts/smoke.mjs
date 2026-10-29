// End-to-end smoke test. Start the server first (`npm start` or `npm run dev`),
// then run `npm run smoke`.
import fs from "node:fs";
import WebSocket from "ws";

const ws = new WebSocket("ws://127.0.0.1:3001/ws");
let runId = null;
let stdout = "";
let stderr = "";

const timeout = setTimeout(() => {
  console.error("Timed out");
  process.exit(1);
}, 20_000);

ws.on("message", async (data) => {
  const message = JSON.parse(data.toString());

  if (message.type === "hello") {
    console.log("Connected to GAP", message.gapVersion);
    ws.send(JSON.stringify({ type: "run_file", path: "examples/demo.g" }));
    return;
  }

  if (message.type === "run_started") {
    runId = message.run.id;
    return;
  }

  if (message.type === "run_output") {
    if (message.stream === "stdout") stdout += message.text;
    else stderr += message.text;
    return;
  }

  if (message.type === "run_finished") {
    if (message.status !== "ok") {
      console.error("Run failed:", message.status, stderr);
      process.exit(1);
    }
    if (!stdout.includes("Order of S5: 120")) {
      console.error("Unexpected output:", stdout);
      process.exit(1);
    }

    const response = await fetch("http://127.0.0.1:3001/api/export/pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runIds: [runId],
        title: "Smoke test",
        author: "GAP IDE"
      })
    });
    if (!response.ok) {
      console.error("PDF export failed:", response.status, await response.text());
      process.exit(1);
    }
    const pdf = Buffer.from(await response.arrayBuffer());
    if (pdf.subarray(0, 4).toString() !== "%PDF") {
      console.error("Not a PDF");
      process.exit(1);
    }
    fs.writeFileSync("/tmp/gap-ide-smoke.pdf", pdf);
    console.log(`OK: run output and PDF (${pdf.length} bytes) -> /tmp/gap-ide-smoke.pdf`);
    clearTimeout(timeout);
    ws.close();
    process.exit(0);
  }

  if (message.type === "error") {
    console.error("Server error:", message.message);
    process.exit(1);
  }
});

ws.on("error", () => {
  console.error("Could not connect. Is the server running on 127.0.0.1:3001?");
  process.exit(1);
});
