/**
 * BACKLOG-3785 repro branch ONLY (never merged). Dev-fixture iPhone sync REPLAY.
 *
 * Active only in dev fixture mode (devFixtureMode.ts) AND KEEPR_DEV_FIXTURE_REPLAY=1.
 * Replaces the device part of `sync:start` (backup + parse) with a SyncResult built from the
 * messages already in the fixture DB, then does exactly what DeviceSyncOrchestrator.sync() does
 * at the end of a real run (deviceSyncOrchestrator.ts ~:1879-1892):
 *     this.emit("complete", result);  return result;
 * so the REAL post-sync path runs unchanged: syncHandlers onSyncComplete -> sync:complete ->
 * persistSyncResult (dedupe, storeMessages, storeAttachments) -> sync:storage-complete ->
 * auto-link -> attached-thread expansion, and the `sync:start` invoke reply carries the same
 * object a real sync returns.
 *
 * KEEPR_DEV_FIXTURE_REPLAY_NEW=<n> (default 53) adds n new messages so messagesStored > 0, as
 * in the founder's beta.2 incremental (53 new). backupPath points at an empty temp dir, so every
 * attachment is skipped as "missing file", as on the PC (64,961 of 64,963 skipped).
 */
import type { EventEmitter } from "events";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import databaseService from "../services/databaseService";
import type { iOSMessage, iOSConversation, iOSAttachment } from "../types/iosMessages";

interface Row {
  external_id: string;
  body_text: string | null;
  participants_flat: string | null;
  direction: string;
  channel: string;
  sent_at: string;
  thread_id: string | null;
  has_attachments: number;
}

export async function runDevSyncReplay(
  orchestrator: EventEmitter,
  log: (msg: string) => void,
): Promise<unknown> {
  const t0 = Date.now();
  const db = databaseService.getRawDatabase();
  const rows = db
    .prepare(
      `SELECT external_id, body_text, participants_flat, direction, channel, sent_at, thread_id, has_attachments
         FROM messages WHERE thread_id LIKE 'ios-chat-%'`,
    )
    .all() as Row[];
  const attRows = db
    .prepare(`SELECT external_message_id, filename, mime_type FROM attachments WHERE external_message_id IS NOT NULL`)
    .all() as { external_message_id: string; filename: string; mime_type: string }[];
  const attByGuid = new Map<string, iOSAttachment[]>();
  let attId = 1;
  for (const a of attRows) {
    const list = attByGuid.get(a.external_message_id) ?? [];
    list.push({
      id: attId++,
      guid: crypto.randomUUID().toUpperCase(),
      filename: `~/Library/SMS/Attachments/aa/00/${a.filename}`,
      mimeType: a.mime_type,
      transferName: a.filename,
    });
    attByGuid.set(a.external_message_id, list);
  }

  const convs = new Map<string, iOSConversation>();
  const messages: iOSMessage[] = [];
  let id = 1;
  const push = (r: Row): void => {
    const date = new Date(r.sent_at);
    const m: iOSMessage = {
      id: id++,
      guid: r.external_id,
      text: r.body_text,
      handle: r.participants_flat ? `+${r.participants_flat}` : "unknown",
      isFromMe: r.direction === "outbound",
      date,
      dateRead: date,
      dateDelivered: date,
      service: r.channel === "imessage" ? "iMessage" : "SMS",
      attachments: attByGuid.get(r.external_id) ?? [],
    };
    messages.push(m);
    const key = r.thread_id ?? "ios-chat-0";
    let c = convs.get(key);
    if (!c) {
      c = {
        chatId: Number(key.replace("ios-chat-", "")) || 0,
        chatIdentifier: m.handle,
        participants: [m.handle],
        messages: [],
        lastMessage: date,
        isGroupChat: false,
      };
      convs.set(key, c);
    }
    c.messages.push(m);
    if (!c.participants.includes(m.handle)) {
      c.participants.push(m.handle);
      c.isGroupChat = c.participants.length > 1;
    }
    if (date > c.lastMessage) c.lastMessage = date;
  };
  for (const r of rows) push(r);
  const nNew = Number(process.env.KEEPR_DEV_FIXTURE_REPLAY_NEW ?? "53");
  for (let i = 0; i < nNew && rows.length > 0; i++) {
    const base = rows[i * 97 % rows.length];
    push({ ...base, external_id: crypto.randomUUID().toUpperCase(), sent_at: new Date().toISOString(), has_attachments: 0 });
  }
  log(`[DEV_REPLAY] built result: messages=${messages.length} conversations=${convs.size} attachments=${attRows.length} buildMs=${Date.now() - t0}`);

  // Parse-phase progress, one event per chat, as the real orchestrator sends (~:1771).
  const conversations = [...convs.values()];
  conversations.forEach((_c, i) => {
    orchestrator.emit("progress", {
      phase: "parsing_messages",
      phaseProgress: Math.round(((i + 1) / conversations.length) * 100),
      overallProgress: 80,
      message: `Loading conversations: ${i + 1}/${conversations.length}`,
    });
  });

  const backupPath = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-dev-replay-"));
  const result = {
    success: true,
    messages,
    contacts: [],
    conversations,
    error: null,
    duration: Date.now() - t0,
    backupPath,
    needsCleanup: false,
    sessionId: crypto.randomUUID(),
  };
  log(`[DEV_REPLAY] emit complete at ${new Date().toISOString()}`);
  orchestrator.emit("complete", result);
  log(`[DEV_REPLAY] emit returned, returning sync:start reply at ${new Date().toISOString()}`);
  // CONTROL (KEEPR_DEV_FIXTURE_REPLAY_SLIM=1): identical run, but the invoke reply carries counts
  // only — the shape the proposed fix would return. Isolates the reply from everything else.
  if (process.env.KEEPR_DEV_FIXTURE_REPLAY_SLIM === "1") {
    return {
      success: true,
      messages: [],
      contacts: [],
      conversations: [],
      error: null,
      duration: result.duration,
      messageCount: messages.length,
      conversationCount: conversations.length,
    };
  }
  return result;
}
