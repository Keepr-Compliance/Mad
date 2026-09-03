/**
 * MMS mapping — getting the TEXT out of an MMS (BACKLOG-2974).
 *
 * Pure functions over the {@link RawMmsRecord} rows `mmsReader.readMmsMessages()`
 * already returns. No provider access and no second native call: 2973 attaches
 * each message's `part` and `addr` rows to the row itself, so everything this
 * file needs is in its argument.
 *
 * ## Why an MMS needs a mapper at all
 *
 * An SMS row carries its text in `body`. An MMS row has no `body` column. The
 * text lives in `content://mms/{id}/part` as its own row with its own content
 * type, and **every MMS also carries a SMIL part** — an XML layout document
 * describing where the slides go, not anything a person wrote:
 *
 * ```xml
 * <part seq="-1" ct="application/smil" cl="smil.xml" text="&lt;smil&gt;..." />
 * <part seq="0"  ct="text/plain" chset="106" cl="text_0.txt" text="Where is Santa Clause?" />
 * ```
 *
 * A reader that takes "the first part" ingests the markup as the message.
 *
 * ## What this file deliberately does NOT produce: `SyncMessage`
 *
 * It stops one type short, and that boundary is the finding, not an omission:
 *
 *  - **`SyncMessage.sender` is a required string and there is no sender here.**
 *    `content://mms` has no `address` column at all; participants exist only in
 *    the `addr` rows, which is BACKLOG-2975. Filling it in would mean writing
 *    `sender: "unknown"` for every message — the placeholder 2973 refused for
 *    the same reason.
 *  - **`SyncMessage.body` is a required string and cannot represent "no body".**
 *    A photo with no caption is a real message with no text. Every string that
 *    could go there is invented, and `""` in particular poisons the desktop's
 *    dedup key, `SHA-256(sender|timestamp|body)` — two photo-only messages from
 *    one person in one second would hash identically and one would be dropped
 *    as a duplicate that never existed.
 *
 * So {@link MappedMms} is the envelope-and-text half. BACKLOG-2975 supplies the
 * participants and completes the map; the empty-body question it inherits is
 * recorded on BACKLOG-2977.
 */

import {
  mmsDateToMillis,
  type RawMmsPart,
  type RawMmsRecord,
} from "./mmsReader";

/**
 * The content type a part must declare to be part of the message TEXT.
 *
 * Selection is by content type and never by position. `ct` is what the part
 * itself declares; `seq` is a layout convention — and the `seq = -1` placement
 * of the SMIL part is transcribed from an SMS Backup & Restore export, NOT
 * observed from what Google Messages writes (BACKLOG-2973 provider notes). A
 * part-order assumption is the defect this module exists to avoid.
 *
 * Note the direction of the test: parts are selected IN by being `text/plain`,
 * not filtered OUT by being SMIL. Filtering out means every content type nobody
 * has thought about yet becomes message text by default — `text/x-vCard`, an
 * attached contact card, would be concatenated into the body as if a person had
 * typed it. Selecting in fails closed.
 */
export const MMS_TEXT_CONTENT_TYPE = "text/plain";

/**
 * The SMIL layout part's content type. Exported for tests and callers that want
 * to name it; the mapper never tests against it, because {@link
 * MMS_TEXT_CONTENT_TYPE} selection already excludes it and everything else.
 */
export const MMS_SMIL_CONTENT_TYPE = "application/smil";

/**
 * Prefix that makes an MMS row id distinguishable from an SMS row id.
 *
 * `content://sms._id` and `content://mms._id` are separate autoincrements, so
 * MMS row 5 and SMS row 5 are different messages sharing a number. `smsId` is
 * the local queue's de-duplication key (BACKLOG-2199); un-namespaced, the second
 * of the two to arrive is silently discarded as a duplicate. `thread_id` is the
 * opposite case and is deliberately kept RAW — both tables reference the same
 * `threads` table, which is what lets an SMS and an MMS in one conversation
 * group together.
 */
export const MMS_ID_NAMESPACE = "mms:";

