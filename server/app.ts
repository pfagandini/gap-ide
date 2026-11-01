import path from "node:path";
import fs from "node:fs";
import { createReadStream } from "node:fs";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { Project } from "./project";
import { GapSession } from "./gap";
import { renderRunsPdf } from "./pdf";
import { runsToLatexVerbatim } from "./latex";
import type { ClientMsg, ServerMsg } from "../shared/types";
import type { GapLauncher } from "./launcher";

export interface ServerOptions {
  root: string;
  launcher: GapLauncher | { error: string };
  /** 0 picks a free port. */
  port: number;
  /** Built frontend (vite's dist/); served if it exists. */
  distDir: string;
  /** Extra local origin port allowed (the vite dev server). */
  devWebPort?: number;
}

export interface RunningServer {
  port: number;
  url: string;
  close: () => Promise<void>;
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const root = path.resolve(options.root);
  const project = new Project(root);

  const app = Fastify({ logger: false, bodyLimit: 6 * 1024 * 1024 });

  // The server runs GAP code and reads/writes files, so it must only answer the
  // local IDE page. Two attacks are blocked here:
  // - Cross-site requests: any web page can open ws://127.0.0.1:<port>/ws (the
  //   browser allows cross-origin WebSockets) and send GAP code, which can run
  //   shell commands via Exec(). Requests carrying a foreign Origin are refused.
  // - DNS rebinding: a hostile domain re-pointed at 127.0.0.1 becomes "same
  //   origin" with itself. Its requests carry its own Host header, so only
  //   loopback Host names are accepted.
  const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
  // Filled in once the port is known (port 0 = any free port).
  const allowedPorts = new Set<string>();
  if (options.devWebPort) allowedPorts.add(String(options.devWebPort));

  function isLoopbackAuthority(authority: string | undefined): boolean {
    if (!authority) return false;
    const match = authority.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
    if (!match) return false;
    const [, host, hostPort] = match;
    return LOOPBACK_HOSTS.has(host.toLowerCase()) && allowedPorts.has(hostPort ?? "80");
  }

  app.addHook("onRequest", async (request, reply) => {
    if (!isLoopbackAuthority(request.headers.host)) {
      return reply.code(403).send({ error: "Forbidden host." });
    }
    const origin = request.headers.origin;
    if (origin !== undefined) {
      let ok = false;
      try {
        const url = new URL(origin);
        ok = url.protocol === "http:" && isLoopbackAuthority(url.host);
      } catch {
        ok = false;
      }
      if (!ok) return reply.code(403).send({ error: "Forbidden origin." });
    }
    // WebSocket upgrades from a browser always carry Origin; refuse any that do not.
    if (request.headers.upgrade && origin === undefined) {
      return reply.code(403).send({ error: "Missing origin." });
    }
  });

  await app.register(fastifyWebsocket);

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
    launcher: options.launcher,
    events: {
      state: (state, message) => {
        broadcast({ type: "session_state", state, message, gapVersion: session.getVersion() });
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
    gapPath: session.describeLauncher(),
    gapVersion: session.getVersion(),
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
        gapVersion: session.getVersion(),
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

  // The given runs, in the given order, as a LaTeX verbatim GAP transcript.
  app.post("/api/export/latex", async (request, reply) => {
    const body = (request.body ?? {}) as { runIds?: unknown };
    if (!Array.isArray(body.runIds)) {
      return reply.code(400).send({ error: "Expected { runIds: [...] }." });
    }
    const byId = new Map(session.getRuns().map((run) => [run.id, run]));
    const runs = body.runIds
      .map((id) => byId.get(String(id)))
      .filter((run): run is NonNullable<typeof run> => !!run && run.status !== "running");
    if (runs.length === 0) {
      return reply.code(400).send({ error: "There are no completed runs to export." });
    }
    return { text: runsToLatexVerbatim(runs) };
  });

  app.get("/ws", { websocket: true }, (socket: any) => {
    clients.add(socket);
    socket.send(
      JSON.stringify({
        type: "hello",
        root,
        gapVersion: session.getVersion(),
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
        } else if (message.type === "eval_blocks") {
          // "Run all cells": evaluate each block as its own run, so its output
          // can be shown under that block. Like pasting into GAP, an error does
          // not stop the rest; Stop (interrupt) does.
          if (session.isBusy()) {
            broadcast({ type: "error", message: "The GAP session is busy." });
            return;
          }
          if (typeof message.sourcePath !== "string" || !Array.isArray(message.blocks)) return;
          for (const block of message.blocks) {
            if (typeof block?.code !== "string" || typeof block.startLine !== "number") continue;
            const run = await session.eval(
              block.code,
              String(block.label ?? ""),
              message.sourcePath,
              block.startLine
            );
            if (run.status === "interrupted" || run.status === "exited") break;
          }
        } else if (message.type === "clear_runs") {
          if (message.kind !== "file" && message.kind !== "console") return;
          session.clearRuns(message.kind);
          broadcast({ type: "runs_cleared", kind: message.kind });
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

  const dist = options.distDir;
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

  await app.listen({ host: "127.0.0.1", port: options.port });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  allowedPorts.add(String(port));

  void session.start();

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      await session.shutdown();
      await app.close();
    }
  };
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
