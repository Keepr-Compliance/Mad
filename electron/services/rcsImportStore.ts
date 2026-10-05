/**
 * RCS import store — BACKLOG-3619 (proof of concept, text only).
 *
 * Turns one chat sent by the Chrome extension into rows in the existing
 * `messages` table and attaches every one of them to the import session's
 * transaction.
 *
 * - Insert: `databaseService.batchInsertMessages` (INSERT OR IGNORE). The
 *   Android path, `localSyncService.storeMessages`, is the mapping pattern.
 * - Dedup (BACKLOG-3630): `external_id = "gmweb2:<h>:<msg-id>"`, thread
 *   `gmweb2-<h>`, where <h> = sha256 of the chat's sorted, normalized E.164
 *   participant numbers (the user's own number excluded, by the page). The URL
 *   conversation id is NOT in the key: it changes on every re-pair (measured),
 *   while the numbers and msg-ids do not. The table's unique index is
 *   `(user_id, external_id) WHERE external_id IS NOT NULL`
 *   (`electron/database/schema.sql:1341`), so a re-sent chat inserts nothing.
 *   A content guard also skips a row when the user already has a gmweb2 row
 *   with the same sent_at + direction + body (the key drifts when a group's
 *   members change). Old `gmweb:` rows are not migrated: Force re-import
 *   clears them.
 * - participants / participants_flat hold the E.164 NUMBERS (as the Android
 *   path does), so the existing phone auto-link can match them.
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

import { participantKey } from "./rcsImportJob";
import { rcsReactionExternalId, reactionTypeForEmoji, bareEmoji } from "./rcsReactionMap";
import { toE164, toLookupKey } from "../utils/phoneNormalization";
import { chatPeopleRows, isNumberAsName, type RcsChatPersonRow } from "./db/rcsChatPeopleDbService";

export const RCS_IMPORT_SOURCE = "google_messages_web";
/** BACKLOG-3658: rows saved by the cache job (no transaction at import time). */
export const RCS_CACHE_SOURCE = "gmweb-cache";
/** BACKLOG-3630: the stable key. */
export const RCS_EXTERNAL_ID_PREFIX = "gmweb2:";
export const RCS_THREAD_PREFIX = "gmweb2-";
/** Pre-3630 rows (keyed on the URL conversation id); read for removals only. */
export const RCS_LEGACY_EXTERNAL_ID_PREFIX = "gmweb:";
export const RCS_LEGACY_THREAD_PREFIX = "gmweb-chat-";
/** BACKLOG-3630: a chat whose Details showed no phone number cannot be keyed. */
export const RCS_NO_NUMBER_MESSAGE = "Open the chat's Details: no phone number found";

/**
 * BACKLOG-3630: who is in a chat, from its Details panel. `numbers` are the
 * normalized E.164 numbers, sorted and unique (the user's own excluded);
 * `names` pairs a shown name with its number, to resolve group senders.
 */
export interface RcsChatPeople {
  numbers: string[];
  names: Array<{ name: string; number: string }>;
}

/** The chat's stable hash: sha256 of its sorted, normalized numbers. */
export function rcsChatHash(numbers: readonly string[]): string {
  return crypto.createHash("sha256").update(participantKey(numbers)).digest("hex");
}

/**
 * Validate the page's Details rows ({name, number}[]) into RcsChatPeople.
 * Numbers that do not normalize to "+…" are dropped. When `allowed` is given
 * (a Sync job: the numbers its /match saw), the numbers ARE those and only
 * rows on them are kept for names.
 */
export function peopleFrom(rows: unknown, allowed?: readonly string[]): RcsChatPeople {
  const names: Array<{ name: string; number: string }> = [];
  const found = new Set<string>();
  if (Array.isArray(rows)) {
    for (const r of (rows as unknown[]).slice(0, 50)) {
      if (!r || typeof r !== "object") continue;
      const rec = r as Record<string, unknown>;
      if (typeof rec.number !== "string") continue;
      const e = toE164(rec.number);
      if (!e || !e.startsWith("+")) continue;
      found.add(e);
      if (typeof rec.name === "string" && rec.name.trim()) names.push({ name: rec.name.trim().slice(0, 120), number: e });
    }
  }
  if (allowed) {
    const set = new Set(participantKey(allowed).split(",").filter(Boolean));
    return { numbers: Array.from(set).sort(), names: names.filter((n) => set.has(n.number)) };
  }
  return { numbers: Array.from(found).sort(), names };
}

