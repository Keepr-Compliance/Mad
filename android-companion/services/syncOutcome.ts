/**
 * Sync Outcome (Android Companion) — BACKLOG-2988
 *
 * ===========================================================================
 * ONE EVENT PER SYNC RUN, WHATEVER HAPPENS
 * ===========================================================================
 * `syncService` and `backgroundSync` reported every non-throwing path with
 * `Sentry.addBreadcrumb` and raised an EVENT only from `captureException` on a
 * throw. **Breadcrumbs are attached to an event when one is captured and
 * DISCARDED otherwise.** So the telemetry covered the case where the app
 * crashes and missed the case where it quietly did the wrong thing.
 *
 * That is the expensive half. A field tester reported FOUR distinct Android
 * sync failures (BACKLOG-2955) and every one was invisible in Sentry: none of
 * them threw. The sync ran, completed, and reported "your computer is offline"
 * — a completed run with a bad outcome, which is precisely the shape that sent
 * nothing.
 *
 * It is also the same defect the desktop had and fixed: BACKLOG-2913 (the wrong
 * cause), BACKLOG-2950 (the failure reached Sentry carrying the wrong cause) and
 * BACKLOG-2914, whose `electron/services/syncOutcomeReporter.ts` this module
 * deliberately mirrors — same `captureMessage` transport, same `source` /
 * `outcome` / `duration_bucket` / `reason_code` tag names, same
 * `["sync-outcome", source, outcome]` fingerprint — so ONE Sentry query spans
 * the desktop and the companion instead of two half-answers.
 *
 * ---------------------------------------------------------------------------
 * A BREADCRUMB IS NOT AN EVENT, AND A TEST MUST BE ABLE TO TELL
 * ---------------------------------------------------------------------------
 * The item is explicit: *"asserting 'some Sentry call happened' would pass on
 * the breadcrumb and prove nothing."* The suite asserts `captureMessage`, and
 * separately asserts that `addBreadcrumb` alone would NOT have satisfied it.
 *
 * ---------------------------------------------------------------------------
 * PRIVACY — the repo is public and Sentry is a third party
 * ---------------------------------------------------------------------------
 * NEVER: message bodies, senders, contact names, numbers or addresses, the
 * desktop's IP, the bearer token, the pairing secret, the user's Supabase id.
 * The desktop ADDRESS is reduced to a CLASS (`private` / `refused` /
 * `unknown`) — enough to tell "the stored pairing points somewhere it must not"
 * from "the desktop is off", which is the distinction BACKLOG-2956 exists for,
 * and nothing more. `scrubOutcomeFields` is the backstop for the next field
 * somebody adds without rereading this paragraph.
 *
 * The DEVICE ID is sent, on purpose and by the item's own instruction: it is a
 * desktop-minted per-pairing UUID that identifies no person, and BACKLOG-2987
 * means a changing one is itself the defect. Had this event existed, that would
 * have been visible on the first sync rather than after four and a hand-read
 * log.
 */

import * as Sentry from '@sentry/react-native';

import { isPrivateLanIPv4 } from './lanAddress';
import type { SyncErrorType } from '../types/sync';

/**
 * The vocabulary. Every terminated run lands on exactly one of these, including
 * the ones that previously sent nothing at all.
 *
 *  - `completed`       reached the desktop, nothing failed, something moved.
 *  - `completed_empty` reached the desktop, nothing failed, NOTHING to move.
 *                      This is the shape the item names — a run that finishes
 *                      cleanly with zero messages — and it is a distinct value
 *                      rather than folded into `completed` because "the syncs
 *                      all succeed and no data ever arrives" is a real report
 *                      that must be answerable from the event stream alone.
 *  - `partial`         reached, messages went, CONTACTS did not. Contact-send
 *                      failure is swallowed as non-fatal by the sync cycle, so
 *                      before this it was invisible from both ends.
 *  - `unreachable`     the ping failed, or the phone is not on the Wi-Fi.
 *  - `refused`         the LAN guard refused the stored address. Not a
 *                      reachability failure; nothing about the network fixes it.
 *  - `failed`          a send or an SMS read errored.
 *  - `not_paired`      no stored pairing.
 *  - `skipped`         another sync held the lock. Not a run; emitted anyway,
 *                      because "every sync is skipped" is a failure mode.
 *  - `crashed`         the cycle threw.
 */
export type SyncOutcome =
  | 'completed'
  | 'completed_empty'
  | 'partial'
  | 'unreachable'
  | 'refused'
  | 'failed'
  | 'not_paired'
  | 'skipped'
  | 'crashed';

