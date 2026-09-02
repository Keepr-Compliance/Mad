/**
 * MMS Reader Service (Android Companion) — BACKLOG-2973.
 *
 * A sibling of `smsReader.ts`, NOT a modification of it. The SMS read path is
 * load-bearing and already carries three regressions' worth of guards; MMS gets
 * its own file so the SMS path is provably untouched.
 *
 * ## Why the companion needs this at all
 *
 * `smsReader.ts` reads `content://sms` only. Google Messages writes **RCS into
 * the standard Telephony database as MMS** (BACKLOG-3037), so RCS conversations,
 * group threads and photo messages are invisible to the audit — not because they
 * are inaccessible, but because nothing looked where they land. The library the
 * SMS path uses hard-codes the `sms` authority, so no filter change reaches them.
 * `modules/keepr-mms/` is the native read; this is its JS surface.
 *
 * ## What this file deliberately does NOT do
 *
 * It returns {@link RawMmsRecord} — the provider's rows, uninterpreted — and NOT
 * `SyncMessage`.
 *
 * That is a deliberate boundary, not an omission. `SyncMessage` requires a
 * `sender` and a `body`, and an MMS envelope has neither: `content://mms` has no
 * `address` column at all (participants live in `content://mms/{id}/addr`,
 * BACKLOG-2975) and the text lives in `content://mms/{id}/part` rows
 * (BACKLOG-2974). Mapping here would mean inventing `sender: "unknown"` and
 * `body: ""` for every message — which would both hide the missing data and
 * poison the desktop's dedup key, `SHA-256(sender|timestamp|body)`. The raw
 * `parts` and `addrs` are carried on each record so 2974 and 2975 can build the
 * mapper without a second trip to the provider.
 *
 * ## The invariants this read path inherits from SMS, and must not break
 *
 * 1. **Oldest-first, bounded, offset-paged** (BACKLOG-2199 / 2207). The native
 *    query forces `date ASC` so a bounded page is a contiguous prefix of the
 *    backlog rather than the newest n. Reading newest-first and then advancing
 *    the cursor strands every older message below it, permanently.
 * 2. **A failed read is never an empty read** (BACKLOG-1448 / 2206). A missing
 *    module, a denied permission, a refused query and an unparseable payload are
 *    four distinct reasons on `{ ok: false, error }`. Collapsing them to `[]`
 *    once hid a zero-message release for weeks. MMS does not reintroduce that.
 */

import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo";
import {
  readPaged,
  DEFAULT_PROVIDER_READ_BUDGET,
  MAX_PROVIDER_READ_PAGES,
  PROVIDER_READ_PAGE_SIZE,
  type ProviderPageResult,
  type ProviderReadError,
  type ProviderReadErrorReason,
  type ProviderReadResult,
} from "./providerRead";

/**
 * One row of `content://mms/{id}/part`, raw.
 *
 * Every value is the provider's string (or null) — no decoding, no filtering.
 * Two things BACKLOG-2974 will need and this layer must not decide for it:
 *
 *  - **Every MMS carries a SMIL part** — a layout document, not content. A
 *    reader that takes "the first part" gets XML instead of the message. Filter
 *    on `ct !== 'application/smil'`; `ct` is what the part declares, whereas
 *    `seq` is a layout convention (the `seq = -1` placement is transcribed from
 *    an SMS Backup & Restore export, not observed from Google Messages).
 *  - **`_data` is provider-owned.** When it is set the bytes live in the
 *    provider's own storage and must be opened through it, never treated as a
 *    filesystem path. `text` and `_data` are alternatives.
 */
export interface RawMmsPart {
  _id: string | null;
  seq: string | null;
  ct: string | null;
  name: string | null;
  cl: string | null;
  chset: string | null;
  text: string | null;
  _data: string | null;
}

/**
 * One row of `content://mms/{id}/addr`, raw — the ONLY source of participants.
 *
 * `type` is the address role: 137 = From, 151 = To, 130 = CC, 129 = BCC (per
 * SyncTech's documentation; not verified against a real Google Messages write).
 * The device owner appears as a `To` on a received message and as the `From` on
 * a sent one, so "who is this thread with" cannot be read off a single row —
 * that resolution is BACKLOG-2975.
 */
export interface RawMmsAddress {
  _id: string | null;
  address: string | null;
  type: string | null;
  charset: string | null;
}

