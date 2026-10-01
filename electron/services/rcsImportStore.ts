/**
 * RCS import store — BACKLOG-3619 (proof of concept, text only).
 *
 * Turns one chat sent by the Chrome extension into rows in the existing
 * `messages` table and attaches every one of them to the import session's
 * transaction.
 *
 * - Insert: `databaseService.batchInsertMessages` (INSERT OR IGNORE). The
 *   Android path, `localSyncService.storeMessages`, is the mapping pattern.
 * - Dedup: `external_id = "gmweb:<conversation id>:<msg-id>"`. msg-id is a
 *   number that is NOT unique across conversations (observed on the live
 *   page), so the conversation id is part of the key. The table's unique index is
 *   `(user_id, external_id) WHERE external_id IS NOT NULL`
 *   (`electron/database/schema.sql:1341`), so a re-sent chat inserts nothing.
 * - Attach: after the insert, the stored ids are looked up BY external_id (a
 *   re-send's rows already exist under their original ids), then
 *   `transactionService.linkMessages(ids, transactionId)` — the same call the
 *   manual Attach Messages modal makes. It is idempotent: an existing link
 *   creates no second `communications` row and does not bump the count.
 *
 * BACKLOG-3620 adds, per message: an image count (the bytes arrive separately,
 * one image per request, via `rcsImportMedia.ts`), files seen but not imported
 * (name + size only), and reactions. An image-only message is kept
 * (`message_type = 'attachment_only'`). Reactions become their own rows
 * (`insertReactionRows`), keyed to the parent's external_id, and are linked to
 * the transaction WITHOUT bumping `transactions.message_count` — the count is of
 * messages, and `autoLinkSql.ts` excludes tapbacks from it the same way.
 *
 * `channel` is "sms" because the column's CHECK allows only
 * 'email' | 'sms' | 'imessage' (`schema.sql:746`); the actual transport goes
 * into `metadata.transport`.
 *
 * Dependencies are passed in so this module imports no service singletons;
 * `rcsImportHandlers.ts` supplies the real ones.
 */

import * as crypto from "crypto";

import { rcsReactionExternalId, reactionTypeForEmoji, bareEmoji } from "./rcsReactionMap";

export const RCS_IMPORT_SOURCE = "google_messages_web";
export const RCS_EXTERNAL_ID_PREFIX = "gmweb:";

/** One message as the extension extracts it (chrome-extension/extract.js). */
export interface RcsIncomingMessage {
  msgId: string;
  direction: "inbound" | "outbound";
  sender: string;
  text: string;
  /** ISO-8601 */
  sentAt: string;
  /** From the message's RCS flag; null when the page did not show one. */
  transport: "rcs" | "sms" | null;
  /** Images on the message (BACKLOG-3620). Bytes arrive one per request. */
  images?: number;
  /** Files shown on the message but not imported: name and size only. */
  files?: Array<{ name: string; size: string }>;
  /** Reactions shown on the message (BACKLOG-3620). */
  reactions?: RcsIncomingReaction[];
}

/** One reaction as the extension reads it. */
export interface RcsIncomingReaction {
  /** The emoji shown in the reaction pill. */
  emoji: string;
  /** "me" for the user; otherwise the name from "<Name> reacted with <word>." */
  reactor: string;
  /** The word from the label ("angry", "sad"), when present. */
  word: string;
}

/** One chat as the extension sends it. */
export interface RcsIncomingChat {
  /** From the URL `/web/conversations/<id>`. Required: it is half the dedup key. */
  conversationId: string;
  title: string;
  messages: RcsIncomingMessage[];
}

export interface RcsInsertRow {
  id: string;
  userId: string;
  channel: string;
  externalId: string;
  direction: string;
  bodyText: string | null;
  participants: string;
  participantsFlat: string;
  threadId: string | null;
  sentAt: string;
  hasAttachments: number;
  messageType: string | null;
  metadata: string | null;
}

export interface RcsReactionRow {
  id: string;
  userId: string;
  externalId: string;
  direction: string;
  bodyText: string;
  participants: string;
  participantsFlat: string;
  threadId: string | null;
  sentAt: string;
  metadata: string | null;
  associatedMessageType: number;
  associatedMessageGuid: string;
}

