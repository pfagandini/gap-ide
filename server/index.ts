import path from "node:path";
import fs from "node:fs";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { Project } from "./project";
import { GapSession } from "./gap";
import { renderRunsPdf } from "./pdf";
import type { ClientMsg, ServerMsg } from "../shared/types";

const execFileAsync = promisify(execFile);

function cliArg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

const root = path.resolve(cliArg("root", process.cwd()));
const gapPath = cliArg("gap", process.env.GAP_PATH || "gap");
const port = Number(cliArg("port", "3001"));
const project = new Project(root);

let gapVersion = "unknown";

async function detectGapVersion() {
  try {
    const { stdout } = await execFileAsync(gapPath, ["--version"], {
      timeout: 10_000
    });
    const match = stdout.match(/GAP\s+([0-9][^\s]*)/i);
    if (match) gapVersion = match[1];
    else gapVersion = stdout.trim().split("\n")[0] || "unknown";
  } catch {
    gapVersion = "not found";
  }
}

const app = Fastify({ logger: false, bodyLimit: 6 * 1024 * 1024 });
await app.register(fastifyWebsocket);
await detectGapVersion();

const clients = new Set<any>();

function broadcast(message: ServerMsg) {
  const data = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === 1) {
      try {
        client.send(data);
      } catch {
        clients.delete(client);
      }
    }
  }
}

const session = new GapSession({
  root,
  gapPath,
  events: {
    state: (state, message) => {
      broadcast({ type: "session_state", state, message });
    },
    runStarted: (run) => {
      broadcast({ type: "run_started", run });
    },
    runOutput: (runId, stream, text) => {
      broadcast({ type: "run_output", runId, stream, text });
    },
    runFinished: (run) => {
      broadcast({
        type: "run_finished",
        runId: run.id,
        status: run.status,
        endedAt: run.endedAt ?? Date.now(),
        durationMs: run.durationMs ?? 0
      });
    }
  }
});

app.get("/api/info", async () => ({
  root,
  gapPath,
  gapVersion,
  state: session.getState()
}));

app.get("/api/tree", async (request, reply) => {
  try {
    return await project.tree();
  } catch (error) {
    return reply.code(400).send({ error: messageOf(error) });
  }
});

app.get("/api/file", async (request, reply) => {
  const query = request.query as { path?: string };
  if (!query.path) return reply.code(400).send({ error: "Missing path." });
  try {
    return await project.readFile(query.path);
  } catch (error) {
    return reply.code(400).send({ error: messageOf(error) });
  }
});

app.put("/api/file", async (request, reply) => {
  const body = request.body as { path?: string; content?: string };
  if (!body.path || typeof body.content !== "string") {
    return reply.code(400).send({ error: "Expected { path, content }." });
  }
  try {
    return await project.writeFile(body.path, body.content);
  } catch (error) {
    return reply.code(400).send({ error: messageOf(error) });
  }
});

app.post("/api/file", async (request, reply) => {
  const body = request.body as { path?: string };
  if (!body.path) return reply.code(400).send({ error: "Missing path." });
  try {
    await project.createFile(body.path);
    return { ok: true, path: body.path };
  } catch (error) {
    return reply.code(400).send({ error: messageOf(error) });
  }
});

app.get("/api/download", async (request, reply) => {
  const query = request.query as { path?: string };
  if (!query.path) return reply.code(400).send({ error: "Missing path." });
  try {
    const full = await project.downloadPath(query.path);
    const name = path.basename(full).replace(/["\r\n]/g, "_");
    reply.header("Content-Disposition", `attachment; filename="${name}"`);
    reply.type("text/plain; charset=utf-8");
    return reply.send(createReadStream(full));
  } catch (error) {
    return reply.code(400).send({ error: messageOf(error) });
  }
});

app.post("/api/export/pdf", async (request, reply) => {
  const body = (request.body ?? {}) as {
    runIds?: string[];
    title?: string;
    author?: string;
    course?: string;
  };
  let runs = session.getRuns().filter((run) => run.status !== "running");
  if (Array.isArray(body.runIds) && body.runIds.length > 0) {
    const wanted = new Set(body.runIds);
    runs = runs.filter((run) => wanted.has(run.id));
  }
  if (runs.length === 0) {
    return reply.code(400).send({ error: "There are no completed runs to export." });
  }

  try {
    const pdf = await renderRunsPdf(runs, {
      title: body.title,
      author: body.author,
      course: body.course,
      gapVersion,
      root
    });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    reply.header(
      "Content-Disposition",
      `attachment; filename="gap-report-${stamp}.pdf"`
    );
    reply.type("application/pdf");
    return reply.send(pdf);
  } catch (error) {
    request.log.error(error);
    return reply.code(500).send({ error: messageOf(error) });
  }
});

app.get("/ws", { websocket: true }, (socket: any) => {
  clients.add(socket);
  socket.send(
    JSON.stringify({
      type: "hello",
      root,
      gapVersion,
      state: session.getState(),
      runs: session.getRuns()
    } satisfies ServerMsg)
  );

  socket.on("message", async (raw: Buffer | string) => {
    let message: ClientMsg;
    try {
      message = JSON.parse(raw.toString()) as ClientMsg;
    } catch {
      return;
    }

    try {
      if (message.type === "run_file") {
        if (session.isBusy()) {
          broadcast({ type: "error", message: "The GAP session is busy." });
          return;
        }
        const payload = await project.readFile(message.path);
        const full = await project.resolveExisting(message.path);
        await session.runFile(full, payload.content, message.path);
      } else if (message.type === "eval") {
        if (session.isBusy()) {
          broadcast({ type: "error", message: "The GAP session is busy." });
          return;
        }
        await session.eval(
          message.code,
          message.label,
          message.sourcePath,
          message.startLine
        );
      } else if (message.type === "interrupt") {
        await session.interrupt();
      } else if (message.type === "restart") {
        await session.restart();
      }
    } catch (error) {
      broadcast({ type: "error", message: messageOf(error) });
    }
  });

  socket.on("close", () => {
    clients.delete(socket);
  });
});

const dist = path.join(process.cwd(), "dist");
if (fs.existsSync(dist)) {
  await app.register(fastifyStatic, {
    root: dist,
    prefix: "/"
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api") || request.url.startsWith("/ws")) {
      return reply.code(404).send({ error: "Not found." });
    }
    return reply.sendFile("index.html");
  });
}

await app.listen({ host: "127.0.0.1", port });
console.log(`GAP IDE server: http://127.0.0.1:${port}`);
console.log(`Project root: ${root}`);
console.log(`GAP: ${gapPath} (${gapVersion})`);

void session.start();

const shutdown = async () => {
  await session.shutdown();
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
