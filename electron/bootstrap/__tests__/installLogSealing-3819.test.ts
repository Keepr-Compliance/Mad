/**
 * @jest-environment node
 */
/**
 * BACKLOG-3819 (decision dc27e73c) — packaged builds seal logs at rest; dev
 * (unpackaged) builds keep electron-log's own transport, so their logs are
 * redacted plaintext. Temp directories and a fixed test key only.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { installLogSealing, prepareDevLogFile } from "../installLogSealing";
import { isSealedFileTransport } from "../../config/sealedLogTransport";
import {
  SealedLogSink,
  isLogSealingEnabled,
  resetLogSinkForTests,
} from "../../services/sealedLogSink";
import { isSealedLog, openSealedLog, sealLogText } from "../../services/atRest/sealedLog";
import { buildDiagnosticLogText } from "../../services/diagnosticLogExport";

const KEY = { keyId: "88".repeat(16), key: Buffer.alloc(32, 8) };

let dir: string;
let main: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-logseal-"));
  main = path.join(dir, "main.log");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  resetLogSinkForTests(null);
});

/** Stands in for electron-log's file transport: appends the line as plaintext. */
function plainTransport() {
  return Object.assign(
    (message: { data: unknown[] }) => fs.appendFileSync(main, `${message.data.join(" ")}\n`),
    {
      level: "info",
      maxSize: 0,
      transforms: [({ data }: { data: unknown[] }) => data.join(" ")],
      getFile: () => ({ path: main }),
    },
  );
}

function write(logger: { transports: Record<string, unknown> }, text: string): void {
  (logger.transports.file as (m: unknown) => void)({ data: [text], level: "info", date: new Date() });
}

describe("BACKLOG-3819 log sealing gate", () => {
  it("unpackaged (dev): electron-log's transport is kept, sealing is off, lines are plaintext", () => {
    const inner = plainTransport();
    const logger = { transports: { file: inner as unknown } };
    const onExit = jest.fn();
    expect(installLogSealing(logger, { isPackaged: false, sink: new SealedLogSink(), onExit })).toBe(false);
    expect(logger.transports.file).toBe(inner);
    expect(isSealedFileTransport(logger.transports.file)).toBe(false);
    expect(isLogSealingEnabled()).toBe(false);
    expect(onExit).not.toHaveBeenCalled();
    write(logger, "[2099-01-01 00:00:00.000] [info] dev line");
    const raw = fs.readFileSync(main);
    expect(isSealedLog(raw)).toBe(false);
    expect(raw.toString("utf8")).toContain("dev line");
  });

  it("packaged: the sealing transport replaces it and lines reach disk sealed", () => {
    const sink = new SealedLogSink({ report: () => undefined });
    const logger = { transports: { file: plainTransport() as unknown } };
    const onExit = jest.fn();
    expect(installLogSealing(logger, { isPackaged: true, sink, onExit })).toBe(true);
    expect(isSealedFileTransport(logger.transports.file)).toBe(true);
    expect(isLogSealingEnabled()).toBe(true);
    expect(onExit).toHaveBeenCalledTimes(1);
    sink.activate(KEY);
    write(logger, "[2099-01-01 00:00:00.000] [info] packaged line");
    const raw = fs.readFileSync(main);
    expect(isSealedLog(raw)).toBe(true);
    expect(raw.includes(Buffer.from("packaged line"))).toBe(false);
    expect(openSealedLog(raw, () => KEY.key).text).toContain("packaged line");
  });

  it("dev: a live log sealed by an earlier build is moved aside, stays readable, and new plaintext starts fresh", () => {
    fs.writeFileSync(main, sealLogText("[2099-01-01 00:00:00.000] [info] sealed earlier\n", KEY));
    const logger = { transports: { file: plainTransport() as unknown } };
    installLogSealing(logger, { isPackaged: false, sink: new SealedLogSink() });
    const aside = prepareDevLogFile(logger);
    expect(aside).not.toBeNull();
    expect(path.basename(aside as string)).toMatch(/^main\.sealed-\d{8}T\d{6}\.old\.log$/);
    expect(fs.existsSync(main)).toBe(false);
    write(logger, "[2099-01-01 00:00:01.000] [info] dev plaintext after");
    expect(isSealedLog(fs.readFileSync(main))).toBe(false);
    const built = buildDiagnosticLogText(dir, { keyFor: (id) => (id === KEY.keyId ? KEY.key : null) });
    expect(built.text).toContain("sealed earlier");
    expect(built.text).toContain("dev plaintext after");
    expect(built.files.every((f) => f.status !== "unreadable")).toBe(true);
  });

  it("dev: a plaintext live log is left where it is", () => {
    fs.writeFileSync(main, "[2099-01-01 00:00:00.000] [info] plain\n");
    expect(prepareDevLogFile({ transports: { file: plainTransport() as unknown } })).toBeNull();
    expect(fs.readFileSync(main, "utf8")).toContain("plain");
  });
});
