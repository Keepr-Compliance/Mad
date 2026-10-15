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
import {
  dropEntriesBefore,
  maintainLogFile,
  runDeferredLogRetention,
  runLogMaintenance,
  trimSealedLogAsync,
  SCRUB_MARKER,
  LOG_RETENTION_DAYS,
} from "../logScrub";

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

describe("BACKLOG-3819 deferred trim does not block the main thread", () => {
  function staleLines(n: number): string[] {
    const out = [`${ts(NOW - 20 * DAY)} [info] too old\n`, `continuation of the old entry\n`];
    for (let i = 0; i < n; i++) out.push(`${ts(NOW - DAY + i * 1000)} [info] kept ${i}\n`);
    return out;
  }

  it("yields to the event loop while it works: a timer set during the trim fires before it finishes", async () => {
    sealLines(main, staleLines(200));
    let finished = false;
    let timerSawFinished: boolean | null = null;
    const trim = trimSealedLogAsync(main, NOW, KEY, { sliceMs: 0 }).then((o) => {
      finished = true;
      return o;
    });
    setTimeout(() => {
      timerSawFinished = finished;
    }, 0);
    expect(await trim).toBe("rewritten");
    expect(timerSawFinished).toBe(false);
  });

  it("same result as the synchronous trim (entries before the cutoff dropped, continuation lines with them)", async () => {
    const lines = staleLines(50);
    sealLines(main, lines);
    expect(await trimSealedLogAsync(main, NOW, KEY, { sliceMs: 0 })).toBe("rewritten");
    const read = openSealedLog(fs.readFileSync(main), keyFor);
    expect(read.problems).toEqual([]);
    expect(read.text).toBe(dropEntriesBefore(lines.join(""), NOW - LOG_RETENTION_DAYS * DAY));
    expect(read.text).not.toContain("too old");
    expect(read.text).not.toContain("continuation of the old entry");
    // Fresh head now: nothing more to do.
    expect(await trimSealedLogAsync(main, NOW, KEY)).toBe("unchanged");
  });

  it("an archive with nothing left is deleted; an unauthenticated file is left untouched", async () => {
    const archive = path.join(dir, "main.old.log");
    sealLines(archive, [`${ts(NOW - 20 * DAY)} [info] old only\n`]);
    sealLines(main, staleLines(3));
    corruptSecondRecord(main);
    const before = fs.readFileSync(main);
    const r = await runDeferredLogRetention(dir, ["main.old.log", "main.log"], NOW, KEY, { sliceMs: 0 });
    expect(r.deleted).toEqual(["main.old.log"]);
    expect(r.unreadable).toEqual(["main.log"]);
    expect(fs.existsSync(archive)).toBe(false);
    expect(fs.readFileSync(main).equals(before)).toBe(true);
  });
});

