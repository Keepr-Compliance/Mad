#!/usr/bin/env node
/**
 * BACKLOG-3816: bundle the backup-seal benchmark into ONE file runnable by plain Node >= 20
 * (no Keepr install, no node_modules). Output: dist-bench/backup-seal-bench.js
 * Usage on the target machine: node backup-seal-bench.js <srcDir> <workDir> [--delta 3] [--profile]
 */
import { build } from "esbuild";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const outdir = path.join(root, "dist-bench");
const stub = (name) => path.join(here, "stubs", name);

const stubs = {
  name: "bench-stubs",
  setup(b) {
    b.onResolve({ filter: /^simple-plist$/ }, () => ({ path: stub("simple-plist.js") }));
    b.onResolve({ filter: /(^|\/)backupDecryptionService$/ }, () => ({ path: stub("backupDecryptionService.js") }));
    b.onResolve({ filter: /(^|\/)dataKeyService$/ }, () => ({ path: stub("dataKeyService.js") }));
  },
};

const common = { bundle: true, platform: "node", target: "node20", format: "cjs", plugins: [stubs], external: ["electron"], logLevel: "warning" };
// The seal worker is bundled first and inlined as a string, so the benchmark is ONE file;
// at run time it is written next to the run's work folder and started from there.
const worker = await build({ ...common, entryPoints: [path.join(root, "electron/services/atRest/sealWorker.ts")], write: false });
await build({
  ...common,
  entryPoints: [path.join(here, "backupSealBench.ts")],
  outfile: path.join(outdir, "backup-seal-bench.js"),
  define: { __SEAL_WORKER_SOURCE__: JSON.stringify(worker.outputFiles[0].text) },
});
console.log(`built ${path.relative(root, path.join(outdir, "backup-seal-bench.js"))}`);
