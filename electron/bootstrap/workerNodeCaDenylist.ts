/**
 * Side-effect import (BACKLOG-4052) for worker threads: each thread has its
 * own Node CA store, so the main process's filter does not reach a worker.
 * First import in sealWorker.ts and contactQueryWorker.ts. Fails open.
 */
import { applyNodeCaDenylist } from "./nodeCaDenylist";

try {
  applyNodeCaDenylist();
} catch {
  // A worker must never fail to start over this; none does network today.
}