export interface RcsImportDeps {
  getTransactionUserId: (transactionId: string) => Promise<string | null>;
  batchInsertMessages: (
    rows: RcsInsertRow[],
    batchSize: number,
  ) => { stored: number; skipped: number };
  /** external_id -> id for this user. */
  getMessageIdMap: (userId: string) => Map<string, string>;
  linkMessages: (messageIds: string[], transactionId: string) => Promise<void>;
  insertReactionRows: (rows: RcsReactionRow[]) => { stored: number; skipped: number };
  /** Link rows to the transaction without changing transactions.message_count. */
  linkWithoutCount: (messageIds: string[], transactionId: string, userId: string) => Promise<void>;
  /**
   * BACKLOG-3642: what the user removed from this transaction (read at import
   * time). Absent → nothing is treated as removed.
   */
  getRemovals?: (transactionId: string, userId: string) => RcsRemovals;
  /**
   * BACKLOG-3642 (SR O1): write the participant key into the thread's rows
   * already stored without it (before pass 1c, or by a manual Send).
   */
  backfillParticipantKey?: (userId: string, threadId: string, key: string) => void;
}

/**
 * The user's removals from one transaction, as the import needs them:
 * removed gmweb thread ids, removed message ids (thread-less removals), and the
 * participant keys (see `participantKey`) of removed gmweb threads — so a chat
 * whose conversation id changed after a re-pair is still recognised.
 * gmweb only: an SMS phone-backup removal never blocks an RCS chat.
 */
export interface RcsRemovals {
  threadIds: Set<string>;
  messageIds: Set<string>;
  participantKeys: Set<string>;
}

export interface RcsImportOptions {
  /** Participant key of the chat (Sync jobs only; "" or absent when unknown). */
  participantKey?: string;
}

export interface RcsImportResult {
  received: number;
  stored: number;
  alreadyPresent: number;
  linked: number;
  reactions: number;
  reactionsStored: number;
  /** BACKLOG-3642: messages stored but NOT linked — the user removed them. */
  removedByUser?: number;
}

export const RCS_THREAD_PREFIX = "gmweb-chat-";

export function rcsExternalId(conversationId: string, msgId: string): string {
  return `${RCS_EXTERNAL_ID_PREFIX}${conversationId}:${msgId}`;
}

/**
 * Map a chat to insert rows. Pure. `participantKey` (Sync jobs) goes into each
 * row's metadata, so a later removal of this thread can be recognised by its
 * participants (BACKLOG-3642).
 */
export function mapChatToRows(chat: RcsIncomingChat, userId: string, participantKey = ""): RcsInsertRow[] {
  const threadId = `${RCS_THREAD_PREFIX}${chat.conversationId}`;
  const counterpart = chat.title || "Unknown";
  return chat.messages.map((m) => {
    const outbound = m.direction === "outbound";
    const participants = JSON.stringify({
      from: outbound ? "me" : m.sender || counterpart,
      to: outbound ? [counterpart] : ["me"],
    });
    const images = m.images ?? 0;
    const files = m.files ?? [];
    const text = m.text.length > 0 ? m.text : fileOnlyText(files);
    return {
      id: crypto.randomUUID(),
      userId,
      channel: "sms",
      externalId: rcsExternalId(chat.conversationId, m.msgId),
      direction: m.direction,
      bodyText: text.length > 0 ? text : null,
      participants,
      participantsFlat: counterpart,
      threadId,
      sentAt: new Date(m.sentAt).toISOString(),
      hasAttachments: images > 0 ? 1 : 0,
      messageType: m.text.length > 0 ? "text" : "attachment_only",
      metadata: JSON.stringify({
        source: RCS_IMPORT_SOURCE,
        transport: m.transport,
        conversationId: chat.conversationId,
        conversationTitle: chat.title,
        msgId: m.msgId,
        ...(participantKey ? { participantKey } : {}),
        ...(images > 0 ? { images } : {}),
        ...(files.length > 0 ? { filesNotImported: files } : {}),
      }),
    };
  });
}

