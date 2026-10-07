/**
 * BACKLOG-3658 (founder, live) — a Google Messages cache Sync on the dashboard
 * indicator through the orchestrator queue (like iPhone Sync, TASK-2119).
 *
 * Mutations that turn this red:
 *   I1 a transaction Sync (not cache) put on the indicator           → "only cache Syncs"
 *   I2 progress not parsed from "Chat N of M" / paused not shown       → "progress"
 *   I3 completed without the saved counts, or before they are known    → "saved counts"
 *   I4 a cancel shown as complete / error (not removed)                → "a cancel"
 *   I5 a failed Sync not an error                                      → "failed"
 */
import type { RcsJobInfo } from "../../../electron/types/ipc/window-api-rcs-import";

const calls: string[] = [];
jest.mock("../../services/SyncOrchestratorService", () => ({
  syncOrchestrator: {
    registerExternalSync: (t: string) => calls.push(`register ${t}`),
    updateExternalSync: (t: string, u: unknown) => calls.push(`update ${t} ${JSON.stringify(u)}`),
    completeExternalSync: (t: string, r: unknown) => calls.push(`complete ${t} ${JSON.stringify(r)}`),
    removeExternalSync: (t: string) => calls.push(`remove ${t}`),
  },
}));
jest.mock("../../services/rcsImportService", () => ({ rcsImportService: { onJobProgress: () => () => undefined } }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { applyGoogleMessagesJob } = require("../useGoogleMessagesSyncStatus") as typeof import("../useGoogleMessagesSyncStatus");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { orchestratorStepFor, GM_PAUSED_PHASE } = require("../googleMessagesSyncStatus") as typeof import("../googleMessagesSyncStatus");

function job(over: Partial<RcsJobInfo>): RcsJobInfo {
  return {
    jobId: "job-1", transactionId: "", kind: "cache", state: "running", stage: "",
    progress: { listed: 0, candidates: 0, checked: 0, matched: 0, imported: 0, messages: 0, images: 0, reactions: 0, skipped: 0 },
    contactsWithoutPhone: [], createdAt: "2026-10-02T10:00:00.000Z", ...over,
  } as RcsJobInfo;
}

beforeEach(() => {
  calls.length = 0;
});

describe("Google Messages on the dashboard indicator", () => {
  it("only cache Syncs (I1): a job without kind \"cache\" is ignored", () => {
    expect(orchestratorStepFor(job({ kind: undefined }))).toEqual({ kind: "ignore" });
    applyGoogleMessagesJob(job({ kind: undefined }), new Set());
    expect(calls).toEqual([]);
  });

  it("progress: chat N of M as a percent; paused as \"Keep the Messages tab on screen\" (I2)", () => {
    const ended = new Set<string>();
    applyGoogleMessagesJob(job({ stage: "Chat 4 of 21" }), ended);
    expect(calls).toEqual([
      "register google-messages",
      `update google-messages ${JSON.stringify({ progress: 19, phase: "chat 4 of 21", indeterminate: false })}`,
    ]);
    expect(orchestratorStepFor(job({ stage: "Keep this Chrome window visible — Sync paused" }))).toEqual({
      kind: "progress", progress: 0, phase: GM_PAUSED_PHASE, indeterminate: true,
    });
    expect(GM_PAUSED_PHASE).toBe("Keep the Messages tab on screen");
  });

  it("saved counts: \"saving\" until Keepr has saved, then complete with the counts, once (I3)", () => {
    const ended = new Set<string>();
    applyGoogleMessagesJob(job({ state: "finished" }), ended);
    expect(calls.join("\n")).toContain('"phase":"saving in Keepr"');
    calls.length = 0;
    applyGoogleMessagesJob(job({ state: "finished", saved: { chats: 7, messages: 212, newMessages: 200 } }), ended);
    expect(calls).toEqual([
      "register google-messages",
      `complete google-messages ${JSON.stringify({ status: "complete", summary: "Google Messages: saved 7 chats · 212 messages (200 new)" })}`,
    ]);
    calls.length = 0;
    applyGoogleMessagesJob(job({ state: "finished", saved: { chats: 7, messages: 212, newMessages: 200 } }), ended);
    expect(calls).toEqual([]);
  });

  it("a cancel is removed, never shown as complete (I4)", () => {
    applyGoogleMessagesJob(job({ state: "cancelled" }), new Set());
    expect(calls).toEqual(["remove google-messages"]);
  });

  // SR U1 (H02): the bubble says the short line for the failure's code —
  // never the long message. Mutation: job.error.message shown → red.
  it("failed: the short line for its code; a failed save too (I5)", () => {
    applyGoogleMessagesJob(job({ state: "failed", error: { code: "connection_lost", message: "Keepr stopped: Messages for Web could not reconnect to your phone for 5 minutes. Check your phone, then sync again from Keepr." } }), new Set());
    expect(calls[1]).toBe(`complete google-messages ${JSON.stringify({ status: "error", error: "Lost the connection to your phone." })}`);
    expect(orchestratorStepFor(job({ state: "finished", saved: null }))).toEqual({ kind: "error", error: "Keepr couldn't save this Sync." });
    expect(orchestratorStepFor(job({ state: "failed", error: { code: "something_new", message: "x".repeat(200) } }))).toEqual({ kind: "error", error: "The Sync stopped unexpectedly." });
  });
});