function numbersIn(flat: string | null | undefined): string[] {
  return String(flat || "")
    .split(/,\s*/)
    .map((n) => n.trim())
    .filter((n) => n.startsWith("+"));
}

function fromOf(participants: string | null | undefined): string | null {
  try {
    const parsed = JSON.parse(String(participants || "")) as { from?: unknown };
    return typeof parsed.from === "string" ? parsed.from : null;
  } catch {
    return null;
  }
}

/**
 * BACKLOG-3630 (SR F1): is an existing gmweb2 row (same sent_at + direction +
 * body, a candidate of the content guard) about the SAME people as a new row?
 * sent_at has minute precision, so "Ok" from two different chats in the same
 * minute must never collapse into one. Inbound: the new row's sender number is
 * the old row's `from` or one of its numbers (an unresolved sender — no
 * number — never matches). Outbound: the two chats share at least one number.
 */
export function samePeople(
  row: { direction: string; participants: string; participantsFlat: string },
  old: { participants: string | null; participantsFlat: string | null },
): boolean {
  const oldNumbers = numbersIn(old.participantsFlat);
  if (row.direction === "inbound") {
    const sender = fromOf(row.participants);
    if (!sender || !sender.startsWith("+")) return false;
    return fromOf(old.participants) === sender || oldNumbers.includes(sender);
  }
  const mine = new Set(numbersIn(row.participantsFlat));
  return oldNumbers.some((n) => mine.has(n));
}

/** A group sender's number: only when the shown name maps to exactly one number. */
export function senderNumber(sender: string, people: RcsChatPeople): string | null {
  const wanted = sender.trim().toLowerCase();
  if (!wanted) return null;
  const hits = new Set(people.names.filter((n) => n.name.toLowerCase() === wanted).map((n) => n.number));
  if (hits.size === 1) return Array.from(hits)[0];
  /**
   * Live (founder's DevTools, 2026-10-04): a group sender with no saved name
   * is shown by Google Messages as its number in NATIONAL format — "(480)
   * 555-0123". That string was stored as the message's handle, so the
   * message-derived contact "msg_(480) 555-0123" never matched the saved
   * contact's E.164 phone and every press imported another one. A
   * number-shaped sender is a NUMBER: the member with the same lookup key
   * (toLookupKey — the repo's one key, BACKLOG-2630), else the number itself
   * via toE164 (DEFAULT_PHONE_REGION) — never the display string.
   */
  if (isNumberAsName(wanted)) {
    const key = toLookupKey(wanted);
    const member = people.numbers.filter((n) => toLookupKey(n) === key);
    if (member.length === 1) return member[0];
    const e164 = toE164(wanted);
    if (/^\+[1-9]\d{9,14}$/.test(e164)) return e164;
  }
  return null;
}

/**
 * participants JSON, as the Android path writes it (localSyncService.ts
 * storeMessages): 1:1 inbound {from: number, to: ["me"]}, outbound {from:
 * "me", to: [all numbers]}. Group inbound: from = the sender's number when the
 * name resolves to exactly one number, else the shown name; to = "me" and the
 * other numbers. Every group row also carries `chat_members` (all numbers),
 * which the conversation grouping (threadMergeUtils) treats as authoritative,
 * so a group never looks like a 1:1 chat with its only sender.
 */
export function participantsJson(direction: "inbound" | "outbound", sender: string, people: RcsChatPeople): string {
  const group = people.numbers.length > 1;
  const members = group ? { chat_members: people.numbers } : {};
  if (direction === "outbound") return JSON.stringify({ from: "me", to: people.numbers, ...members });
  if (!group) return JSON.stringify({ from: people.numbers[0], to: ["me"] });
  const from = senderNumber(sender, people);
  return JSON.stringify({
    from: from ?? (sender || "unknown"),
    to: ["me", ...people.numbers.filter((n) => n !== from)],
    ...members,
  });
}

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
  /**
   * Founder (2026-10-02): what a quoted reply quotes — captured now, shown
   * later. The quoted message's msg-id when the page matched it uniquely in
   * the same chat; else a short snippet and who sent it ("me" | "them";
   * never a name). Stored in the row's metadata only.
   */
  replyTo?: RcsReplyTo;
}

