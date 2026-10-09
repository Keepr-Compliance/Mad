/**
 * @jest-environment node
 */
/**
 * BACKLOG-3819 — the KEPRLOG sealed log format: records authenticate, damage is
 * reported (never returned as garbage), a torn tail costs at most one record.
 * Temp directories only; the key is a fixed test key, never the keychain.
 */
import fs from "fs";
import os from "os";
import path from "path";

import {
  LOG_HEADER_BYTES,
  SealedLogAppender,
  isSealedLog,
  openSealedLog,
  sealLogText,
  walkLogRecords,
} from "../sealedLog";

const KEY = { keyId: "11".repeat(16), key: Buffer.alloc(32, 1) };
const OTHER = { keyId: "22".repeat(16), key: Buffer.alloc(32, 2) };
const keyFor = (id: string) => (id === KEY.keyId ? KEY.key : null);

const LINES = ["[2026-10-08 10:00:00.000] [info] alpha\n", "[2026-10-08 10:00:01.000] [info] bravo\n", "[2026-10-08 10:00:02.000] [info] charlie\n"];

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-sealedlog-"));
  file = path.join(dir, "main.log");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function writeLines(lines = LINES): void {
  const a = new SealedLogAppender({ key: KEY });
  for (const l of lines) a.append(file, l);
}

/** Offsets of each record (start of its length prefix). */
function recordOffsets(buf: Buffer): number[] {
  const out: number[] = [];
  let off = LOG_HEADER_BYTES;
  while (off + 4 <= buf.length) {
    out.push(off);
    off += 4 + buf.readUInt32BE(off);
  }
  return out;
}

describe("BACKLOG-3819 sealed log format", () => {
  it("round-trips appended lines and holds no plaintext on disk", () => {
    writeLines();
    const raw = fs.readFileSync(file);
    expect(isSealedLog(raw)).toBe(true);
    for (const word of ["alpha", "bravo", "charlie", "[info]", "2026-10-08"]) {
      expect(raw.includes(Buffer.from(word))).toBe(false);
    }
    const r = openSealedLog(raw, keyFor);
    expect(r.problems).toEqual([]);
    expect(r.records).toBe(3);
    expect(r.text).toBe(LINES.join(""));
  });

  it("a flipped byte is reported as corruption of THAT record; the others still read; no garbage", () => {
    writeLines();
    const raw = fs.readFileSync(file);
    const offs = recordOffsets(raw);
    raw[offs[1] + 4 + 12 + 3] ^= 0x01; // inside record 1's ciphertext
    const r = openSealedLog(raw, keyFor);
    expect(r.failedRecords).toBe(1);
    expect(r.problems).toEqual([expect.objectContaining({ kind: "integrity", offset: offs[1] })]);
    expect(r.text).toBe(LINES[0] + LINES[2]);
  });

  it("two records swapped are both reported (record index is authenticated)", () => {
    writeLines();
    const raw = fs.readFileSync(file);
    const offs = recordOffsets(raw);
    const r0 = raw.subarray(offs[0], offs[1]);
    const r1 = raw.subarray(offs[1], offs[2]);
    const swapped = Buffer.concat([raw.subarray(0, offs[0]), r1, r0, raw.subarray(offs[2])]);
    const r = openSealedLog(swapped, keyFor);
    expect(r.failedRecords).toBe(2);
    expect(r.text).toBe(LINES[2]);
  });

  it("a flipped header byte fails every record", () => {
    writeLines();
    const raw = fs.readFileSync(file);
    raw[30] ^= 0xff; // salt
    const r = openSealedLog(raw, keyFor);
    expect(r.records).toBe(0);
    expect(r.failedRecords).toBe(3);
    expect(r.text).toBe("");
  });

  it("a crash mid-write (torn tail) loses only that record; the appender cuts it and continues", () => {
    writeLines();
    const full = fs.statSync(file).size;
    fs.truncateSync(file, full - 5);
    const torn = openSealedLog(fs.readFileSync(file), keyFor);
    expect(torn.problems).toEqual([expect.objectContaining({ kind: "torn" })]);
    expect(torn.text).toBe(LINES[0] + LINES[1]);

    const a = new SealedLogAppender({ key: KEY });
    a.append(file, "[2026-10-08 10:00:03.000] [info] delta\n");
    const after = openSealedLog(fs.readFileSync(file), keyFor);
    expect(after.problems).toEqual([]);
    expect(after.text).toBe(LINES[0] + LINES[1] + "[2026-10-08 10:00:03.000] [info] delta\n");
    expect(walkLogRecords(fs.readFileSync(file)).torn).toBe(false);
  });

  it("a file under a key this computer does not hold is reported, not decrypted", () => {
    fs.writeFileSync(file, sealLogText(LINES.join(""), OTHER));
    const r = openSealedLog(fs.readFileSync(file), keyFor);
    expect(r.problems).toEqual([expect.objectContaining({ kind: "key" })]);
    expect(r.text).toBe("");
  });

  it("the appender sets a foreign-key file aside and starts a fresh one", () => {
    fs.writeFileSync(file, sealLogText(LINES.join(""), OTHER));
    writeLines([LINES[0]]);
    expect(openSealedLog(fs.readFileSync(file), keyFor).text).toBe(LINES[0]);
    expect(fs.existsSync(path.join(dir, "main.old.log"))).toBe(true);
  });

  it("the appender never appends behind plaintext: an existing plaintext log is sealed first", () => {
    fs.writeFileSync(file, "[2026-10-07 09:00:00.000] [info] old plain line\n");
    const a = new SealedLogAppender({ key: KEY, migratePlaintext: (t) => t.replace("plain", "PLAIN") });
    a.append(file, LINES[0]);
    const raw = fs.readFileSync(file);
    expect(isSealedLog(raw)).toBe(true);
    expect(raw.includes(Buffer.from("old plain line"))).toBe(false);
    expect(openSealedLog(raw, keyFor).text).toBe("[2026-10-07 09:00:00.000] [info] old PLAIN line\n" + LINES[0]);
  });
});

