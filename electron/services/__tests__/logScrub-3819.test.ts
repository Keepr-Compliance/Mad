/**
 * BACKLOG-3819 L2 + retention — the one-time scrub leaves no email- or
 * phone-shaped customer value in the existing log files, keeps everything else,
 * is idempotent, and does not lose lines electron-log writes after it.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runLogMaintenance, parseLineTimestamp, LOG_RETENTION_DAYS, SCRUB_MARKER } from "../logScrub";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const realLog = require("electron-log/node");

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 9, 8, 12, 0, 0).getTime();

function stamp(t: number): string {
  const d = new Date(t);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `[${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}]`;
}

const RAW_VALUES = [
  "jane.customer@example.com",
  "bob+tag@sub.example.org",
  "+15555550123",
  "+1 (555) 555-0145",
  "(555) 555-0167",
  "555-555-0189",
];

/** Independent detectors (inventory-style, broader than the redactor). */
const BROAD_EMAIL = /[\w.+-]+@[\w-]+\.[\w.]{2,}/g;
const BROAD_PHONE = /\+\d[\d\s().-]{6,}\d|\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g;

function buildLog(start: number): string {
  return [
    `${stamp(start)} [info]  [Main] contact ${RAW_VALUES[0]} phone ${RAW_VALUES[2]}`,
    `${stamp(start + 1000)} [error] [Main] failure Error: lookup ${RAW_VALUES[1]}`,
    `    at lookup (/app/x.js:10:5)  ${RAW_VALUES[3]}`,
    `${stamp(start + 2000)} [info]  [Renderer] [Sync] ${RAW_VALUES[4]} / ${RAW_VALUES[5]}`,
    `${stamp(start + 3000)} [info]  [SyncTimeline] bytes=5798205440 durationMs=1234567 id=00008101-000A1B2C3D4E5F60`,
    "",
  ].join("\n");
}

describe("BACKLOG-3819: log scrub + retention", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-scrub-3819-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");

  it("L2: main.log and main.old.log keep no email/phone-shaped customer value", () => {
    fs.writeFileSync(path.join(dir, "main.log"), buildLog(NOW - DAY));
    fs.writeFileSync(path.join(dir, "main.old.log"), buildLog(NOW - 3 * DAY));

    const res = runLogMaintenance(dir, NOW);
    expect(res.errors).toEqual([]);
    expect(res.rewritten.sort()).toEqual(["main.log", "main.old.log"]);

    for (const f of ["main.log", "main.old.log"]) {
      const text = read(f);
      for (const raw of RAW_VALUES) expect(text).not.toContain(raw);
      // every remaining email-shaped token is a redacted one
      for (const m of text.match(BROAD_EMAIL) ?? []) expect(m).toMatch(/\*\*\*@/);
      expect(text.match(BROAD_PHONE) ?? []).toEqual([]);
      // non-PII content survives byte-for-byte
      expect(text).toContain("bytes=5798205440 durationMs=1234567 id=00008101-000A1B2C3D4E5F60");
      expect(text).toContain("j***@example.com phone ***23");
      expect(text.split("\n")).toHaveLength(6);
    }
  });

  it("is idempotent: a second run rewrites nothing", () => {
    fs.writeFileSync(path.join(dir, "main.log"), buildLog(NOW - DAY));
    runLogMaintenance(dir, NOW);
    const once = read("main.log");
    expect(fs.existsSync(path.join(dir, SCRUB_MARKER))).toBe(true);
    // Without the marker the full redactor pass finds nothing left to change.
    fs.unlinkSync(path.join(dir, SCRUB_MARKER));
    const second = runLogMaintenance(dir, NOW);
    expect(second.rewritten).toEqual([]);
    expect(read("main.log")).toBe(once);
  });

  it("after the marker, later launches still enforce retention", () => {
    fs.writeFileSync(path.join(dir, "main.log"), buildLog(NOW - DAY));
    runLogMaintenance(dir, NOW);
    expect(runLogMaintenance(dir, NOW).rewritten).toEqual([]);
    // 20 days later every entry is past retention.
    const later = runLogMaintenance(dir, NOW + 20 * DAY);
    expect(later.rewritten).toEqual(["main.log"]);
    expect(read("main.log")).toBe("");
  });

  it("an archive whose entries are all past retention is deleted even if its mtime is recent", () => {
    fs.writeFileSync(path.join(dir, "main.old.log"), buildLog(NOW - 20 * DAY));
    expect(runLogMaintenance(dir, NOW).deleted).toEqual(["main.old.log"]);
  });

  it("deletes an archive older than 14 days and drops entries older than 14 days", () => {
    fs.writeFileSync(path.join(dir, "main.old.log"), buildLog(NOW - 20 * DAY));
    const old = (NOW - 15 * DAY) / 1000;
    fs.utimesSync(path.join(dir, "main.old.log"), old, old);
    const mixed = buildLog(NOW - (LOG_RETENTION_DAYS + 1) * DAY) + buildLog(NOW - DAY);
    fs.writeFileSync(path.join(dir, "main.log"), mixed);

    const res = runLogMaintenance(dir, NOW);
    expect(res.deleted).toEqual(["main.old.log"]);
    expect(fs.existsSync(path.join(dir, "main.old.log"))).toBe(false);
    const text = read("main.log");
    const stamps = text.split("\n").map(parseLineTimestamp).filter((t): t is number => t !== null);
    expect(stamps).toHaveLength(4);
    for (const t of stamps) expect(t).toBeGreaterThanOrEqual(NOW - LOG_RETENTION_DAYS * DAY);
  });

  it("leaves files it does not own alone and cleans crash leftovers", () => {
    fs.writeFileSync(path.join(dir, "notes.txt"), "jane.customer@example.com");
    fs.writeFileSync(path.join(dir, "main.log.scrub-123-456.tmp"), "x");
    runLogMaintenance(dir, NOW);
    expect(read("notes.txt")).toBe("jane.customer@example.com");
    expect(fs.existsSync(path.join(dir, "main.log.scrub-123-456.tmp"))).toBe(false);
  });

  it("a missing log directory is not an error", () => {
    expect(runLogMaintenance(path.join(dir, "nope"), NOW).errors).toEqual([]);
  });

  it("electron-log keeps writing to main.log after the scrub renames over it", () => {
    const logger = realLog.create({ logId: `scrub-3819-${Date.now()}` });
    logger.transports.console.level = false;
    logger.transports.file.resolvePathFn = () => path.join(dir, "main.log");
    logger.info("before scrub line");
    fs.appendFileSync(path.join(dir, "main.log"), `${stamp(Date.now())} [info]  raw ${RAW_VALUES[0]}\n`);
    expect(runLogMaintenance(dir, Date.now()).rewritten).toEqual(["main.log"]);
    logger.info("after scrub line");
    const text = read("main.log");
    expect(text).toContain("before scrub line");
    expect(text).toContain("after scrub line");
    expect(text).not.toContain(RAW_VALUES[0]);
  });
});