/** A reply's quoted message: by id (same chat) or by snippet. */
export type RcsReplyTo = { msgId: string } | { snippet: string; sender: "me" | "them" };

/** Snippet cap (characters) for a reply's quoted text. */
export const RCS_REPLY_SNIPPET_MAX = 80;

/** Untrusted replyTo → a clean value, or undefined (dropped, never an error). */
export function parseReplyTo(raw: unknown): RcsReplyTo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.msgId === "string" && /^[\w.:-]{1,64}$/.test(r.msgId)) return { msgId: r.msgId };
  if (typeof r.snippet === "string" && (r.sender === "me" || r.sender === "them")) {
    // Control characters out, whitespace collapsed, capped.
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    const snippet = r.snippet.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, RCS_REPLY_SNIPPET_MAX);
    if (snippet.length > 0) return { snippet, sender: r.sender };
  }
  return undefined;
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
  /**
   * SR (2026-10-02): the page read this chat's history down to its floor
   * (not cut by the cap, not unsettled, no gap). A boolean only.
   */
  reachedFloor?: boolean;
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
  batchInsertMessages: (
    rows: RcsInsertRow[],
    batchSize: number,
  ) => { stored: number; skipped: number };
  /** external_id -> id for this user. */
  getMessageIdMap: (userId: string) => Map<string, string>;
  insertReactionRows: (rows: RcsReactionRow[]) => { stored: number; skipped: number };
  /**
   * BACKLOG-3630: for rows about to be inserted, the id of an EXISTING gmweb2
   * row of the user with the same sent_at + direction + body (external_id ->
   * existing id). Those rows are not inserted; the existing row is linked.
   */
  findContentDuplicates?: (userId: string, rows: RcsInsertRow[]) => Map<string, string>;
  // (Real one: syncDbService.findRcsContentDuplicates — same people only, never empty bodies.)
  /**
   * BACKLOG-3670: record the stored chat's people (member numbers + the names
   * shown for them) for "people found in texts". Local only.
   */
  recordPeople?: (userId: string, chatHash: string, rows: RcsChatPersonRow[], lastMessageAt: string | null) => void;
}

/** The newest message time of a chat, or null. */
function lastSentAt(chat: RcsIncomingChat): string | null {
  let max: number | null = null;
  for (const m of chat.messages) {
    const t = Date.parse(m.sentAt);
    if (Number.isFinite(t) && (max === null || t > max)) max = t;
  }
  return max === null ? null : new Date(max).toISOString();
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
  /** BACKLOG-3630: messages already stored under another key (content guard). */
  sameContent?: number;
}

/** BACKLOG-3630: `gmweb2:<chat hash>:<msg-id>`. */
export function rcsExternalId(chatHash: string, msgId: string): string {
  return `${RCS_EXTERNAL_ID_PREFIX}${chatHash}:${msgId}`;
}

/**
 * Map a chat to insert rows. Pure. BACKLOG-3630: the key and thread come from
 * the chat's numbers (`people`), never from the URL conversation id, and
 * participants / participants_flat carry the numbers.
 */
