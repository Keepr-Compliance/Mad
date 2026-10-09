/**
 * @jest-environment node
 */
/**
 * BACKLOG-3819 — encrypted desktop logs: the sink (pre-key buffer, sealed
 * writes, redacted plaintext fallback) and the at-rest maintenance that seals
 * legacy plaintext, merges the fallback and applies retention to sealed files.
 * Temp directories only; a fixed test key, never the keychain.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { SealedLogSink } from "../sealedLogSink";
import { runLogMaintenance } from "../logScrub";
import { isSealedLog, openSealedLog, sealLogText } from "../atRest/sealedLog";

const KEY = { keyId: "33".repeat(16), key: Buffer.alloc(32, 3) };
const keyFor = (id: string) => (id === KEY.keyId ? KEY.key : null);
const DAY = 24 * 60 * 60 * 1000;

let dir: string;
let main: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-sink-"));
  main = path.join(dir, "main.log");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const stamp = (d: Date) => {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `[${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.000]`;
};
const line = (text: string, at = new Date()) => `${stamp(at)} [info] ${text}\n`;

function decrypted(file = main): string {
  const raw = fs.readFileSync(file);
  expect(isSealedLog(raw)).toBe(true);
  const r = openSealedLog(raw, keyFor);
  expect(r.problems).toEqual([]);
  return r.text;
}

/** No line of `text` appears verbatim in the raw bytes of `file`. */
function expectNoPlaintext(file: string, words: string[]): void {
  const raw = fs.readFileSync(file);
  for (const w of words) expect(raw.includes(Buffer.from(w))).toBe(false);
}

describe("BACKLOG-3819 SealedLogSink", () => {
  it("holds lines in memory before the key, then flushes them SEALED in order", () => {
    const sink = new SealedLogSink({ report: () => undefined });
    sink.write(main, line("pre-key one"));
    sink.write(main, line("pre-key two"));
    expect(fs.existsSync(main)).toBe(false);
    expect(fs.existsSync(path.join(dir, "main.unsealed.log"))).toBe(false);

    sink.activate(KEY);
    const text = decrypted();
    expect(text).toContain("pre-key one");
    expect(text.indexOf("pre-key one")).toBeLessThan(text.indexOf("pre-key two"));
    expectNoPlaintext(main, ["pre-key one", "pre-key two"]);
  });

  it("after the key is ready the log file on disk has no plaintext lines", () => {
    const sink = new SealedLogSink({ report: () => undefined });
    sink.activate(KEY);
    for (let i = 0; i < 20; i++) sink.write(main, line(`sealed line ${i} payload`));
    expectNoPlaintext(main, ["sealed line", "payload", "[info]"]);
    expect(decrypted().split("\n").filter(Boolean)).toHaveLength(20);
  });

  it("overflowing the pre-key buffer spills REDACTED plaintext to main.unsealed.log (nothing dropped)", () => {
    const sink = new SealedLogSink({ bufferCapBytes: 100, report: () => undefined });
    sink.write(main, line("first jane.doe@example.com"));
    sink.write(main, line("second +15555550123 overflow"));
    sink.write(main, line("third after spill"));
    expect(sink.state).toBe("plaintext");
    const plain = fs.readFileSync(path.join(dir, "main.unsealed.log"), "utf8");
    expect(plain).toContain("first j***@example.com");
    expect(plain).toContain("***23 overflow");
    expect(plain).toContain("third after spill");
    expect(plain).not.toContain("jane.doe@example.com");
    expect(fs.existsSync(main)).toBe(false);
  });

  it("key unavailable: redacted plaintext until it opens; exit flush writes held lines", () => {
    const a = new SealedLogSink({ report: () => undefined });
    a.write(main, line("held at exit bob@example.org"));
    a.flushAtExit();
    expect(fs.readFileSync(path.join(dir, "main.unsealed.log"), "utf8")).toContain("held at exit b***@example.org");

    const b = new SealedLogSink({ report: () => undefined });
    b.write(main, line("before fallback"));
    b.fallbackToPlaintext("secure storage unavailable");
    b.write(main, line("after fallback"));
    const plain = fs.readFileSync(path.join(dir, "main.unsealed.log"), "utf8");
    expect(plain).toContain("before fallback");
    expect(plain).toContain("after fallback");
  });

  it("rotation works on sealed files: main.log -> main.old.log, both decrypt", () => {
    const sink = new SealedLogSink({ report: () => undefined });
    sink.activate(KEY);
    for (let i = 0; i < 30; i++) sink.write(main, line(`rotating ${i}`), 1000);
    const old = path.join(dir, "main.old.log");
    expect(fs.existsSync(old)).toBe(true);
    // One archive (electron-log's depth): the two files hold a contiguous,
    // in-order tail of what was written, ending with the last line.
    const all = (decrypted(old) + decrypted(main)).split("\n").filter(Boolean).map((l) => Number(l.split("rotating ")[1]));
    expect(all[all.length - 1]).toBe(29);
    expect(all).toEqual(Array.from({ length: all.length }, (_, i) => 30 - all.length + i));
    expect(fs.statSync(main).size).toBeLessThan(1200);
  });
});

