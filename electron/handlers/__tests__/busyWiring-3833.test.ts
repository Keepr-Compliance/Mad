/**
 * BACKLOG-3833: each long user-started operation is registered through
 * `handleBusy` (so it holds a busy token while it runs), not plain
 * `ipcMain.handle`.
 *
 * Each handler module's other imports are replaced by inert stubs (read from
 * the module's own import list), so only the registration calls are observed.
 */
import * as fs from "fs";
import * as path from "path";

const HANDLERS_DIR = path.resolve(__dirname, "..");

const CASES: Array<{ file: string; register: string; channels: string[] }> = [
  { file: "syncHandlers", register: "registerSyncHandlers", channels: ["sync:start"] },
  { file: "messageImportHandlers", register: "registerMessageImportHandlers", channels: ["messages:import-macos"] },
  {
    file: "emailSyncHandlers",
    register: "registerEmailSyncHandlers",
    channels: ["transactions:scan", "transactions:sync-and-fetch-emails"],
  },
  {
    file: "transactionExportHandlers",
    register: "registerTransactionExportHandlers",
    channels: ["transactions:export-pdf", "transactions:export-enhanced", "transactions:export-folder"],
  },
  { file: "ccpaHandlers", register: "registerCcpaHandlers", channels: ["privacy:export-data"] },
];

/**
 * A callable, chainable stub: every property and call returns another stub.
 * `then` is a no-op so `.then(...)` chains work and never call back.
 */
function inert(): unknown {
  const cache = new Map<PropertyKey, unknown>();
  const target = function () {} as unknown as object;
  const proxy: unknown = new Proxy(target, {
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
  return proxy;
}

function importSpecifiers(file: string): string[] {
  const src = fs.readFileSync(path.join(HANDLERS_DIR, `${file}.ts`), "utf8");
  const specs = new Set<string>();
  for (const m of src.matchAll(/(?:from|import)\s+"([^"]+)"/g)) specs.add(m[1]);
  return [...specs];
}

describe("busy wiring of long user-started IPC handlers (BACKLOG-3833)", () => {
  it.each(CASES.map((c) => [c.file, c]))("%s registers its long operations through handleBusy", (_name, c) => {
    const busyChannels: string[] = [];
    const plainChannels: string[] = [];
    jest.resetModules();
    jest.isolateModules(() => {
      for (const spec of importSpecifiers(c.file)) {
        if (spec === "electron" || spec === "../utils/busyIpc") continue;
        const target = spec.startsWith(".") ? path.resolve(HANDLERS_DIR, spec) : spec;
        jest.doMock(target, () => inert());
      }
      const electronStub = inert() as Record<string, unknown>;
      jest.doMock("electron", () => ({
        __esModule: true,
        ...{ BrowserWindow: electronStub, dialog: electronStub, shell: electronStub, app: electronStub },
        ipcMain: new Proxy(inert() as object, {
          get: (t, prop) =>
            prop === "handle"
              ? (ch: string) => plainChannels.push(ch)
              : (t as Record<PropertyKey, unknown>)[prop],
        }),
      }));
      jest.doMock(path.resolve(HANDLERS_DIR, "../utils/busyIpc"), () => ({
        handleBusy: (ch: string) => busyChannels.push(ch),
      }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(path.join(HANDLERS_DIR, c.file));
      mod[c.register](inert(), "user-1");
    });
    for (const ch of c.channels) {
      expect(busyChannels).toContain(ch);
      expect(plainChannels).not.toContain(ch);
    }
  });
});
