import esbuild from "esbuild";
import { mkdir } from "fs/promises";
import os from "os";
import path from "path";
import process from "process";
import { fileURLToPath } from "url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(os.tmpdir(), "lotus-engine-smoke");
const outfile = path.join(outDir, "engine-smoke.mjs");

await mkdir(outDir, { recursive: true });
await esbuild.build({
  entryPoints: [path.join(rootDir, "scripts", "engine-smoke.ts")],
  bundle: true,
  outfile,
  format: "esm",
  platform: "node",
  target: "es2022",
  sourcemap: false,
  legalComments: "none",
  logLevel: "silent",
});

await import(`file://${outfile}?${Date.now()}`);
