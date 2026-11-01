// Command-line entry: `tsx server/index.ts [--root DIR] [--gap PATH] [--port N]`.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./app";
import { resolveLauncher } from "./launcher";

function cliArg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

const root = path.resolve(cliArg("root", process.cwd()));
const gapArg = cliArg("gap", process.env.GAP_PATH || "");
const launcher = resolveLauncher(gapArg ? { mode: "auto", path: gapArg } : { mode: "auto" });
const here = path.dirname(fileURLToPath(import.meta.url));

const server = await startServer({
  root,
  launcher,
  port: Number(cliArg("port", "3001")),
  distDir: path.join(here, "..", "dist"),
  devWebPort: 5173
});

console.log(`GAP IDE server: ${server.url}`);
console.log(`Project root: ${root}`);
console.log(`GAP: ${"error" in launcher ? launcher.error : launcher.description}`);

const shutdown = async () => {
  await server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
