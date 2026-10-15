/**
 * "Save diagnostic log" (BACKLOG-3819).
 *
 * Desktop logs are sealed at rest (atRest/sealedLog.ts), so support can no longer
 * ask a user to send `main.log` — it is ciphertext. This builds a DECRYPTED,
 * redacted copy for the user to save wherever they choose and send to support.
 * Plain by design: the user asked for it, like any export.
 *
 * Contents, oldest first: `*.old.log`, the live `*.log`, any `*.unsealed.log`
 * (redacted fallback written while the key was not open), then lines still held
 * in memory. Every piece goes through the redactor again (defence in depth). A
 * file that fails authentication or is sealed under a key this computer does not
 * hold is reported in the export — never emitted as bytes.
 */
import fs from "fs";
import path from "path";

import { isSealedLog, openSealedLog } from "./atRest/sealedLog";
import { redactLogText } from "../utils/redactSensitive";

const LOG_FILE_RE = /^[\w.-]+\.log$/;

export interface DiagnosticLogFileStatus {
  name: string;
  status: "sealed" | "plaintext" | "unreadable";
  detail?: string;
}

export interface DiagnosticLogBuild {
  text: string;
  files: DiagnosticLogFileStatus[];
}

function rank(name: string): number {
  if (/\.old\.log$/.test(name)) return 0;
  if (/\.unsealed\.log$/.test(name)) return 2;
  return 1;
}

export function buildDiagnosticLogText(
  logDir: string,
  opts: {
    keyFor: (keyId: string) => Buffer | null;
    /** Lines held in memory by the sink (not yet on disk). */
    pending?: ReadonlyArray<{ file: string; text: string }>;
    now?: Date;
  },
): DiagnosticLogBuild {
  const now = opts.now ?? new Date();
  const out: string[] = [
    `Keepr diagnostic log — saved ${now.toISOString()}`,
    "Email addresses and phone numbers are redacted.",
    "",
  ];
  const files: DiagnosticLogFileStatus[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(logDir).filter((n) => LOG_FILE_RE.test(n));
  } catch {
    names = [];
  }
  names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

  for (const name of names) {
    const file = path.join(logDir, name);
    let buf: Buffer;
    try {
      buf = fs.readFileSync(file);
    } catch (err) {
      files.push({ name, status: "unreadable", detail: (err as Error).message });
      out.push(`===== ${name} (could not be read: ${(err as Error).message}) =====`, "");
      continue;
    }
    if (!isSealedLog(buf)) {
      files.push({ name, status: "plaintext" });
      out.push(`===== ${name} =====`, redactLogText(buf.toString("utf8")));
      continue;
    }
    const read = openSealedLog(buf, opts.keyFor);
    const fatal = read.problems.find((p) => p.kind === "key" || p.kind === "format");
    files.push(
      fatal
        ? { name, status: "unreadable", detail: fatal.message }
        : { name, status: "sealed", detail: read.problems.length ? `${read.problems.length} problem(s)` : undefined },
    );
    out.push(`===== ${name} =====`);
    if (read.text) out.push(redactLogText(read.text));
    for (const p of read.problems) {
      out.push(`[diagnostic log: ${name}: ${p.kind} at byte ${p.offset} — ${p.message}]`);
    }
    out.push("");
  }

  const held = (opts.pending ?? []).filter((l) => path.dirname(path.resolve(l.file)) === path.resolve(logDir));
  if (held.length > 0) {
    out.push("===== in memory (not yet written) =====", redactLogText(held.map((l) => l.text).join("")));
  }
  return { text: out.join("\n"), files };
}