/**
 * One `content://mms` row with its parts and addresses attached.
 *
 * Note the absence of `address` and `body`: neither is a column on this table.
 * `msg_box` is 1 (received) or 2 (sent) — a `READ_SMS` caller is served a view
 * that filters to exactly those, so drafts and undownloaded stubs never appear.
 */
export interface RawMmsRecord {
  _id: string | null;
  thread_id: string | null;
  /**
   * The provider's raw `date`, UNPARSED and in the provider's own unit.
   *
   * The unit is not yet observed from a real writer — see
   * {@link mmsDateToMillis}. It is carried through verbatim so the first
   * real-device read can settle it, rather than being normalised away here.
   */
  date: string | null;
  date_sent: string | null;
  msg_box: string | null;
  m_type: string | null;
  parts: RawMmsPart[];
  addrs: RawMmsAddress[];
}

/**
 * Categorized reason an MMS read FAILED — the exact taxonomy `smsReader` uses
 * (BACKLOG-2206), for the exact same reason. A read failure means we could not
 * trust the read at all; it must never be indistinguishable from "no new
 * messages", or a broken reader looks like a quiet one.
 */
export type MmsReadErrorReason = ProviderReadErrorReason;

export type MmsReadError = ProviderReadError;

/**
 * Outcome of an MMS read. A discriminated union so callers MUST distinguish an
 * explicit empty-but-successful read (`{ ok: true, messages: [] }`) from a read
 * FAILURE (`{ ok: false, error }`). The read path NEVER swallows a failure into
 * an empty array.
 */
export type MmsReadResult = ProviderReadResult<RawMmsRecord>;

/** The native module's registered name (`Name("KeeprMms")` in the Kotlin). */
export const KEEPR_MMS_MODULE_NAME = "KeeprMms";

/**
 * Rows to request from the provider in a SINGLE native call — mirrors
 * `SMS_READ_PAGE_SIZE`. Bounds the size of any one payload crossing the bridge
 * while the surrounding loop keeps pulling until the backlog is exhausted or the
 * budget is reached. Exported so tests can reason about page counts without
 * hard-coding it.
 */
export const MMS_READ_PAGE_SIZE = PROVIDER_READ_PAGE_SIZE;

/**
 * Absolute safety cap on native page reads per cycle (anti-loop). Mirrors
 * `MAX_PAGES_PER_BOX`. The loop normally ends by exhausting the backlog or
 * reaching the budget; this guarantees it is bounded regardless.
 */
const MAX_PAGES = MAX_PROVIDER_READ_PAGES;

/** Default read budget when a caller does not supply `maxCount`. */
const DEFAULT_MAX_COUNT = DEFAULT_PROVIDER_READ_BUDGET;

/**
 * Rows at or above this magnitude are milliseconds; below it, seconds.
 *
 * 1e11 milliseconds is 1973-03-03 and 1e11 seconds is the year 5138, so no real
 * message can be misclassified. Exported because BACKLOG-2974's mapper and the
 * native selection must agree on the same boundary.
 */
export const MMS_MILLIS_MAGNITUDE_THRESHOLD = 100_000_000_000;

/** The native surface `modules/keepr-mms` exposes. */
interface KeeprMmsNativeModule {
  list(minDate: number, indexFrom: number, maxCount: number): Promise<string>;
}

/** The native module's JSON page payload: `{ rawCount, rows }`. */
interface MmsPagePayload {
  rawCount: number;
  rows: RawMmsRecord[];
}

type MmsPageResult = ProviderPageResult<RawMmsRecord>;

/**
 * Get a reference to the native MMS module.
 *
 * `requireOptionalNativeModule` returns null rather than throwing when the
 * module is absent — a build where autolinking did not pick `keepr-mms` up, or
 * an older APK. BACKLOG-1448 is exactly this case going unnoticed: a module that
 * resolves to undefined and a read that returns zero look identical from the
 * outside, which is why null here becomes an explicit `module_unavailable`
 * FAILURE and never an empty page.
 */
function getMmsNativeModule(): KeeprMmsNativeModule | null {
  const mod = requireOptionalNativeModule<KeeprMmsNativeModule>(
    KEEPR_MMS_MODULE_NAME
  );
  if (!mod) {
    console.warn("[MmsReader] KeeprMms native module not available");
    return null;
  }
  return mod;
}

