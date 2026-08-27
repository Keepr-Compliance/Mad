/**
 * BACKLOG-2898 — after a whole sync of the founder's measured workload, the
 * lines support needs are STILL READABLE.
 *
 * This is the acceptance bar, and it is not a line count. What went wrong was
 * not that the log was long; it was that the two lines deciding whether
 * incremental backup ran appear ZERO times across the founder's complete
 * retained history — main.log (703,761 B / 4,023 lines / 21 min) AND
 * main.old.log (1,048,385 B / 5,294 lines / 42 SECONDS). BACKLOG-2896 and the
 * incremental question in BACKLOG-2900 are permanently unanswerable for that
 * incident. This control asserts the next one is answerable.
 *
 * Exercised against the REAL electron-log file transport: jest's
 * moduleNameMapper entry is anchored (`^electron-log$`), so `electron-log/node`
 * resolves to the real package. Against the mock this could never go red.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SyncStepChangeLog } from "../../../src/utils/syncStepLog";
import { SyncTimeline } from "../../services/syncTimeline";
import {
  LOG_FILE_MAX_SIZE_BYTES,
  LOG_FILE_LEVEL,
  LOG_FILE_ARCHIVE_DEPTH,
  applyLogFileConfig,
} from "../logFileConfig";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const realLog = require("electron-log/node");

/** The founder's PC sync, 2026-08-26. */
const WORKLOAD = { chats: 2337, messages: 663000, attachments: 64000, backupFileEvents: 64000 };

/** Measured from main.old.log: 1,048,385 bytes over 42 s of backup transfer. */
const STORM_BYTES_PER_SECOND = 1048385 / 42;
/** Measured from main.log: 11,966 bytes of ordinary app logging over 21 min. */
const STEADY_BYTES_PER_MINUTE = 11966 / 21;

/**
 * Replay one complete sync through the real emit sites into a real log file.
 * Everything written here is written by production code paths — the step
 * change-detector and the phase timeline — not by hand-authored strings.
 */
function replaySyncInto(logger: { info: (m: string) => void }): void {
  const stepLog = new SyncStepChangeLog();
  const timeline = new SyncTimeline({ sink: (l) => logger.info(l) });

  const render = (phase: string, message: string) => {
    const line = stepLog.next({
      view: "progress",
      phase,
      message,
      detail: { syncStatus: "syncing", syncLocked: true, isConnected: true, needsPassword: false },
    });
    if (line) logger.info(`[Renderer] [IPhoneSyncFlow] ${line}`);
  };

  timeline.beginSync({ platform: "win32" });

  // The estimate branch — the line BACKLOG-2896 went looking for.
  logger.info("[DeviceSyncOrchestrator] Using existing backup size for estimate: 5 GB");
  timeline.mark("backup-estimate", {
    source: "existing-backup",
    bytes: 5798205440,
    reusedPreviousBackup: true,
  });

  timeline.enter("backup");
  for (let i = 0; i < WORKLOAD.backupFileEvents; i++) {
    render("backing_up", "Receiving files from iPhone...");
  }
  timeline.annotate("backup", { bytes: 5798205440, incremental: true, encrypted: true });

  timeline.enter("parsing-messages");
  for (let i = 1; i <= WORKLOAD.chats; i++) render("extracting", `Scanning chats: ${i}/${WORKLOAD.chats}`);
  timeline.annotate("parsing-messages", { conversations: WORKLOAD.chats, messages: WORKLOAD.messages });

  timeline.enter("storing:messages");
  for (let i = 1; i <= WORKLOAD.messages; i++) {
    render("storing", `Saving messages... ${i.toLocaleString()} of ${WORKLOAD.messages.toLocaleString()}`);
  }
  timeline.annotate("storing:messages", { stored: WORKLOAD.messages, skipped: 0 });

  timeline.enter("storing:attachments");
  for (let i = 1; i <= WORKLOAD.attachments; i++) {
    render("storing", `Saving attachments... ${i} of ${WORKLOAD.attachments}`);
  }
  timeline.annotate("storing:attachments", { stored: WORKLOAD.attachments, skipped: 0 });

  timeline.endSync("complete", { messages: WORKLOAD.messages, attachments: WORKLOAD.attachments });
}