export function mapChatToRows(
  chat: RcsIncomingChat,
  userId: string,
  people: RcsChatPeople,
  source: string = RCS_IMPORT_SOURCE,
): RcsInsertRow[] {
  const hash = rcsChatHash(people.numbers);
  const threadId = `${RCS_THREAD_PREFIX}${hash}`;
  const flat = people.numbers.join(", ");
  return chat.messages.map((m) => {
    const participants = participantsJson(m.direction, m.sender, people);
    const images = m.images ?? 0;
    const files = m.files ?? [];
    const text = m.text.length > 0 ? m.text : fileOnlyText(files);
    return {
      id: crypto.randomUUID(),
      userId,
      channel: "sms",
      externalId: rcsExternalId(hash, m.msgId),
      direction: m.direction,
      bodyText: text.length > 0 ? text : null,
      participants,
      participantsFlat: flat,
      threadId,
      sentAt: new Date(m.sentAt).toISOString(),
      hasAttachments: images > 0 ? 1 : 0,
      messageType: m.text.length > 0 ? "text" : "attachment_only",
      metadata: JSON.stringify({
        source,
        transport: m.transport,
        conversationId: chat.conversationId,
        conversationTitle: chat.title,
        msgId: m.msgId,
        ...(images > 0 ? { images } : {}),
        ...(files.length > 0 ? { filesNotImported: files } : {}),
        // Founder: a quoted reply's reply-to, captured (shown later).
        ...(m.replyTo && "msgId" in m.replyTo ? { reply_to_external_id: rcsExternalId(hash, m.replyTo.msgId) } : {}),
        ...(m.replyTo && "snippet" in m.replyTo ? { reply_snippet: m.replyTo.snippet, reply_sender: m.replyTo.sender } : {}),
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
export function mapChatToReactionRows(
  chat: RcsIncomingChat,
  userId: string,
  people: RcsChatPeople,
  source: string = RCS_IMPORT_SOURCE,
): RcsReactionRow[] {
  const hash = rcsChatHash(people.numbers);
  const threadId = `${RCS_THREAD_PREFIX}${hash}`;
  const flat = people.numbers.join(", ");
  const rows: RcsReactionRow[] = [];
  for (const m of chat.messages) {
    const parentExternalId = rcsExternalId(hash, m.msgId);
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
        participants: participantsJson(mine ? "outbound" : "inbound", r.reactor, people),
        participantsFlat: flat,
        threadId,
        // The page shows no reaction time; the parent's time keeps it in order.
        sentAt: new Date(m.sentAt).toISOString(),
        metadata: JSON.stringify({
          source,
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

/** The writers a cache chat uses (all synchronous). */
export type RcsCacheChatDeps = Pick<
  RcsImportDeps,
  "batchInsertMessages" | "getMessageIdMap" | "insertReactionRows" | "findContentDuplicates" | "recordPeople"
>;

/**
 * BACKLOG-3658: store one chat of the cache job for `userId`: same key, rows
 * and content guard as a transaction Sync, tagged source "gmweb-cache", and
 * NOT linked to anything — the phone auto-link attaches it afterwards.
 */
export async function importCacheChat(
  chat: RcsIncomingChat,
  userId: string,
  deps: RcsCacheChatDeps,
  people: RcsChatPeople,
): Promise<RcsImportResult> {
  return storeCacheChatSync(chat, userId, deps, people);
}

/**
 * The same, synchronous: the atomic cache commit (rcsCacheStaging.ts) runs it
 * for every chat inside ONE database transaction, where a throw must roll back
 * (an async function would turn it into a rejection after the commit).
 */
export function storeCacheChatSync(
  chat: RcsIncomingChat,
  userId: string,
  deps: RcsCacheChatDeps,
  people: RcsChatPeople,
): RcsImportResult {
  if (people.numbers.length === 0) throw new Error(RCS_NO_NUMBER_MESSAGE);
  const rows = mapChatToRows(chat, userId, people, RCS_CACHE_SOURCE);
  const before = deps.getMessageIdMap(userId);
  const fresh = rows.filter((r) => !before.has(r.externalId));
  const sameContent = deps.findContentDuplicates && fresh.length > 0
    ? deps.findContentDuplicates(userId, fresh)
    : new Map<string, string>();
  const toInsert = sameContent.size > 0 ? rows.filter((r) => !sameContent.has(r.externalId)) : rows;
  const { stored, skipped } = deps.batchInsertMessages(toInsert, 500);
  // BACKLOG-3670: inside the cache commit's transaction (this runs in it).
  deps.recordPeople?.(userId, rcsChatHash(people.numbers), chatPeopleRows(people, chat.title), lastSentAt(chat));
  const reactionRows = mapChatToReactionRows(chat, userId, people, RCS_CACHE_SOURCE);
  const reactionResult =
    reactionRows.length > 0 ? deps.insertReactionRows(reactionRows) : { stored: 0, skipped: 0 };
  return {
    received: chat.messages.length,
    stored,
    alreadyPresent: skipped + sameContent.size,
    linked: 0,
    reactions: reactionRows.length,
    reactionsStored: reactionResult.stored,
    removedByUser: 0,
    sameContent: sameContent.size,
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
    const replyTo = parseReplyTo(m.replyTo);
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
      ...(replyTo ? { replyTo } : {}),
    });
  }
  return {
    conversationId: b.conversationId,
    title: b.title,
    messages,
    ...(b.reachedFloor === true ? { reachedFloor: true } : {}),
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