/**
 * Separator used when a message has several text parts.
 *
 * A multi-slide MMS carries one `text/plain` part per slide; they are separate
 * display units, so joining with `""` runs the last word of one slide into the
 * first word of the next. The choice matters beyond looks: the desktop hashes
 * the body, so the separator has to be fixed and deterministic or the same
 * message hashes differently on a re-read.
 */
export const MMS_TEXT_PART_SEPARATOR = "\n";

/** `msg_box` value for a received message. */
const MMS_BOX_INBOX = "1";
/** `msg_box` value for a sent message. */
const MMS_BOX_SENT = "2";

/**
 * The text content of one MMS, as three DISTINGUISHABLE outcomes.
 *
 * They are three and not one string because collapsing them is this codebase's
 * recurring defect (BACKLOG-1448 / 2206, at message granularity; the rejected
 * `react-native-get-mms-android` does it at part granularity by swallowing an
 * `IOException` and returning `""`). "The message says nothing", "the message
 * has no text at all" and "the message has text we could not read" are three
 * different facts, and only one of them is safe to hash.
 */
export type MmsBody =
  /** At least one `text/plain` part, and every one of them was readable. */
  | { kind: "text"; text: string }
  /**
   * No `text/plain` part exists. A photo with no caption, or a row with no
   * parts at all (an undownloaded stub). NOT an empty string: the message has
   * no body, which is a different thing from a body that is empty.
   *
   * `attachmentContentTypes` lists the non-SMIL content types that ARE present,
   * in provider order — what BACKLOG-2977 needs to record that a photo existed
   * without transferring it. Empty for a part-less row.
   */
  | { kind: "no_text_part"; attachmentContentTypes: string[] }
  /**
   * A `text/plain` part exists but its text was not recovered — the provider
   * returned a null `text` column, meaning the content is in the provider's own
   * file store behind `_data` and nothing in this chain streams it yet.
   *
   * This is a READ FAILURE for the body and must never be reported as an empty
   * message. `partIds` names the parts so the gap can be chased.
   */
  | { kind: "unreadable"; partIds: string[] };

/**
 * One MMS, mapped as far as it can be mapped without participants.
 *
 * Field-for-field a `SyncMessage` minus `sender` — deliberately, so BACKLOG-2975
 * completes it by adding one field rather than by re-deriving anything here.
 */
export interface MappedMms {
  /** `mms:<_id>`. See {@link MMS_ID_NAMESPACE}. */
  smsId: string;
  /**
   * The provider's `thread_id`, raw and un-namespaced, or undefined when the
   * row carries none. `SyncMessage.threadId` is optional, so undefined is
   * representable — an empty string would be a made-up thread that groups every
   * thread-less message together.
   */
  threadId?: string;
  /**
   * Milliseconds, normalised from `date` by {@link mmsDateToMillis}.
   *
   * From `date`, NOT `date_sent` — a deliberate divergence from the SMS mapper
   * (`rawToSyncMessage` prefers `date_sent`). `date` is the column the native
   * query sorts by and the column the cursor floor filters on; taking the
   * timestamp from a different column than the cursor breaks the contiguous
   * prefix that BACKLOG-2199 rests on, and `date_sent` is frequently 0 with a
   * unit that has never been observed either.
   *
   * This choice FIXES every MMS hash. Changing it later to "match SMS" rehashes
   * every already-synced MMS into a fresh duplicate on the desktop.
   */
  timestamp: number;
  /** From `msg_box`: 1 -> inbound, 2 -> outbound. Never guessed. */
  direction: "inbound" | "outbound";
  /** See {@link MmsBody}. */
  body: MmsBody;
}

/**
 * Why a row could not be mapped.
 *
 * A message with no text is NOT here — that maps to a real record with
 * `body.kind = "no_text_part"`, because dropping it is how a photo-only thread
 * silently vanishes from an audit. These three are rows that cannot be turned
 * into a record at all without inventing the thing that is missing.
 */