/** Every record's 12-byte nonce, in file order (header, then u32 length || nonce || ...). */
function nonces(buf: Buffer): string[] {
  const out: string[] = [];
  let off = LOG_HEADER_BYTES;
  while (off + 4 <= buf.length) {
    const len = buf.readUInt32BE(off);
    out.push(buf.subarray(off + 4, off + 16).toString("hex"));
    off += 4 + len;
  }
  return out;
}

describe("BACKLOG-3819 nonce uniqueness under one file key", () => {
  it("every record in a file has its own nonce, including after a restart appends to the same file", () => {
    const line = (i: number) => `[2026-10-08 10:00:00.000] [info] line ${i}\n`;
    const first = new SealedLogAppender({ key: KEY });
    for (let i = 0; i < 500; i++) first.append(file, line(i));
    // A new process: fresh appender, same file, same header salt -> same file key.
    const second = new SealedLogAppender({ key: KEY });
    for (let i = 500; i < 1000; i++) second.append(file, line(i));
    const buf = fs.readFileSync(file);
    const all = nonces(buf);
    expect(all).toHaveLength(1000);
    expect(new Set(all).size).toBe(1000);
    const read = openSealedLog(buf, keyFor);
    expect(read.problems).toEqual([]);
    expect(read.records).toBe(1000);
  });

  it("a whole-file reseal also uses a distinct nonce per record", () => {
    const text = Array.from({ length: 4000 }, (_, i) => `[2026-10-08 10:00:00.000] [info] ${"x".repeat(60)} ${i}\n`).join("");
    const buf = sealLogText(text, KEY);
    const all = nonces(buf);
    expect(all.length).toBeGreaterThan(1);
    expect(new Set(all).size).toBe(all.length);
  });
});

