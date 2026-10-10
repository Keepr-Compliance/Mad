/**
 * Worker thread for sealing the kept iPhone backup (BACKLOG-3816). All logic is in
 * sealEngine.ts; this file only moves messages. Started by sealPool.ts with
 * workerData = { key, keyId, chunkSize, stop }. `stop` is a shared flag the main thread
 * sets to pause the pass at the next file boundary.
 */
import { parentPort, workerData } from "worker_threads";

import { createSealEngine, type SealMode } from "./sealEngine";

interface Init {
  key: Uint8Array;
  keyId: string;
  chunkSize: number;
  stop: SharedArrayBuffer;
  /** Benchmark only (see SealEngineOptions.skipDataFsyncForMeasurement). */
  skipDataFsyncForMeasurement?: boolean;
}

const init = workerData as Init;
const stop = new Int32Array(init.stop);
// The key arrives as a structured-clone copy; the engine keeps its own copy and zeroes it on dispose.
const engine = createSealEngine({ keyId: init.keyId, key: Buffer.from(init.key) }, {
  chunkSize: init.chunkSize,
  skipDataFsyncForMeasurement: init.skipDataFsyncForMeasurement === true,
});
init.key.fill(0);

parentPort?.on("message", (msg: { type: "batch"; id: number; files: string[]; mode: SealMode } | { type: "close" }) => {
  if (msg.type === "close") {
    engine.dispose();
    parentPort?.close();
    return;
  }
  const result = engine.runBatch(msg.files, msg.mode, () => Atomics.load(stop, 0) === 1);
  parentPort?.postMessage({ type: "result", id: msg.id, ...result });
});
