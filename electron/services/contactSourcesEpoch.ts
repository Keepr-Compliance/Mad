/**
 * BACKLOG-4180 — has `external_contacts` changed for a user since the last
 * backfill that COMPLETED?
 *
 * The scheduler's linking pass (`runLinkingPassWithBackfill` in
 * `contactHandlers.ts`) re-runs the whole-book backfill only when something it
 * would copy changed: a NEW link, or a source write. Without the second term an
 * address-book edit to an already-linked person (a new phone or email) would not
 * reach `contact_phones` / `contact_emails` until the next app start: nothing
 * else copies values onto a link that already exists.
 *
 * AN EPOCH, NOT A BOOLEAN. The worker-planned backfill awaits; a sync landing
 * during that await must not be marked done when the backfill finishes. A
 * backfill records the epoch it read at its START, so a write after that start
 * still reads as changed.
 *
 * IN MEMORY, AND UNKNOWN COUNTS AS CHANGED. No completed backfill this session
 * (first pass, after a restart, after logout) reads as changed, so a write whose
 * pass never ran before a crash is still copied on the next session's first
 * pass. The edit itself is durable in `external_contacts`.
 *
 * WRITERS (the only writers of the value columns name / phones_json /
 * emails_json, all in `externalContactDbService.ts`):
 *   - `fullSync` (macOS) — when a record was inserted or its content changed;
 *   - `upsertFromiPhone` — with or without a sync session;
 *   - `upsertExternalContacts` — outlook, google_contacts, android_sync.
 * Writes that cannot add a value are not signals: `synced_at` and
 * `last_message_at` stamps, and deletes (the backfill only adds).
 *
 * Its own module, not part of `contactLinkingScheduler`: the writers call it,
 * and many suites replace the scheduler with a partial mock.
 */

const sourcesEpoch = new Map<string, number>();
const backfilledEpoch = new Map<string, number>();
/** Bumped on reset so a backfill that settles after a logout cannot mark the next session done. */
let session = 0;

/** What a backfill captures at its start and hands back on success. */
export interface ContactSourcesStamp {
  readonly session: number;
  readonly epoch: number;
}

/** A writer changed this user's source records. */
export function noteContactSourcesChanged(userId: string): void {
  sourcesEpoch.set(userId, (sourcesEpoch.get(userId) ?? 0) + 1);
}

/** True when a write landed since the last completed backfill, or none has completed this session. */
export function haveContactSourcesChanged(userId: string): boolean {
  const done = backfilledEpoch.get(userId);
  return done === undefined || done !== (sourcesEpoch.get(userId) ?? 0);
}

/** Read at the START of a backfill. */
export function contactSourcesStamp(userId: string): ContactSourcesStamp {
  return { session, epoch: sourcesEpoch.get(userId) ?? 0 };
}

/** Call only after the backfill completed without throwing. */
export function markContactSourcesBackfilled(userId: string, stamp: ContactSourcesStamp): void {
  if (stamp.session !== session) return;
  backfilledEpoch.set(userId, stamp.epoch);
}

/** Logout (and test reset): every user starts again at "unknown", which reads as changed. */
export function resetContactSourcesEpoch(): void {
  sourcesEpoch.clear();
  backfilledEpoch.clear();
  session++;
}
