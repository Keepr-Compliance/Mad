/**
 * BACKLOG-3456: registerTransactionExportHandlers starts the submission-status
 * pollers when (and only when) it is called with `startSubmissionSync: true`.
 *
 * Loads the real transactionExportHandlers module with every import replaced by
 * an inert stub, except submissionSyncService, which is a spy.
 */
import * as fs from "fs";
import * as path from "path";

const HANDLERS_DIR = path.resolve(__dirname, "..");

/** A callable, chainable stub: every property and call returns another stub. */
function inert(): unknown {
  const cache = new Map<PropertyKey, unknown>();
  return new Proxy(function () {} as unknown as object, {
    get(_t, prop) {
      if (prop === "then") return () => inert();
      if (prop === "__esModule") return true;
      if (prop === Symbol.toPrimitive) return () => "";
      if (prop === Symbol.iterator) return undefined;
      if (!cache.has(prop)) cache.set(prop, inert());
      return cache.get(prop);
    },
    apply: () => inert(),
    construct: () => inert() as object,
  });
}

function register(startSubmissionSync: boolean): jest.Mock {
  const startPeriodicSync = jest.fn();
  jest.resetModules();
  jest.isolateModules(() => {
    const src = fs.readFileSync(path.join(HANDLERS_DIR, "transactionExportHandlers.ts"), "utf8");
    let sawSyncService = false;
    for (const m of src.matchAll(/(?:from|import)\s+"([^"]+)"/g)) {
      const spec = m[1];
      if (spec === "electron") continue;
      const target = spec.startsWith(".") ? path.resolve(HANDLERS_DIR, spec) : spec;
      let resolvable = true;
      try {
        require.resolve(target);
      } catch {
        resolvable = false;
      }
      if (/submissionSyncService$/.test(spec)) {
        sawSyncService = true;
        const svc = { startPeriodicSync, startRealtimeSubscription: jest.fn() };
        jest.doMock(target, () => ({ __esModule: true, default: svc, submissionSyncService: svc }), {
          virtual: !resolvable,
        });
      } else {
        jest.doMock(target, () => inert(), { virtual: !resolvable });
      }
    }
    expect(sawSyncService).toBe(true);
    jest.doMock("electron", () => ({
      __esModule: true,
      ipcMain: inert(),
      BrowserWindow: inert(),
      dialog: inert(),
      shell: inert(),
      app: inert(),
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require(path.join(HANDLERS_DIR, "transactionExportHandlers")).registerTransactionExportHandlers({
      startSubmissionSync,
    });
  });
  return startPeriodicSync;
}

describe("submission-sync start option (BACKLOG-3456)", () => {
  it("startSubmissionSync: true starts the periodic sync once, at 60 s", () => {
    const spy = register(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(60000);
  });

  it("startSubmissionSync: false starts no poller", () => {
    expect(register(false)).not.toHaveBeenCalled();
  });

  it("main.ts registers the export handlers with startSubmissionSync: true, once", () => {
    const main = fs.readFileSync(path.join(__dirname, "..", "..", "main.ts"), "utf8");
    const re = /^\s*registerTransactionExportHandlers\(\{ startSubmissionSync: true \}\);/gm;
    expect(main.match(re)).toHaveLength(1);
  });
});