export type MmsMapSkipReason =
  /** No `_id`, so there is no stable de-duplication key. */
  | "missing_id"
  /**
   * `date` is missing or unparseable. BACKLOG-2202: a `Date.now()` fallback
   * makes re-reads of the same row hash differently every cycle, so an undated
   * row is reported rather than dated.
   */
  | "unusable_date"
  /**
   * `msg_box` is neither 1 nor 2. Not defaulted to inbound: that attributes an
   * agent's own sent message to the client, and in a compliance audit a wrong
   * record is worse than a counted absence. Boxes 3/4/5 are draft/outbox/failed
   * and are not delivered messages in the first place.
   */
  | "unsupported_msg_box";

/**
 * A row that was not mapped, with enough to log and count it.
 *
 * `detail` carries provider metadata only — an id, a date, a box number. It
 * never quotes part text, because a diagnostic is not worth a PII path.
 */
export interface MmsMapSkip {
  reason: MmsMapSkipReason;
  /** The row's `_id`, or null when the absence of one is the reason. */
  id: string | null;
  detail: string;
}

/** What {@link mapMmsRecords} returns: what mapped, and what did not. */
export interface MmsMapResult {
  messages: MappedMms[];
  /** Never silently empty-by-omission — every unmapped row is here. */
  skipped: MmsMapSkip[];
}

/** Outcome of mapping a single row. */
export type MmsMapOutcome =
  | { ok: true; message: MappedMms }
  | { ok: false; skip: MmsMapSkip };

/**
 * Reduce a provider `ct` value to a bare, comparable content type.
 *
 * Strips any parameter (`text/plain; charset=utf-8` -> `text/plain`), trims and
 * lowercases. Returns null when there is nothing to compare, so a part with no
 * declared type can never match a type by accident.
 */
export function normalizeContentType(
  ct: string | null | undefined
): string | null {
  if (ct === null || ct === undefined) return null;
  const bare = ct.split(";")[0].trim().toLowerCase();
  return bare.length > 0 ? bare : null;
}

/**
 * The part's `seq` as a number, or null when it does not have one.
 *
 * Guarded rather than passed straight to `Number()` because `Number(null)` and
 * `Number("")` are both **0**, not NaN — an unguarded parse silently promotes a
 * seq-less part to slide zero and reorders the message.
 */
