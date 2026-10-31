/**
 * Side-effect bootstrap (BACKLOG-4052): remove the denylisted roots from the
 * main process's Node CA store. Imported from main.ts as import #2, directly
 * after installAppDataPaths (which sets the log path this writes to) and
 * before installSentry, installMainNetAxios and every handler: the change
 * only applies to connections opened after it. Placement is pinned by
 * bootstrap/__tests__/nodeCaDenylist-4052.test.ts.
 *
 * Fails open: an error is logged and recorded for installSentry to report;
 * it never stops the app from starting.
 */
import log from "electron-log";
import { activeSocketHandles, applyNodeCaDenylist, recordNodeCaDenylistFailure } from "./nodeCaDenylist";

try {
  const early = activeSocketHandles();
  const r = applyNodeCaDenylist();
  log.info(`[NodeCaDenylist] node CA store ${r.before} -> ${r.after}, removed: ${r.removedNames.join(", ") || "none"}`);
  if (early.length > 0) {
    log.warn(`[NodeCaDenylist] network handles were already open before the filter: ${early.join(", ")}`);
  }
} catch (err) {
  recordNodeCaDenylistFailure(err);
  log.error("[NodeCaDenylist] install failed", err);
}
