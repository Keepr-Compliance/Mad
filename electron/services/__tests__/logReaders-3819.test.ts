/**
 * @jest-environment node
 */
/**
 * BACKLOG-3819 — every reader of the desktop log decrypts.
 *
 * Readers found (plan comment on BACKLOG-3819): electron-log's own
 * `transports.file.readAllLogs()`, the new "Save diagnostic log" export
 * (builder + IPC handler), and the QA harness (scripts/qa/harness, tested in its
 * own suite). Temp directories and a fixed test key only.
 */
import fs from "fs";
import os from "os";
import path from "path";

const KEY = { keyId: "44".repeat(16), key: Buffer.alloc(32, 4) };
const FOREIGN = { keyId: "55".repeat(16), key: Buffer.alloc(32, 5) };

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
let saveTarget = "";
jest.mock("electron", () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => Promise<unknown>) => handlers.set(ch, fn) },
  dialog: { showSaveDialog: jest.fn(async () => ({ canceled: false, filePath: saveTarget })) },
  BrowserWindow: { fromWebContents: () => null, getFocusedWindow: () => null },
  app: { getPath: () => os.tmpdir() },
}));
jest.mock("../atRest/dataKeyService", () => ({
  getDataKeyService: () => ({ currentKey: async () => KEY }),
}));

import { SealedLogSink, resetLogSinkForTests } from "../sealedLogSink";
import { sealLogText } from "../atRest/sealedLog";
import { createSealedFileTransport } from "../../config/sealedLogTransport";
import { buildDiagnosticLogText } from "../diagnosticLogExport";
import { setLogDirectoryResolver } from "../logScrub";
import { registerDiagnosticLogHandlers, SAVE_DIAGNOSTIC_LOG_CHANNEL } from "../../handlers/diagnosticLogHandlers";

let dir: string;
let main: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-readers-"));
  main = path.join(dir, "main.log");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  setLogDirectoryResolver(null);
  resetLogSinkForTests(null);
});

function fakeInner() {
  const fn = Object.assign(() => undefined, {
    level: "info",
    maxSize: 0,
    transforms: [({ data }: { data: unknown[] }) => data.join(" ")],
    getFile: () => ({ path: main }),
  });
  return fn;
}

describe("BACKLOG-3819 log readers decrypt", () => {
  it("transports.file.readAllLogs() returns decrypted lines, not ciphertext", () => {
    const sink = new SealedLogSink({ report: () => undefined });
    sink.activate(KEY);
    const t = createSealedFileTransport({ transports: {} }, fakeInner() as never, sink);
    t({ data: ["readable via readAllLogs"], level: "info", date: new Date() } as never);
    const logs = t.readAllLogs();
    const mainLog = logs.find((l) => l.path === main)!;
    expect(mainLog.lines.join("\n")).toContain("readable via readAllLogs");
    expect(fs.readFileSync(main).includes(Buffer.from("readable via readAllLogs"))).toBe(false);
  });

  it("the transport writes through the sink: the formatted line is sealed, the original transport never writes", () => {
    const sink = new SealedLogSink({ report: () => undefined });
    sink.activate(KEY);
    const inner = fakeInner();
    const logger = { transports: { file: inner as unknown } };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require("../../config/sealedLogTransport").installSealedFileTransport(logger, sink);
    expect(logger.transports.file).not.toBe(inner);
    (logger.transports.file as (m: unknown) => void)({ data: ["through", "sink"], level: "info", date: new Date() });
    // forwarded config: a write to maxSize reaches the original object
    (logger.transports.file as unknown as { maxSize: number }).maxSize = 123;
    expect(inner.maxSize).toBe(123);
    const raw = fs.readFileSync(main);
    expect(raw.subarray(0, 7).toString()).toBe("KEPRLOG");
    expect(raw.includes(Buffer.from("through sink"))).toBe(false);
  });

  it("Save diagnostic log: readable, redacted text from sealed + fallback + in-memory, oldest first", () => {
    fs.writeFileSync(path.join(dir, "main.old.log"), sealLogText("[old] archived line\n", KEY));
    fs.writeFileSync(main, sealLogText("[cur] current line dana@example.com\n", KEY));
    fs.writeFileSync(path.join(dir, "main.unsealed.log"), "[fallback] plain line\n");
    const built = buildDiagnosticLogText(dir, {
      keyFor: (id) => (id === KEY.keyId ? KEY.key : null),
      pending: [{ file: main, text: "[mem] held line +15555550123\n" }],
    });
    const t = built.text;
    expect(t).toContain("[old] archived line");
    expect(t).toContain("[cur] current line d***@example.com");
    expect(t).not.toContain("dana@example.com");
    expect(t).toContain("[fallback] plain line");
    expect(t).toContain("[mem] held line ***23");
    expect(t.indexOf("[old]")).toBeLessThan(t.indexOf("[cur]"));
    expect(t.indexOf("[cur]")).toBeLessThan(t.indexOf("[fallback]"));
    expect(t).not.toContain("KEPRLOG");
  });

  it("Save diagnostic log: a file under a key this computer does not hold is named, never emitted", () => {
    const foreign = sealLogText("[x] secret line\n", FOREIGN);
    fs.writeFileSync(path.join(dir, "main.old.log"), foreign);
    const built = buildDiagnosticLogText(dir, { keyFor: (id) => (id === KEY.keyId ? KEY.key : null) });
    expect(built.files).toEqual([expect.objectContaining({ name: "main.old.log", status: "unreadable" })]);
    expect(built.text).toContain("does not hold");
    expect(built.text).not.toContain("secret line");
    expect(built.text.includes(foreign.subarray(48).toString("utf8"))).toBe(false);
  });

  it("IPC system:save-diagnostic-log writes the decrypted, redacted copy to the chosen file", async () => {
    fs.writeFileSync(main, sealLogText("[ipc] sealed line erin@example.com\n", KEY));
    setLogDirectoryResolver(() => dir);
    saveTarget = path.join(dir, "export", "saved.txt");
    fs.mkdirSync(path.dirname(saveTarget));
    registerDiagnosticLogHandlers();
    const handler = handlers.get(SAVE_DIAGNOSTIC_LOG_CHANNEL)!;
    const result = (await handler({ sender: {} })) as { success: boolean; filePath: string; unreadable: string[] };
    expect(result).toEqual(expect.objectContaining({ success: true, filePath: saveTarget, unreadable: [] }));
    const saved = fs.readFileSync(saveTarget, "utf8");
    expect(saved).toContain("[ipc] sealed line e***@example.com");
    expect(saved).not.toContain("erin@example.com");
  });
});