export function partSeq(part: RawMmsPart): number | null {
  const raw = part.seq;
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/**
 * Order two text parts: ascending `seq`, seq-less parts last.
 *
 * `Array.prototype.sort` is stable (ES2019), so parts that tie — including all
 * the seq-less ones — keep the order the provider returned them in. Ordering is
 * deterministic for a given set of rows, which is what the body hash needs.
 */
function bySeqThenProviderOrder(a: RawMmsPart, b: RawMmsPart): number {
  const seqA = partSeq(a);
  const seqB = partSeq(b);
  if (seqA === null && seqB === null) return 0;
  if (seqA === null) return 1;
  if (seqB === null) return -1;
  return seqA - seqB;
}

/**
 * Extract the message text from a row's parts.
 *
 * The whole item in one function:
 *
 *  1. Select `text/plain` parts by content type. The SMIL layout document and
 *     every attachment are excluded because they are not `text/plain`, not
 *     because of where they sit in the list.
 *  2. No such part -> {@link MmsBody} `no_text_part`, carrying the other content
 *     types. Never `""`.
 *  3. Any selected part whose `text` is null -> the WHOLE body is `unreadable`.
 *     Concatenating only the readable fragments yields a message that looks
 *     complete and is not, which is worse than reporting none: nothing
 *     downstream could tell it had been truncated.
 *  4. Otherwise concatenate in `seq` order with {@link MMS_TEXT_PART_SEPARATOR}.
 */
export function extractMmsBody(parts: RawMmsPart[]): MmsBody {
  const all = parts ?? [];
  const textParts = all.filter(
    (part) => normalizeContentType(part.ct) === MMS_TEXT_CONTENT_TYPE
  );

  if (textParts.length === 0) {
    const attachmentContentTypes = all
      .map((part) => normalizeContentType(part.ct))
      .filter(
        (ct): ct is string => ct !== null && ct !== MMS_SMIL_CONTENT_TYPE
      );
    return { kind: "no_text_part", attachmentContentTypes };
  }

  const unrecovered = textParts.filter(
    (part) => part.text === null || part.text === undefined
  );
  if (unrecovered.length > 0) {
    return {
      kind: "unreadable",
      partIds: unrecovered.map((part) => part._id ?? "<no _id>"),
    };
  }

  const text = [...textParts]
    .sort(bySeqThenProviderOrder)
    .map((part) => part.text as string)
    .join(MMS_TEXT_PART_SEPARATOR);

  return { kind: "text", text };
}

/**
 * The body text a caller may hash or display, or **null when there is none**.
 *
 * Null is the point. The desktop's de-duplication key is
 * `SHA-256(sender|timestamp|body)`, so a caller that substitutes `""` for a
 * bodyless message makes two photo-only messages from one person in one second
 * hash to the same id and loses one of them. Returning null forces that
 * substitution to be a decision somebody makes on purpose (BACKLOG-2977) rather
 * than a default nobody notices.
 */
export function bodyTextForHash(body: MmsBody): string | null {
  return body.kind === "text" ? body.text : null;
}

/** `msg_box` -> direction, or null when the box is not one we ship. */
function directionFromMsgBox(
  msgBox: string | null | undefined
): "inbound" | "outbound" | null {
  const box = msgBox === null || msgBox === undefined ? "" : String(msgBox).trim();
  if (box === MMS_BOX_INBOX) return "inbound";
  if (box === MMS_BOX_SENT) return "outbound";
  return null;
}

/** Trimmed string, or null when there is nothing there. */
function presentString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Map one raw `content://mms` row.
 *
 * Returns a skip rather than a record only when the row is missing something a
 * record cannot be built without — never merely because it has no text.
 */
export function mapMmsRecord(raw: RawMmsRecord): MmsMapOutcome {
  const id = presentString(raw._id);
  if (id === null) {
    return {
      ok: false,
      skip: {
        reason: "missing_id",
        id: null,
        detail: `thread_id=${raw.thread_id ?? "null"} date=${raw.date ?? "null"}`,
      },
    };
  }

  const timestamp = mmsDateToMillis(raw.date);
  if (timestamp === null) {
    return {
      ok: false,
      skip: {
        reason: "unusable_date",
        id,
        detail: `date=${raw.date ?? "null"}`,
      },
    };
  }

  const direction = directionFromMsgBox(raw.msg_box);
  if (direction === null) {
    return {
      ok: false,
      skip: {
        reason: "unsupported_msg_box",
        id,
        detail: `msg_box=${raw.msg_box ?? "null"}`,
      },
    };
  }

  const threadId = presentString(raw.thread_id);

  return {
    ok: true,
    message: {
      smsId: `${MMS_ID_NAMESPACE}${id}`,
      ...(threadId !== null ? { threadId } : {}),
      timestamp,
      direction,
      body: extractMmsBody(raw.parts ?? []),
    },
  };
}

/**
 * Map a page of raw rows, keeping the unmapped ones visible.
 *
 * Order is preserved: `readMmsMessages` returns oldest-first and the mapper does
 * not re-sort, so the contiguous-prefix guarantee survives the mapping.
 */
export function mapMmsRecords(rows: RawMmsRecord[]): MmsMapResult {
  const messages: MappedMms[] = [];
  const skipped: MmsMapSkip[] = [];

  for (const raw of rows ?? []) {
    const outcome = mapMmsRecord(raw);
    if (outcome.ok) {
      messages.push(outcome.message);
    } else {
      skipped.push(outcome.skip);
    }
  }

  if (skipped.length > 0) {
    // Counted and named, never silent. A row the mapper could not use is a gap
    // in the audit, and a gap nobody is told about is the shape of BACKLOG-1448.
    console.warn(
      `[MmsMapper] Skipped ${skipped.length}/${(rows ?? []).length} rows: ` +
        skipped.map((s) => `${s.reason}(_id=${s.id ?? "none"})`).join(", ")
    );
  }

  return { messages, skipped };
}
