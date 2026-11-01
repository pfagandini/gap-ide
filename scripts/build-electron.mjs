// Bundles the Electron main process (electron/main.ts + server/*) into one
// CommonJS file. npm packages stay external: electron-builder ships them from
// node_modules (only "dependencies", not devDependencies).
import { build } from "esbuild";

await build({
  entryPoints: ["electron/main.ts"],
  outfile: "dist-electron/main.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  packages: "external",
  sourcemap: true,
  logLevel: "info"
});
