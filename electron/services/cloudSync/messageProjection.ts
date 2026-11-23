/**
 * Keepr Cloud: one selected email or text → the `cloud_upsert_messages` row — BACKLOG-4263 P5.
 *
 * Normalisation order, per field (plan delta MF-5/6/10):
 *   1. clean: every string through cleanText (no NUL, no lone surrogate); an empty-looking body becomes null;
 *   2. cut, by code points, on the cleaned string (never splits a surrogate pair);
 *   3. times through instant(), kept only for years 0001-9999;
 *   4. the hash, last, over exactly what is sent (with MESSAGE_HASH_VERSION).
 * Rows with no content or no usable key never reach here (cloudSyncMessagesDb.selectDealMessages).
 */
import { htmlToPlainText } from "../../utils/htmlToPlainText";
import { isEffectivelyEmptyText } from "../../utils/messageParser";
import type { SelectedMessage } from "../db/cloudSyncMessagesDb";
import { contentHash, type JsonValue } from "./jcs";
import { cleanNumber, cleanText, instant } from "./projection";

/** Bumped when a rule here changes; stored on each email and text record. Independent of the deal's HASH_VERSION. */
export const MESSAGE_HASH_VERSION = 1;
/** One more than the server keeps (S2 `char_length > 1000000`), so the server still sets body_truncated. */
export const BODY_MAX_CODE_POINTS = 1_000_001;
export const SUBJECT_MAX_CODE_POINTS = 2_000;
export const PARTICIPANT_MAX_CODE_POINTS = 1_000;
export const PARTICIPANTS_PER_LIST = 500;
export const THREAD_KEY_FALLBACK_PREFIX = "msg:";

export interface ProjectedMessage {
  key: string;
  localId: string;
  hash: string;
  payload: { [key: string]: JsonValue };
}

/** The first `max` code points of `s`. */
export function cutCodePoints(s: string, max: number): string {
  let n = 0;
  let i = 0;
  while (i < s.length && n < max) {
    const c = s.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < s.length ? 2 : 1;
    n++;
  }
  return i >= s.length ? s : s.slice(0, i);
}

function text(value: unknown, max: number): string | null {
  const c = cleanText(value);
  if (c === null || c.length === 0) return null;
  return cutCodePoints(c, max);
}

/** An instant inside years 0001-9999, else null. */
export function boundedInstant(value: unknown): string | null {
  const iso = instant(value);
  if (iso === null || !/^\d{4}-/.test(iso) || iso.startsWith("0000-")) return null;
  return iso;
}

function list(values: unknown[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (out.length >= PARTICIPANTS_PER_LIST) break;
    const t = text(v, PARTICIPANT_MAX_CODE_POINTS);
    if (t !== null) out.push(t);
  }
  return out;
}

function splitAddresses(value: string | null): string[] {
  if (!value) return [];
  return value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** `{from, to, cc}` (the shape the AI readers read). */
export function participantsOf(m: SelectedMessage): { [key: string]: JsonValue } {
  const r = m.row;
  if (m.channelKind === "email" && r.email_row_id) {
    return { from: text(r.sender, PARTICIPANT_MAX_CODE_POINTS), to: list(splitAddresses(r.recipients)), cc: list(splitAddresses(r.cc)) };
  }
  let p: unknown = null;
  try {
    p = typeof r.participants === "string" ? JSON.parse(r.participants) : null;
  } catch {
    p = null;
  }
  const o = p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
  const arr = (v: unknown) => (Array.isArray(v) ? v : typeof v === "string" ? [v] : []);
  return { from: text(o.from, PARTICIPANT_MAX_CODE_POINTS), to: list(arr(o.to)), cc: list(arr(o.cc)) };
}

/** The body: plain text only; an email with only HTML is converted with the existing converter. */
export function bodyOf(m: SelectedMessage): string | null {
  let raw = m.row.body_text;
  if (m.channelKind === "email" && (raw === null || raw.length === 0) && m.row.email_body_html) {
    raw = htmlToPlainText(m.row.email_body_html);
  }
  const c = cleanText(raw);
  if (c === null || isEffectivelyEmptyText(c)) return null;
  return cutCodePoints(c, BODY_MAX_CODE_POINTS);
}

/** A text always has a thread key online (S2 rejects a text without one): its thread, else `msg:<wire id>`. */
export function threadKeyOf(m: SelectedMessage): string | null {
  const t = text(m.row.thread_id, 1_000);
  if (t !== null) return t;
  return m.channelKind === "text" ? `${THREAD_KEY_FALLBACK_PREFIX}${m.wireId}` : null;
}

function channelOf(m: SelectedMessage): string | null {
  if (m.channelKind === "email") return "email";
  return m.row.channel === "sms" || m.row.channel === "imessage" ? m.row.channel : null;
}

export function projectMessage(m: SelectedMessage): ProjectedMessage {
  const r = m.row;
  const dto: { [key: string]: JsonValue } = {
    local_id: m.wireId,
    local_link_id: text(r.communication_id, 200),
    channel_kind: m.channelKind,
    channel: channelOf(m),
    direction: text(r.direction, 32),
    subject: text(r.subject, SUBJECT_MAX_CODE_POINTS),
    body_text: bodyOf(m),
    participants: participantsOf(m),
    thread_key: threadKeyOf(m),
    sent_at: boundedInstant(r.sent_at),
    received_at: boundedInstant(r.received_at),
    link_source: text(r.link_source, 32),
    link_confidence: cleanNumber(r.link_confidence),
    match_reason: text(r.match_reason, 64),
    linked_at: boundedInstant(r.linked_at),
    link_origin: "link",
    hidden_from_export: m.hidden,
    source_updated_at: null,
    hash_version: MESSAGE_HASH_VERSION,
  };
  const hash = contentHash(dto);
  const { hash_version: _v, ...sent } = dto;
  void _v;
  return { key: m.key, localId: m.wireId, hash, payload: { ...sent, content_hash: hash } };
}