/**
 * Which step the run ended on.
 *
 * Carried EXPLICITLY on the result by each `return` in the sync cycle rather
 * than inferred here from the shape of the error. An inference would be a
 * second, drifting copy of the cycle's control flow, and the first version of
 * this module derived `not_paired` by string-matching the user-facing error
 * message — which would have broken silently the first time somebody improved
 * the wording.
 */
export type SyncStep =
  | 'lock'
  | 'pairing'
  | 'lan_guard'
  | 'ping'
  | 'read_sms'
  | 'send_messages'
  | 'send_contacts'
  | 'complete'
  /**
   * A run that THREW never returned a result, so it never named a step. This
   * value exists so the crash path says so instead of reporting `complete` —
   * which would put a false value in the one field the item asks for by name,
   * on the rarest and most interesting outcome.
   */
  | 'unknown';

/** What the address was, reduced to what is safe to send. */
export type AddressClass = 'private' | 'refused' | 'unknown';

/** The facts a terminated run reports. No free text, no identifiers. */
export interface SyncOutcomeRow {
  outcome: SyncOutcome;
  step: SyncStep;
  elapsedMs: number;
  addressClass: AddressClass;
  /** The desktop-minted device UUID, when this phone has a pairing. */
  deviceId?: string;
  /** The categorised failure, when there was one. Never a message. */
  errorType?: SyncErrorType;
  /** Why the SMS read failed, when it did. A reason code, never a message. */
  readErrorReason?: string;
  counts: {
    messagesRead: number;
    messagesSent: number;
    contactsSent: number;
    newContacts: number;
    queueSize: number;
  };
}

/**
 * The classification input — the public result shape plus the throw, so one
 * pure function covers every way a run can end.
 */
export interface SyncOutcomeInput {
  skipped?: boolean;
  stoppedAt?: SyncStep;
  desktopReachable?: boolean;
  error?: string;
  errorType?: SyncErrorType;
  readError?: { reason: string };
  contactsFailed?: boolean;
  newMessages?: number;
  sentMessages?: number;
  contactsSynced?: number;
  /** Present when the cycle THREW rather than returned. */
  threw?: boolean;
}

/**
 * The desktop address, as a class.
 *
 * `refused` is the BACKLOG-2956 state: a stored pairing that names something
 * outside the private LAN ranges, which the transport refuses before issuing a
 * request. `unknown` means we had no address to classify (not paired).
 *
 * The address ITSELF is never returned, logged or sent from here.
 */
export function classifyAddress(ip: string | null | undefined): AddressClass {
  if (!ip) return 'unknown';
  return isPrivateLanIPv4(ip) ? 'private' : 'refused';
}

/**
 * Coarse duration buckets, as a TAG.
 *
 * Sentry will not compute a p50 over `extra` and message events carry no
 * measurements, so a bucket tag is the only way "syncs got slower in 1.2" shows
 * up as a shift in a tag distribution. The boundaries are SECONDS where the
 * desktop's are minutes (`electron/services/syncOutcomeReporter.ts`), because a
 * phone sync that takes a minute is already pathological and a desktop one that
 * takes a minute is normal. The TAG NAME is shared so one query spans both; the
 * bucket values are not, and are not meant to be compared across sources.
 */
export function durationBucket(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 'unknown';
  if (elapsedMs < 1_000) return '<1s';
  if (elapsedMs < 5_000) return '1-5s';
  if (elapsedMs < 15_000) return '5-15s';
  if (elapsedMs < 60_000) return '15-60s';
  return '>60s';
}

/**
 * Decide the outcome for a terminated run. PURE, so every branch is testable
 * without a network, a phone or a Sentry client.
 *
 * Order matters and is the run's own precedence: a throw beats everything, then
 * the lock, then the steps in the order the cycle performs them. A read failure
 * outranks a clean finish for the same reason `reachedDesktop` excludes it in
 * `backgroundSync` — "nothing new" cannot be trusted when the read itself
 * errored.
 */
export function classifySyncOutcome(input: SyncOutcomeInput): {
  outcome: SyncOutcome;
  step: SyncStep;
} {
  if (input.threw) return { outcome: 'crashed', step: input.stoppedAt ?? 'unknown' };
  if (input.skipped) return { outcome: 'skipped', step: 'lock' };

  const step = input.stoppedAt ?? 'complete';

  if (step === 'pairing') return { outcome: 'not_paired', step };
  if (input.errorType === 'invalid_address') return { outcome: 'refused', step };
  if (input.desktopReachable === false) return { outcome: 'unreachable', step };
  if (input.error || input.readError) return { outcome: 'failed', step };
  if (input.contactsFailed) return { outcome: 'partial', step };

  const moved =
    (input.sentMessages ?? 0) > 0 ||
    (input.contactsSynced ?? 0) > 0 ||
    (input.newMessages ?? 0) > 0;

  return { outcome: moved ? 'completed' : 'completed_empty', step };
}