/**
 * Normalise a raw provider `date` to milliseconds by MAGNITUDE, not by
 * assumption.
 *
 * **The unit is not yet observed from a real writer.** Seeded values round-trip
 * byte-identical, so the provider does not normalise — the unit is whatever
 * wrote the row. AOSP documents `Telephony.BaseMmsColumns.DATE` as seconds
 * (SMS is milliseconds); SMS Backup & Restore exports milliseconds. Neither is
 * an observation of Google Messages, so this function refuses to pick one:
 * it classifies each value by its own magnitude
 * ({@link MMS_MILLIS_MAGNITUDE_THRESHOLD}) and the raw value is logged on every
 * page so a real-device read settles the question as a fact.
 *
 * Returns null for a missing or unparseable value — the caller decides what an
 * undated row means, rather than being handed a plausible-looking wrong number.
 * (`smsReader` learned this the hard way: `Date.now()` as a fallback made
 * re-reads of the same row hash differently every cycle — BACKLOG-2202.)
 */
export function mmsDateToMillis(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return value < MMS_MILLIS_MAGNITUDE_THRESHOLD ? value * 1000 : value;
}

/**
 * Turn a rejected native call into a read error.
 *
 * The Kotlin side raises `ERR_MMS_PERMISSION_DENIED` (READ_SMS not granted, or
 * a `SecurityException` from the provider) and `ERR_MMS_QUERY_FAILED` (the query
 * threw, or the resolver returned a NULL cursor — a provider refusal that is
 * NOT an empty result). Anything else — a lost React context, a converter
 * failure — is a query failure too: unrecognised is never treated as benign.
 */
function classifyNativeError(err: unknown): MmsReadError {
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code: unknown }).code)
      : "";
  const rawMessage =
    err instanceof Error && err.message
      ? err.message
      : typeof err === "string" && err.length > 0
        ? err
        : "";
  const message = rawMessage.length > 0 ? rawMessage : "Unknown MMS query failure";

  const reason: MmsReadErrorReason =
    code === "ERR_MMS_PERMISSION_DENIED" || /permission/i.test(message)
      ? "permission_denied"
      : "query_failed";
  return { reason, message };
}

/**
 * User-facing copy for an MMS read failure.
 *
 * Wording is shared with the SMS surface on purpose: both are the same
 * permission (`READ_SMS`) and the same recovery, so a user must not be shown two
 * different explanations of one problem. Kept here rather than imported so the
 * SMS module is not modified by this item; BACKLOG-2974 wires the MMS read into
 * the sync cycle and can unify the two call sites then.
 */
export function mmsReadErrorMessage(error: MmsReadError): {
  title: string;
  body: string;
} {
  switch (error.reason) {
    case "permission_denied":
      return {
        title: "Couldn't read messages",
        body: "Keepr Companion no longer has permission to read your messages. Open Settings and allow SMS access so your picture and group messages can keep syncing.",
      };
    case "module_unavailable":
      return {
        title: "Couldn't read messages",
        body: "The picture-message reader isn't available on this device. Reopen Keepr Companion — if it keeps happening, reinstall the app.",
      };
    case "parse_failed":
    case "query_failed":
    default:
      return {
        title: "Couldn't read messages",
        body: "Keepr Companion hit an error reading your picture and group messages, so this sync didn't complete. Reopen the app to try again, and check that SMS permission is still granted.",
      };
  }
}

/**
 * Read MMS rows from the Android telephony provider, oldest-first and bounded.
 *
 * Unlike SMS there is no box split: a `READ_SMS` caller is served a view over
 * the message table filtered to received + sent, so one query already covers
 * both directions (`msg_box` says which).
 *
 * @param sinceTimestamp cursor floor in MILLISECONDS — the same unit
 *   `readSmsMessages` takes, so one cursor can drive both reads. The native
 *   selection is unit-agnostic about what the PROVIDER stores (see
 *   {@link mmsDateToMillis}); this argument is always milliseconds. Inclusive,
 *   so callers pass `lastSynced + 1` exactly as they do for SMS.
 * @param maxCount read budget/ceiling for this cycle (default 100), paged
 *   internally in {@link MMS_READ_PAGE_SIZE}-row batches. Anything above it stays
 *   in the provider and the caller HOLDS the cursor — deferred, never dropped.
 * @returns `{ ok: true, messages }` (oldest-first) on a successful read —
 *   including a genuinely empty store — or `{ ok: false, error }` on a read
 *   FAILURE, which is never collapsed to `[]`.
 */
