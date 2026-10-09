/**
 * @jest-environment node
 */
/**
 * BACKLOG-3819 — launch cost of log maintenance on sealed files.
 *
 * Once the scrub marker is down, an unchanged sealed log costs one record's
 * decrypt at launch (its head timestamp), not the whole file. A file whose head
 * is past retention is deferred off the launch path, then trimmed by a later
 * pass. Temp directories and a fixed test key only.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { SealedLogAppender, openSealedLog, sealLogText, LOG_HEADER_BYTES } from "../atRest/sealedLog";
import { maintainLogFile, runLogMaintenance, SCRUB_MARKER, LOG_RETENTION_DAYS } from "../logScrub";

const KEY = { keyId: "99".repeat(16), key: Buffer.alloc(32, 9) };
const keyFor = (id: string) => (id === KEY.keyId ? KEY.key : null);
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 9, 8, 12, 0, 0).getTime();

function ts(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `[${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.000]`;
}

let dir: string;
let main: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-logcost-"));
  main = path.join(dir, "main.log");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Appends one sealed record per line, as the sink does. */
function sealLines(file: string, lines: string[]): void {
  const a = new SealedLogAppender({ key: KEY });
  for (const l of lines) a.append(file, l);
}

/** Flip a byte inside the SECOND record's ciphertext. */
function corruptSecondRecord(file: string): void {
  const buf = fs.readFileSync(file);
  const len0 = buf.readUInt32BE(LOG_HEADER_BYTES);
  const second = LOG_HEADER_BYTES + 4 + len0;
  buf[second + 4 + 12 + 1] ^= 0xff;
  fs.writeFileSync(file, buf);
}

describe("BACKLOG-3819 sealed log launch cost", () => {
  it("marker down + fresh head: only the first record is read — damage further in is not even decrypted", () => {
    sealLines(main, [`${ts(NOW - DAY)} [info] fresh head\n`, `${ts(NOW - 1000)} [info] second\n`]);
    corruptSecondRecord(main);
    const before = fs.readFileSync(main);
    expect(maintainLogFile(main, NOW, LOG_RETENTION_DAYS, true, KEY)).toBe("unchanged");
    expect(fs.readFileSync(main).equals(before)).toBe(true);
    // Without the marker the file is fully read, and the damage is found.
    expect(maintainLogFile(main, NOW, LOG_RETENTION_DAYS, false, KEY)).toBe("unreadable");
  });

  it("marker down + head past retention: deferred on the launch path, file untouched", () => {
    sealLines(main, [`${ts(NOW - 20 * DAY)} [info] too old\n`, `${ts(NOW - DAY)} [info] keep me\n`]);
    fs.writeFileSync(path.join(dir, SCRUB_MARKER), "x");
    const before = fs.readFileSync(main);
    const onReplaced = jest.fn();
    const r = runLogMaintenance(dir, NOW, { key: KEY, deferSealedRewrites: true, onReplaced });
    expect(r.deferred).toEqual(["main.log"]);
    expect(r.rewritten).toEqual([]);
    expect(onReplaced).not.toHaveBeenCalled();
    expect(fs.readFileSync(main).equals(before)).toBe(true);

    // The later (deferred) pass trims it.
    const later = runLogMaintenance(dir, NOW, { key: KEY, onReplaced });
    expect(later.rewritten).toEqual(["main.log"]);
    expect(later.deferred).toEqual([]);
    expect(onReplaced).toHaveBeenCalledWith(main);
    const text = openSealedLog(fs.readFileSync(main), keyFor).text;
    expect(text).not.toContain("too old");
    expect(text).toContain("keep me");
  });

  it("a head with no timestamp is not treated as fresh", () => {
    fs.writeFileSync(main, sealLogText(`no timestamp here\n${ts(NOW - 20 * DAY)} [info] old\n`, KEY));
    fs.writeFileSync(path.join(dir, SCRUB_MARKER), "x");
    expect(runLogMaintenance(dir, NOW, { key: KEY, deferSealedRewrites: true }).deferred).toEqual(["main.log"]);
  });
});