/**
 * Key names that must never reach Sentry, matched case-insensitively as
 * substrings. Mirrors `scrubOutcomeFields` in the desktop reporter.
 *
 * `deviceId` is NOT caught by this list and that is deliberate — see the module
 * header. Everything else that could name a person, a place or a credential is:
 * `secret`, `token`, `ip`, `address`, `phone`, `email`, `name`, `body`,
 * `sender`, `message` (as a field name; the COUNTS are `messagesRead` /
 * `messagesSent`, which do not match `^message$`).
 *
 * MATCHED AS SUBSTRINGS, so a future legitimate `hostName` or `bodyCount` would
 * also vanish — silently. That direction is deliberate: it fails SAFE, dropping
 * a harmless field rather than leaking an identifying one.
 */
const PII_KEY_PATTERN = /secret|token|\bip\b|ipv4|address|phone|email|name|body|sender|contactlist|userid|user_id/i;

/** Anything shaped like an IPv4 address, whatever key it arrived under. */
const IPV4_VALUE_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** Drop anything that could identify a person, a place or a credential. */
export function scrubOutcomeFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (PII_KEY_PATTERN.test(key)) continue;
    if (typeof value === 'string' && IPV4_VALUE_PATTERN.test(value)) continue;
    safe[key] = value;
  }
  return safe;
}

/**
 * Which outcomes are worth a `warning` rather than an `info`.
 *
 * Kept narrow: `outcome` is already a tag, so the level adds nothing
 * searchable. It exists only so the outcomes a user would call broken are not
 * buried at the same level as the healthy ones in a default Sentry view.
 */
const WARNING_OUTCOMES: ReadonlySet<SyncOutcome> = new Set<SyncOutcome>([
  'failed',
  'refused',
  'crashed',
  'partial',
]);

/** The event's filterable dimensions. Everything here is bounded cardinality. */
export function buildOutcomeTags(row: SyncOutcomeRow): Record<string, string> {
  const tags: Record<string, string> = {
    source: 'android_companion',
    outcome: row.outcome,
    step: row.step,
    address_class: row.addressClass,
    duration_bucket: durationBucket(row.elapsedMs),
  };
  // `reason_code` is the desktop's tag name for "why", so one saved search
  // covers both halves. The companion's why is the categorised error type, or
  // the SMS read reason when the read is what failed.
  const reason = row.errorType ?? row.readErrorReason;
  if (reason) tags.reason_code = reason;
  // The identity, so a run can be attributed to a phone and — the reason the
  // item asks for it — so a CHANGING device id is visible without reading a log.
  if (row.deviceId) tags.device_id = row.deviceId;
  return tags;
}

/**
 * Send the outcome to Sentry as an EVENT.
 *
 * Emitted for success as well as failure. A phone sync is periodic but low
 * volume, and the successes are the DENOMINATOR — without them a rise in
 * failures and a rise in usage are the same shape in the data.
 *
 * Best-effort and NEVER throwing: this runs at the end of a sync the user may
 * be watching, and no telemetry sink is worth failing that.
 */
export function reportSyncOutcome(row: SyncOutcomeRow): void {
  try {
    const extra = scrubOutcomeFields({
      ...row.counts,
      durationMs: row.elapsedMs,
      step: row.step,
      outcome: row.outcome,
      addressClass: row.addressClass,
      ...(row.errorType ? { errorType: row.errorType } : {}),
      ...(row.readErrorReason ? { readErrorReason: row.readErrorReason } : {}),
      ...(row.deviceId ? { deviceId: row.deviceId } : {}),
    });

    Sentry.captureMessage(`Sync outcome: ${row.outcome}`, {
      level: WARNING_OUTCOMES.has(row.outcome) ? 'warning' : 'info',
      tags: buildOutcomeTags(row),
      extra,
      // Explicit grouping, so the outcomes stay stable issues whatever Sentry's
      // message heuristics do, and so the companion's rows separate from the
      // desktop's automatically.
      fingerprint: ['sync-outcome', 'android_companion', row.outcome],
    });
  } catch (error) {
    console.warn('[SyncOutcome] report failed; sync unaffected:', error);
  }
}

export default {
  classifyAddress,
  classifySyncOutcome,
  durationBucket,
  buildOutcomeTags,
  scrubOutcomeFields,
  reportSyncOutcome,
};