describe("BACKLOG-3819 maintenance with the data key", () => {
  const now = new Date(2026, 9, 8, 12, 0, 0).getTime();

  it("seals legacy plaintext main.log / main.old.log (plaintext copies gone)", () => {
    fs.writeFileSync(main, line("legacy current carol@example.com", new Date(now - DAY)));
    fs.writeFileSync(path.join(dir, "main.old.log"), line("legacy archive", new Date(now - 2 * DAY)));
    const r = runLogMaintenance(dir, now, { key: KEY });
    expect(r.errors).toEqual([]);
    expect(r.sealed.sort()).toEqual(["main.log", "main.old.log"]);
    expect(decrypted()).toContain("legacy current c***@example.com");
    expect(decrypted(path.join(dir, "main.old.log"))).toContain("legacy archive");
    expectNoPlaintext(main, ["legacy current"]);
  });

  it("merges main.unsealed.log into the sealed main.log, in order, and deletes it", () => {
    fs.writeFileSync(main, sealLogText(line("earlier sealed", new Date(now - DAY)), KEY));
    fs.writeFileSync(path.join(dir, "main.unsealed.log"), line("fallback line", new Date(now - 1000)));
    const replaced: string[] = [];
    const r = runLogMaintenance(dir, now, { key: KEY, onReplaced: (f) => replaced.push(path.basename(f)) });
    expect(r.errors).toEqual([]);
    expect(fs.existsSync(path.join(dir, "main.unsealed.log"))).toBe(false);
    const text = decrypted();
    expect(text.indexOf("earlier sealed")).toBeLessThan(text.indexOf("fallback line"));
    expect(replaced).toEqual(expect.arrayContaining(["main.log", "main.unsealed.log"]));
  });

  it("retention works on sealed files: old entries dropped from main.log, expired archive deleted", () => {
    const old = new Date(now - 20 * DAY);
    const fresh = new Date(now - DAY);
    fs.writeFileSync(main, sealLogText(line("too old entry", old) + line("fresh entry", fresh), KEY));
    const archive = path.join(dir, "main.old.log");
    fs.writeFileSync(archive, sealLogText(line("archived", old), KEY));
    fs.utimesSync(archive, old, old);
    const r = runLogMaintenance(dir, now, { key: KEY });
    expect(r.errors).toEqual([]);
    expect(r.deleted).toEqual(["main.old.log"]);
    expect(r.rewritten).toEqual(["main.log"]);
    const text = decrypted();
    expect(text).not.toContain("too old entry");
    expect(text).toContain("fresh entry");
  });

  it("without the key, sealed files are left untouched (archives still expire by mtime)", () => {
    const sealed = sealLogText(line("keep me", new Date(now - 20 * DAY)), KEY);
    fs.writeFileSync(main, sealed);
    const r = runLogMaintenance(dir, now, { key: null });
    expect(r.errors).toEqual([]);
    expect(fs.readFileSync(main).equals(sealed)).toBe(true);
  });

  it("a sealed file that fails authentication is reported unreadable and left alone", () => {
    const sealed = sealLogText(line("x", new Date(now - DAY)), KEY);
    sealed[sealed.length - 1] ^= 1;
    fs.writeFileSync(main, sealed);
    const r = runLogMaintenance(dir, now, { key: KEY });
    expect(r.unreadable).toEqual(["main.log"]);
    expect(fs.readFileSync(main).equals(sealed)).toBe(true);
  });
});