/** Visible text for a message that only carried files Keepr does not import. */
function fileOnlyText(files: Array<{ name: string; size: string }>): string {
  if (files.length === 0) return "";
  return files
    .map((f) => `[File not imported: ${f.name}${f.size ? ` (${f.size})` : ""}]`)
    .join("\n");
}

/** Map every reaction on a chat to a reaction row. Pure. */
export function mapChatToReactionRows(chat: RcsIncomingChat, userId: string): RcsReactionRow[] {
  const threadId = `gmweb-chat-${chat.conversationId}`;
  const counterpart = chat.title || "Unknown";
  const rows: RcsReactionRow[] = [];
  for (const m of chat.messages) {
    const parentExternalId = rcsExternalId(chat.conversationId, m.msgId);
    for (const r of m.reactions ?? []) {
      const emoji = bareEmoji(r.emoji);
      if (!emoji) continue;
      const mine = r.reactor === "me";
      rows.push({
        id: crypto.randomUUID(),
        userId,
        externalId: rcsReactionExternalId(parentExternalId, r.reactor, emoji),
        direction: mine ? "outbound" : "inbound",
        bodyText: emoji,
        participants: JSON.stringify({
          from: mine ? "me" : r.reactor || counterpart,
          to: mine ? [counterpart] : ["me"],
        }),
        participantsFlat: counterpart,
        threadId,
        // The page shows no reaction time; the parent's time keeps it in order.
        sentAt: new Date(m.sentAt).toISOString(),
        metadata: JSON.stringify({
          source: RCS_IMPORT_SOURCE,
          kind: "reaction",
          emoji,
          word: r.word,
          conversationId: chat.conversationId,
          msgId: m.msgId,
        }),
        associatedMessageType: reactionTypeForEmoji(emoji),
        associatedMessageGuid: parentExternalId,
      });
    }
  }
  return rows;
}

/** Store one chat and attach all of its messages to `transactionId`. */
export async function importChat(
  chat: RcsIncomingChat,
  transactionId: string,
  deps: RcsImportDeps,
  opts: RcsImportOptions = {},
): Promise<RcsImportResult> {
  const userId = await deps.getTransactionUserId(transactionId);
  if (!userId) {
    throw new Error("Transaction not found");
  }

  const key = opts.participantKey ?? "";
  const rows = mapChatToRows(chat, userId, key);
  // Rows are ALWAYS stored (dedup keeps working); only the link respects the
  // user's removals.
  const { stored, skipped } = deps.batchInsertMessages(rows, 500);
  // Rows stored earlier keep their metadata (INSERT OR IGNORE): backfill the key.
  if (key !== "" && deps.backfillParticipantKey) {
    deps.backfillParticipantKey(userId, `${RCS_THREAD_PREFIX}${chat.conversationId}`, key);
  }

  const reactionRows = mapChatToReactionRows(chat, userId);
  const reactionResult =
    reactionRows.length > 0 ? deps.insertReactionRows(reactionRows) : { stored: 0, skipped: 0 };

  // BACKLOG-3642: a chat the user removed from this transaction is never linked
  // again — by its thread id, or (after a re-pair changed the conversation id)
  // by the same participant set as a removed gmweb thread.
  const removals = deps.getRemovals ? deps.getRemovals(transactionId, userId) : null;
  const threadId = `${RCS_THREAD_PREFIX}${chat.conversationId}`;
  const chatRemoved =
    !!removals && (removals.threadIds.has(threadId) || (key !== "" && removals.participantKeys.has(key)));
  const keep = (id: string): boolean => !chatRemoved && !(removals?.messageIds.has(id) ?? false);

  const idMap = deps.getMessageIdMap(userId);
  const ids: string[] = [];
  for (const row of rows) {
    const id = idMap.get(row.externalId);
    if (id) ids.push(id);
  }
  const linkIds = ids.filter(keep);
  if (linkIds.length > 0) {
    await deps.linkMessages(linkIds, transactionId);
  }

  // Reactions are linked (the loader joins communications by message id) but
  // never counted: message_count is a count of messages.
  const reactionIds: string[] = [];
  for (const row of reactionRows) {
    const id = idMap.get(row.externalId);
    if (id && keep(id)) reactionIds.push(id);
  }
  if (reactionIds.length > 0) {
    await deps.linkWithoutCount(reactionIds, transactionId, userId);
  }

  return {
    received: chat.messages.length,
    stored,
    alreadyPresent: skipped,
    linked: linkIds.length,
    reactions: reactionRows.length,
    reactionsStored: reactionResult.stored,
    removedByUser: ids.length - linkIds.length,
  };
}