export async function readMmsMessages(
  sinceTimestamp: number,
  maxCount: number = DEFAULT_MAX_COUNT
): Promise<MmsReadResult> {
  if (Platform.OS !== "android") {
    // Not an error — there is genuinely nothing to read off-Android.
    console.log("[MmsReader] Skipping — not Android");
    return { ok: true, messages: [] };
  }

  if (!getMmsNativeModule()) {
    // BACKLOG-1448/2206: a missing native module is a FAILURE, not "0 messages".
    return {
      ok: false,
      error: {
        reason: "module_unavailable",
        message: "KeeprMms native module not available",
      },
    };
  }

  // A non-positive budget means the queue is full — read nothing so the cursor
  // never advances over un-enqueued history (BACKLOG-2199 back-pressure). A
  // DELIBERATE empty read: an explicit empty-SUCCESS, not a failure.
  if (maxCount <= 0) {
    console.log("[MmsReader] maxCount<=0 — back-pressure, reading nothing");
    return { ok: true, messages: [] };
  }

  console.log(
    `[MmsReader] Reading MMS since=${sinceTimestamp} (${sinceTimestamp > 0 ? new Date(sinceTimestamp).toISOString() : "epoch"}) maxCount=${maxCount}`
  );

  // The walk, the budget ceiling, the exhaustion rule and the
  // fail-the-whole-read behaviour are SHARED with the SMS reader
  // (`providerRead.ts`) rather than restated here. What stays MMS-specific is
  // the native call and the row shape, which is where the two genuinely differ.
  const result = await readPaged<RawMmsRecord>({
    budget: maxCount,
    label: "MmsReader",
    pageSize: MMS_READ_PAGE_SIZE,
    maxPages: MAX_PAGES,
    readPage: (indexFrom, pageSize) =>
      readMmsPage(sinceTimestamp, indexFrom, pageSize),
  });

  if (result.ok) {
    console.log(`[MmsReader] Read ${result.messages.length} MMS rows`);
  }
  return result;
}


/**
 * Read ONE page from the native module.
 *
 * Every failure path resolves to `{ ok: false, error }` — a rejected native call
 * (permission / query / null cursor), a missing module, or a payload that is not
 * the `{ rawCount, rows }` shape. None of them resolves to an empty page.
 */
async function readMmsPage(
  minDate: number,
  indexFrom: number,
  maxCount: number
): Promise<MmsPageResult> {
  const mmsModule = getMmsNativeModule();
  if (!mmsModule) {
    return {
      ok: false,
      error: {
        reason: "module_unavailable",
        message: "KeeprMms native module not available",
      },
    };
  }

  let json: string;
  try {
    json = await mmsModule.list(minDate, indexFrom, maxCount);
  } catch (err) {
    console.error("[MmsReader] Native list() failed:", err);
    return { ok: false, error: classifyNativeError(err) };
  }

  try {
    const payload = JSON.parse(json) as MmsPagePayload;
    if (
      payload === null ||
      typeof payload !== "object" ||
      !Array.isArray(payload.rows) ||
      typeof payload.rawCount !== "number"
    ) {
      // A payload of the wrong SHAPE is as untrustworthy as one that will not
      // parse. Accepting it would mean reading `rows` off undefined and
      // reporting zero — a failure wearing a successful read's clothes.
      throw new Error(
        `Native payload is not { rawCount, rows }: ${json.slice(0, 120)}`
      );
    }

    if (payload.rows.length > 0) {
      const first = payload.rows[0];
      // The RAW date is logged, not just the normalised one: the provider's unit
      // is the one fact this module could not observe from a real writer, and a
      // real-device log is what settles it.
      console.log(
        `[MmsReader] page indexFrom=${indexFrom} size=${maxCount} -> ${payload.rawCount} rows; ` +
          `first _id=${first._id} thread_id=${first.thread_id} ` +
          `RAW date=${first.date} -> ${mmsDateToMillis(first.date)}ms ` +
          `parts=${first.parts?.length ?? 0} addrs=${first.addrs?.length ?? 0}`
      );
    }

    return { ok: true, messages: payload.rows, rawCount: payload.rawCount };
  } catch (err) {
    console.error("[MmsReader] Failed to parse native payload:", err);
    return {
      ok: false,
      error: {
        reason: "parse_failed",
        message:
          err instanceof Error ? err.message : "Failed to parse MMS payload",
      },
    };
  }
}