describe("BACKLOG-2898: a sync stays readable in the log it produces", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-log-2898-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Everything support can still read: current file plus the archive. */
  function retainedHistory(): string {
    return ["main.log", "main.old.log"]
      .map((f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), "utf8") : ""))
      .join("\n");
  }

  function configuredLogger(id: string) {
    const logger = realLog.create({ logId: id });
    logger.transports.console.level = false;
    logger.transports.file.resolvePathFn = () => path.join(dir, "main.log");
    applyLogFileConfig(logger.transports.file);
    return logger;
  }

  it("retains the estimate branch and every phase boundary after a full worst-case sync", () => {
    const logger = configuredLogger(`sync-${Date.now()}`);
    replaySyncInto(logger);

    const history = retainedHistory();

    // The question BACKLOG-2896 could not answer.
    expect(history).toContain("Using existing backup size for estimate");
    expect(history).toContain("mark name=backup-estimate");
    expect(history).toContain("reusedPreviousBackup=true");

    // Every phase boundary, with its duration and counts.
    for (const phase of ["backup", "parsing-messages", "storing:messages", "storing:attachments"]) {
      expect(history).toContain(`phase-end phase=${phase}`);
    }
    expect(history).toContain("messages=663000");
    expect(history).toContain("sync-end outcome=complete");
  });

  it("does not rotate at all during that sync — the whole run is in one file", () => {
    const logger = configuredLogger(`norotate-${Date.now()}`);
    replaySyncInto(logger);

    expect(fs.existsSync(path.join(dir, "main.old.log"))).toBe(false);
    expect(fs.statSync(path.join(dir, "main.log")).size).toBeLessThan(LOG_FILE_MAX_SIZE_BYTES);
  });

  it("sets maxSize explicitly instead of inheriting electron-log's 1 MB default", () => {
    const transport = { level: "silly" as unknown, maxSize: 1024 ** 2 };
    applyLogFileConfig(transport);

    expect(transport.maxSize).toBe(LOG_FILE_MAX_SIZE_BYTES);
    expect(transport.maxSize).not.toBe(1024 ** 2);
    expect(transport.level).toBe(LOG_FILE_LEVEL);
  });

  it("holds well over a week of ordinary app logging, so a Monday sync is readable on Friday", () => {
    // The founder's own steady-state rate, measured outside the storm.
    const minutesHeld = LOG_FILE_MAX_SIZE_BYTES / STEADY_BYTES_PER_MINUTE;
    expect(minutesHeld / 60 / 24).toBeGreaterThan(7);

    // And why capacity alone can never be the fix: at the storm rate measured
    // in main.old.log (1,048,385 B / 42 s), ANY practical cap is minutes.
    const secondsHeldUnderStorm = LOG_FILE_MAX_SIZE_BYTES / STORM_BYTES_PER_SECOND;
    expect(secondsHeldUnderStorm).toBeLessThan(20 * 60);
  });

  it("keeps the sync summary when a rotation does happen", () => {
    const logger = realLog.create({ logId: `rot-${Date.now()}` });
    logger.transports.console.level = false;
    logger.transports.file.resolvePathFn = () => path.join(dir, "main.log");
    logger.transports.file.level = LOG_FILE_LEVEL;
    // A tiny cap so ONE rotation is reachable. The policy under test is the
    // archive, not the number.
    logger.transports.file.maxSize = 8192;

    logger.info("[SyncTimeline] sync-end outcome=complete elapsedMs=2400000 messages=663000");
    for (let i = 0; i < 60; i++) logger.info(`filler ${i} ${"x".repeat(100)}`);

    expect(fs.existsSync(path.join(dir, "main.old.log"))).toBe(true);
    expect(retainedHistory()).toContain("sync-end outcome=complete");
  });

  it("rotates to exactly ONE archive — depth is a stated decision, not a default", () => {
    const logger = realLog.create({ logId: `depth-${Date.now()}` });
    logger.transports.console.level = false;
    logger.transports.file.resolvePathFn = () => path.join(dir, "main.log");
    logger.transports.file.maxSize = 2048;

    for (let i = 0; i < 500; i++) logger.info(`line ${i} ${"y".repeat(100)}`);

    const logFiles = fs.readdirSync(dir).filter((f) => f.endsWith(".log"));
    expect(logFiles.sort()).toEqual(["main.log", "main.old.log"]);
    expect(LOG_FILE_ARCHIVE_DEPTH).toBe(1);
  });
});
