/**
 * BACKLOG-2898 — one complete sync of the MEASURED WORST CASE fits in the log.
 *
 * The property, not a byte count: replay a whole first-full-backup sync
 * through the REAL emit sites and assert the bytes it produces cannot rotate
 * the file. If anyone re-introduces per-item logging, the replay produces
 * millions of lines and this goes red — which is precisely the regression that
 * cost the founder the first 19 minutes of his backup.
 *
 * This file imports from BOTH src/ and electron/ deliberately: the sync log is
 * written by both processes, so a budget that models only one half is not a
 * budget. (Precedent: electron/services/__tests__/contactCompare.test.ts and
 * four others already import from src/; both tsconfigs exclude *.test.ts, so
 * the rootDir boundary is not crossed in any build.)
 *
 * WORKLOAD — the founder's actual PC sync, 2026-08-26:
 *   2,337 chats · 663,000 messages · 64,000 attachments · ~24 min of backup
 *   transfer · 4,023-line / 703,761-byte log covering only its last 21 minutes.
 */

import { SyncStepChangeLog } from "../../../src/utils/syncStepLog";
import { SyncTimeline } from "../syncTimeline";
import { LOG_FILE_MAX_SIZE_BYTES } from "../../config/logFileConfig";

const WORKLOAD = {
  chats: 2337,
  messages: 663000,
  attachments: 64000,
  /** idevicebackup2 writes one progress line per file. */
  backupFileEvents: 64000,
};

/**
 * electron-log's own line prefix, measured from the founder's log:
 * "[2026-08-26 16:06:21.629] [info]  " = 34 bytes, and the renderer relay adds
 * its own "[Renderer] [23:06:21.630] " = 26 bytes.
 */
const MAIN_PREFIX_BYTES = 34;
const RENDERER_PREFIX_BYTES = 34 + 26;

/**
 * Everything the app logs during a sync that is NOT the sync itself — measured
 * from the same log: 61 main-process records totalling 11,966 bytes over 21
 * minutes. Scaled to a 40-minute sync.
 */
const OTHER_APP_LOGGING_BYTES = Math.round((11966 / 21) * 40);

/** Replay a whole sync, returning every line the code would write. */
function replayWorstCaseSync(): { rendererLines: string[]; mainLines: string[] } {
  const rendererLines: string[] = [];
  const mainLines: string[] = [];

  const stepLog = new SyncStepChangeLog();
  const timeline = new SyncTimeline({ now: () => 0, sink: (l) => mainLines.push(l) });

  /** The renderer's effect: fires per render, logs only on a step change. */
  const render = (phase: string, message: string) => {
    const line = stepLog.next({
      view: "progress",
      phase,
      message,
      detail: { syncStatus: "syncing", syncLocked: true, isConnected: true, needsPassword: false },
    });
    if (line) rendererLines.push(`[IPhoneSyncFlow] ${line}`);
  };

  timeline.beginSync({ platform: "win32" });

  // Backup: one progress event per file transferred.
  timeline.enter("backup");
  for (let i = 0; i < WORKLOAD.backupFileEvents; i++) {
    render("backing_up", "Receiving files from iPhone...");
  }
  timeline.annotate("backup", { bytes: 5798205440, incremental: false, encrypted: true });

  timeline.enter("decrypting");
  render("extracting", "Decrypting backup data...");

  timeline.enter("parsing-contacts");
  render("extracting", "Reading contacts...");

  // Parsing: a progress event per chat scanned, then per 10 conversations.
  timeline.enter("parsing-messages");
  for (let i = 1; i <= WORKLOAD.chats; i++) {
    render("extracting", `Scanning chats: ${i}/${WORKLOAD.chats}`);
  }
  for (let i = 10; i <= WORKLOAD.chats; i += 10) {
    render("extracting", `Loading conversations: ${i}/${WORKLOAD.chats}`);
  }
  timeline.annotate("parsing-messages", {
    conversations: WORKLOAD.chats,
    messages: WORKLOAD.messages,
  });

  timeline.enter("resolving");
  render("extracting", "Resolving contact names...");

  timeline.enter("cleanup");
  render("extracting", "Finalizing...");

  // Persistence: one progress event per item, all three sub-phases.
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

  timeline.enter("storing:contacts");
  for (let i = 1; i <= 900; i++) {
    render("storing", `Saving contacts... ${i} of 900`);
  }
  timeline.annotate("storing:contacts", { stored: 900, skipped: 0 });

  timeline.endSync("complete", {
    messages: WORKLOAD.messages,
    contacts: 900,
    attachments: WORKLOAD.attachments,
  });

  return { rendererLines, mainLines };
}

function totalBytes(replay: { rendererLines: string[]; mainLines: string[] }): number {
  const renderer = replay.rendererLines.reduce(
    (sum, l) => sum + l.length + RENDERER_PREFIX_BYTES + 1,
    0,
  );
  const main = replay.mainLines.reduce((sum, l) => sum + l.length + MAIN_PREFIX_BYTES + 1, 0);
  return renderer + main + OTHER_APP_LOGGING_BYTES;
}

describe("BACKLOG-2898: one worst-case sync fits without rotating", () => {
  const replay = replayWorstCaseSync();

  it("writes fewer bytes than maxSize, so the sync cannot rotate itself away", () => {
    expect(totalBytes(replay)).toBeLessThan(LOG_FILE_MAX_SIZE_BYTES);
  });

  it("turns ~793,000 progress events into a readable number of step lines", () => {
    const events =
      WORKLOAD.backupFileEvents +
      WORKLOAD.chats +
      Math.floor(WORKLOAD.chats / 10) +
      WORKLOAD.messages +
      WORKLOAD.attachments +
      900 +
      5;
    expect(events).toBeGreaterThan(790000);
    // The user is shown a handful of distinct steps across a 40-minute sync.
    expect(replay.rendererLines.length).toBeLessThan(30);
  });

  it("logs one boundary pair per phase — never one per item", () => {
    const phaseStarts = replay.mainLines.filter((l) => l.includes("phase-start"));
    const phaseEnds = replay.mainLines.filter((l) => l.includes("phase-end"));
    expect(phaseStarts).toHaveLength(9);
    expect(phaseEnds).toHaveLength(9);
  });

  it("still records the counts and durations support needs", () => {
    const backupEnd = replay.mainLines.find((l) => l.includes("phase-end phase=backup"));
    expect(backupEnd).toContain("elapsedMs=");
    expect(backupEnd).toContain("incremental=false");
    expect(replay.mainLines.find((l) => l.includes("sync-end"))).toContain("messages=663000");
  });

  it("is far smaller than the 703,761 bytes the SAME sync wrote before this change", () => {
    expect(totalBytes(replay)).toBeLessThan(703761);
  });
});