/** Validate an untrusted request body into a chat, or return an error string. */
export function parseIncomingChat(body: unknown): RcsIncomingChat | string {
  if (!body || typeof body !== "object") return "Body must be a JSON object";
  const b = body as Record<string, unknown>;
  if (typeof b.title !== "string") return "title must be a string";
  if (typeof b.conversationId !== "string" || b.conversationId.length === 0) {
    return "conversationId is required";
  }
  if (!Array.isArray(b.messages)) return "messages must be an array";
  const messages: RcsIncomingMessage[] = [];
  for (const raw of b.messages as unknown[]) {
    if (!raw || typeof raw !== "object") return "each message must be an object";
    const m = raw as Record<string, unknown>;
    if (typeof m.msgId !== "string" || m.msgId.length === 0) return "message.msgId is required";
    if (m.direction !== "inbound" && m.direction !== "outbound") return "message.direction is invalid";
    if (typeof m.sender !== "string") return "message.sender must be a string";
    if (typeof m.text !== "string") return "message.text must be a string";
    const images = m.images ?? 0;
    if (typeof images !== "number" || !Number.isInteger(images) || images < 0 || images > 99) {
      return "message.images must be an integer 0-99";
    }
    const files = parseFiles(m.files);
    if (typeof files === "string") return files;
    const reactions = parseReactions(m.reactions);
    if (typeof reactions === "string") return reactions;
    if (m.text.length === 0 && images === 0 && files.length === 0) {
      return "message.text is empty and the message has no images or files";
    }
    if (typeof m.sentAt !== "string" || Number.isNaN(Date.parse(m.sentAt))) {
      return "message.sentAt must be an ISO date";
    }
    const transport = m.transport ?? null;
    if (transport !== null && transport !== "rcs" && transport !== "sms") {
      return "message.transport must be rcs, sms or null";
    }
    messages.push({
      msgId: m.msgId,
      direction: m.direction,
      sender: m.sender,
      text: m.text,
      sentAt: m.sentAt,
      transport,
      images,
      files,
      reactions,
    });
  }
  return {
    conversationId: b.conversationId,
    title: b.title,
    messages,
  };
}

function parseFiles(raw: unknown): Array<{ name: string; size: string }> | string {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return "message.files must be an array";
  const out: Array<{ name: string; size: string }> = [];
  for (const f of raw as unknown[]) {
    if (!f || typeof f !== "object") return "each file must be an object";
    const o = f as Record<string, unknown>;
    if (typeof o.name !== "string") return "file.name must be a string";
    out.push({ name: o.name.slice(0, 300), size: typeof o.size === "string" ? o.size.slice(0, 40) : "" });
  }
  return out;
}

function parseReactions(raw: unknown): RcsIncomingReaction[] | string {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return "message.reactions must be an array";
  const out: RcsIncomingReaction[] = [];
  for (const r of raw as unknown[]) {
    if (!r || typeof r !== "object") return "each reaction must be an object";
    const o = r as Record<string, unknown>;
    if (typeof o.emoji !== "string" || o.emoji.length === 0 || o.emoji.length > 32) {
      return "reaction.emoji must be a short string";
    }
    if (typeof o.reactor !== "string") return "reaction.reactor must be a string";
    out.push({
      emoji: o.emoji,
      reactor: o.reactor.slice(0, 200),
      word: typeof o.word === "string" ? o.word.slice(0, 60) : "",
    });
  }
  return out;
}
