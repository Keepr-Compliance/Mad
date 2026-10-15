/**
 * BACKLOG-3819 — electron-log's file transport, replaced by one that seals.
 *
 * `log.transports.file` is swapped for {@link createSealedFileTransport}'s
 * function. Everything that configures the file transport keeps working, because
 * the configuration fields (resolvePathFn, maxSize, format, transforms,
 * inspectOptions, fileName, getFile) are forwarded to electron-log's original
 * transport object — while the original itself is no longer in `transports`, so
 * it can never write plaintext again, whatever `level` someone later sets.
 *
 * The line is formatted exactly as electron-log would (the transport's own
 * `transforms`, then electron-log's EOL), so the decrypted file is byte-identical
 * to what the plain file used to hold. The redaction hook (logFileConfig.ts) runs
 * BEFORE any transport, so lines are redacted and then sealed.
 */
import os from "os";
import path from "path";
import fs from "fs";

import type { LogMessage } from "electron-log";
import type { SealedLogSink } from "../services/sealedLogSink";
import { isSealedLog, openSealedLog } from "../services/atRest/sealedLog";

/** The parts of electron-log's file transport this module relies on. */
interface FileTransportLike {
  (message: LogMessage): void;
  level: unknown;
  maxSize: number;
  transforms: Array<(arg: { data: unknown[]; logger: unknown; message: LogMessage; transport: unknown }) => unknown>;
  getFile: (message?: LogMessage) => { path: string };
  [key: string]: unknown;
}

interface LoggerLike {
  transports: Record<string, unknown>;
}

/** Fields read and written through to the original transport. */
const FORWARDED = [
  "archiveLogFn",
  "fileName",
  "format",
  "inspectOptions",
  "maxSize",
  "resolvePathFn",
  "sync",
  "transforms",
  "writeOptions",
] as const;

export const SEALED_TRANSPORT_MARK = Symbol.for("keepr.sealedFileTransport");

export interface SealedFileTransport {
  (message: LogMessage): void;
  level: unknown;
  getFile: (message?: LogMessage) => { path: string };
  /** Decrypted contents of every *.log in the log directory (electron-log's API, sealed-aware). */
  readAllLogs: (opts?: { fileFilter?: (f: string) => boolean }) => Array<{ path: string; lines: string[] }>;
  [key: string]: unknown;
}

export function isSealedFileTransport(t: unknown): boolean {
  return typeof t === "function" && (t as unknown as Record<symbol, unknown>)[SEALED_TRANSPORT_MARK] === true;
}

/**
 * Replace `logger.transports.file` with the sealed transport. Idempotent. A
 * logger without a real file transport (the jest mock) is left alone.
 */
export function installSealedFileTransport(logger: LoggerLike, sink: SealedLogSink): void {
  const current = logger.transports.file as FileTransportLike | undefined;
  if (!current || isSealedFileTransport(current)) return;
  if (typeof current !== "function" || typeof current.getFile !== "function") return;
  logger.transports.file = createSealedFileTransport(logger, current, sink);
}

export function createSealedFileTransport(
  logger: LoggerLike,
  inner: FileTransportLike,
  sink: SealedLogSink,
): SealedFileTransport {
  const transport = function sealedFileTransport(message: LogMessage): void {
    const file = inner.getFile(message).path;
    const transforms = inner.transforms ?? [];
    const content = transforms.reduce<unknown>(
      (data, fn) =>
        typeof fn === "function" ? fn({ data: data as unknown[], logger, message, transport }) : data,
      message?.data ?? [],
    );
    sink.write(file, `${String(content)}${os.EOL}`, Number(inner.maxSize) || 0);
  } as unknown as SealedFileTransport;

  for (const key of FORWARDED) {
    Object.defineProperty(transport, key, {
      enumerable: true,
      configurable: true,
      get: () => inner[key],
      set: (v: unknown) => {
        (inner as unknown as Record<string, unknown>)[key] = v;
      },
    });
  }
  transport.level = inner.level;
  transport.getFile = (message?: LogMessage) => inner.getFile(message);
  transport.readAllLogs = ({ fileFilter = (f: string) => f.endsWith(".log") } = {}) => {
    const dir = path.dirname(inner.getFile().path);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    return names
      .map((n) => path.join(dir, n))
      .filter(fileFilter)
      .map((p) => {
        try {
          const buf = fs.readFileSync(p);
          if (!isSealedLog(buf)) return { path: p, lines: buf.toString("utf8").split(os.EOL) };
          const r = openSealedLog(buf, (id) => sink.keyFor(id));
          const lines = r.text.split(os.EOL);
          for (const pr of r.problems) lines.push(`[sealed log: ${pr.kind} at byte ${pr.offset}: ${pr.message}]`);
          return { path: p, lines };
        } catch {
          return null;
        }
      })
      .filter((x): x is { path: string; lines: string[] } => x !== null);
  };
  Object.defineProperty(transport, SEALED_TRANSPORT_MARK, { value: true });
  return transport;
}
