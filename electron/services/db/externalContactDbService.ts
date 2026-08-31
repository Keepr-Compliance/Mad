/**
 * External Contact Database Service (TASK-1773, BACKLOG-569)
 *
 * Manages the external_contacts shadow table which caches macOS Contacts
 * with pre-computed last_message_at for instant sorted contact loading.
 *
 * Key Features:
 * - Caches macOS Contacts in local SQLite
 * - Stores last_message_at pre-computed from phone_last_message lookup
 * - Enables O(1) sorted contact retrieval (vs fresh macOS read every time)
 * - Background sync keeps data fresh without blocking UI
 */

import { v4 as uuidv4 } from 'uuid';
import { dbAll, dbRun, dbGet, dbTransaction, ensureDb } from './core/dbConnection';
import logService from '../logService';
import { recordShadowSync } from '../contactIngestionFunnel';
import { requestContactLinking } from '../contactLinkingScheduler';
import { queryContacts, isPoolReady } from '../../workers/contactWorkerPool';
import { toLookupKey } from '../../utils/phoneNormalization';
import { dedupeEmailValues, dedupePhoneValues } from '../../utils/contactValueDedup';
import {
  EXTERNAL_CONTACTS_GET_ALL_SQL,
  EXTERNAL_CONTACT_LAST_MESSAGE_EXPR,
  EXTERNAL_CONTACT_RECENCY_UPDATE_SQL,
} from './contactRecencySql';

/**
 * BACKLOG-1727: Build the JSON array of lookup keys to store alongside phones_json.
 * Returned as a JSON string ready for direct SQL parameter binding.
 */
function normalizedPhonesJson(phones: string[] | null | undefined): string {
  if (!Array.isArray(phones) || phones.length === 0) return '[]';
  const keys = phones
    .map((p) => toLookupKey(p))
    .filter((k) => k.length > 0);
  return JSON.stringify(keys);
}

/**
 * Valid external contact source types
 * TASK-2301: Extracted as type alias; added google_contacts
 */
export type ExternalContactSource = 'macos' | 'iphone' | 'outlook' | 'google_contacts' | 'android_sync';

/**
 * ===========================================================================
 * BACKLOG-3029 — CAN THE DESKTOP FETCH THIS SOURCE AGAIN AT ALL?
 * ===========================================================================
 * Force Re-import empties the shadow table and then refills it. Emptying is
 * correct — this table is staging for the picker, not the user's contacts, and
 * a re-import that did not clear it would not be a re-import. The founder said
 * so himself when he corrected the first filing of this item:
 *
 *   > "the force re-import didn't delete them... on force re-import we normally
 *   >  delete the shadow db table don't we?"
 *
 * THE DEFECT IS THE REFILL, NOT THE EMPTYING. The emptying took all five
 * sources; the refill only ever covers the ones a contacts sync goes and
 * fetches. From his run on 2026-08-31:
 *
 *   21:42:56  Cleared all external contacts
 *   21:42:57  Contact source preferences: {"macosContacts":false, ...}
 *   21:42:57  Skipping macOS Contacts (disabled by user preference)
 *   21:42:57  Upserted 7 external contacts from outlook
 *   21:43:17  picker: 7 in (db 0 + external 7)
 *
 * 1,175 macOS rows and 28 Android rows emptied, 7 Outlook rows back. Nothing in
 * the main `contacts` table was touched, so this is availability loss — records
 * silently stop being offered for import and the source card reads 0 — and not
 * data loss.
 *
 * TWO SEPARATE CONDITIONS DECIDE WHETHER A SOURCE MAY BE EMPTIED, and this map
 * is only the second of them:
 *
 *   1. IS IT ABOUT TO BE REFILLED — enabled, and available on this platform.
 *      Only the caller knows; `SyncOrchestratorService` already computes exactly
 *      this to decide which of its three phases run, and now passes the answer
 *      in. Deliberately NOT re-derived here: two reads of one preference is how
 *      they come to disagree.
 *
 *   2. CAN THE DESKTOP EVER FETCH IT — the static property below. `android_sync`
 *      and `iphone` are unfetchable whatever the preferences say, so this map is
 *      the floor under (1) that no caller can talk its way past.
 *
 * `'desktop_refetch'` — a contacts sync re-reads it on demand. The three values
 *   are exactly the three phases in `src/services/SyncOrchestratorService.ts`:
 *   the macOS address book, Outlook via Graph, Google via People.
 *
 * `'device_push'` — the desktop has no code path that can ask for these records
 *   again:
 *     - `android_sync`: the companion POSTs its contacts and commits its diff
 *       state on a successful send, so it believes the desktop still holds them
 *       and the next ordinary sync computes an EMPTY diff. The only route back
 *       is `forceFullContactResync()`, which runs on PAIRING — so a user has to
 *       re-pair their phone, and nothing tells them that.
 *     - `iphone`: read out of a local iPhone backup the user selected
 *       (`iPhoneSyncStorageService`). The Force Re-import button fires
 *       `requestSync(['contacts'])` (`MacOSContactsImportSettings.tsx`) and the
 *       contacts sync has no iPhone phase, so nothing refills it either.
 *
 * WHY A MAP AND NOT `if (source !== 'android_sync')`. A name test states the
 * symptom that happened to be reported. This states the property that made it a
 * defect, and it is EXHAUSTIVE over `ExternalContactSource`, so a new member of
 * the union does not compile until someone classifies it — a future push-based
 * source cannot be caught silently by the same trap.
 */
export type ContactSourceRefetchability = 'desktop_refetch' | 'device_push';

export const CONTACT_SOURCE_REFETCHABILITY: Record<
  ExternalContactSource,
  ContactSourceRefetchability
> = {
  macos: 'desktop_refetch',
  outlook: 'desktop_refetch',
  google_contacts: 'desktop_refetch',
  android_sync: 'device_push',
  iphone: 'device_push',
};

/**
 * Answers for a RAW `source` string, which is why the parameter is not narrowed
 * to `ExternalContactSource`: it is applied to a list that arrived over IPC.
 *
 * FAILS CLOSED. Anything this file does not recognise is reported as NOT
 * refetchable, so an unknown value is preserved rather than emptied. The two
 * mistakes are not symmetrical: emptying a source the desktop cannot refill
 * leaves the user with no route back, while keeping rows for a source that
 * could have been refilled leaves stale rows the next sync of that source
 * prunes itself (`deleteStaleContactsBySource`).
 */
export function isDesktopRefetchableSource(source: string | null | undefined): boolean {
  if (!source) return false;
  return (
    CONTACT_SOURCE_REFETCHABILITY[source as ExternalContactSource] === 'desktop_refetch'
  );
}

/**
 * External contact as stored in database
 */
export interface ExternalContact {
  id: string;
  user_id: string;
  name: string | null;
  phones: string[];        // Parsed from phones_json
  emails: string[];        // Parsed from emails_json
  company: string | null;
  last_message_at: string | null;
  external_record_id: string;  // Renamed from macos_record_id (Migration 27)
  source: ExternalContactSource;  // Source of contact (Migration 27, TASK-1920: added outlook, TASK-2301/2302: added google_contacts)
  synced_at: string;
  /** BACKLOG-2401 — ZEXTERNALUUID. Captured and carried; nothing matches on it. */
  external_uuid?: string | null;
}

/**
 * External contact as returned from database (raw form with JSON strings)
 */
interface ExternalContactRow {
  id: string;
  user_id: string;
  name: string | null;
  phones_json: string | null;
  emails_json: string | null;
  company: string | null;
  last_message_at: string | null;
  external_record_id: string;  // Renamed from macos_record_id (Migration 27)
  source: string;              // New field: source of contact (Migration 27)
  synced_at: string;
}

/**
 * macOS Contact structure from Contacts API
 */
export interface MacOSContact {
  name: string;
  phones?: string[];
  emails?: string[];
  company?: string;
  recordId: string;  // macOS unique identifier (ZUNIQUEID) — DEVICE-LOCAL
  /**
   * BACKLOG-2401 — ZEXTERNALUUID, captured and stored, never matched on.
   * `recordId` is device-local; this is the only candidate portable identifier
   * and its portability is unverified. Capturing it is nearly free now and
   * impossible later for a user who has changed machines.
   */
  externalUuid?: string | null;
}

/**
 * Source-specific identity captured alongside `external_record_id`
 * (BACKLOG-2407) — serialized into `external_contacts.source_identity_json`.
 *
 * ---------------------------------------------------------------------------
 * CAPTURED NOW BECAUSE IT CANNOT BE CAPTURED LATER
 * ---------------------------------------------------------------------------
 * Every value here is WRITTEN and read by NOTHING, exactly as `external_uuid`
 * was when v57 introduced it. The justification is not that it is useful today:
 * it is that you cannot go back and read a phone the user no longer owns. Each
 * value is device- or store-supplied and leaves with the device.
 *
 * ---------------------------------------------------------------------------
 * WHY ONE JSON COLUMN RATHER THAN SIX NAMED ONES
 * ---------------------------------------------------------------------------
 * These fields share NO shape across sources — iPhone contributes five, Android
 * one, macOS none (its portable id is `external_uuid`, a genuinely cross-source
 * concept, and stays a real column). Six named columns on a shared table,
 * growing with every future source, would buy typing no query uses: a named
 * column implies a reader and there is none. Promotion stays cheap if one of
 * these ever becomes a key — `json_extract(source_identity_json, '$.lookupKey')`
 * in a later migration's backfill, safe because nothing copies
 * `external_contacts` positionally (databaseService.ts:2938).
 *
 * The counter-argument, recorded so it can be argued with rather than
 * rediscovered: v57 documented `external_uuid` as "WRITTEN here and read
 * NOWHERE", and it acquired two readers within one sprint (contactHandlers.ts,
 * contactSourceLinker.ts). Capture-only values get promoted fast in this
 * codebase. That is precisely why this is a TYPED shape with ONE serializer and
 * not a free-form bag — two call sites inventing their own key names is how
 * "nothing reads it" turns into "nothing CAN read it".
 */
export interface SourceIdentity {
  /** iPhone `ABPerson.ExternalIdentifier` — the external record id. */
  externalIdentifier?: string | null;
  /** iPhone `ABPerson.ExternalModificationTag` — ETag-like change tag. */
  externalModificationTag?: string | null;
  /** iPhone `ABPerson.ModificationDate`, ISO-8601. Update-vs-insert detection. */
  modifiedAt?: string | null;
  /** iPhone `ABPerson.CreationDate`, ISO-8601. */
  createdAt?: string | null;
  /** iPhone `ABPerson.StoreID` — the field that explains a sparse `external_uuid`. */
  storeId?: number | null;
  /**
   * Android `ContactsContract.Contacts.LOOKUP_KEY` — the identifier Android
   * designates as sync-stable, which `_ID` is not.
   *
   * WARNING, so this is never mistaken for a fix: capturing it does NOT survive
   * a device swap on its own. The stored key is `android-${deviceId}-${id}` and
   * `deviceId` is a DESKTOP-minted per-pairing UUID (localSyncService.ts:816-818)
   * re-minted on a fresh pairing. See the decision block where that key is built.
   */
  lookupKey?: string | null;
}

/**
 * Serialize a `SourceIdentity` for storage — the ONLY writer of
 * `source_identity_json` (BACKLOG-2407).
 *
 * Drops null/undefined/empty entries, so a column the source lacked is absent
 * rather than recorded as a present-but-null key — the distinction the whole
 * measurement rests on. Returns `null` when nothing at all was captured, which
 * is what lets the COALESCE in the upserts read "I have nothing to say" as
 * "leave what is already stored alone", making a re-import from an older backup
 * non-destructive.
 */
export function serializeSourceIdentity(
  identity: SourceIdentity | null | undefined
): string | null {
  if (!identity) return null;

  const populated: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(identity)) {
    if (value !== null && value !== undefined && value !== '') {
      populated[key] = value as string | number;
    }
  }

  return Object.keys(populated).length > 0 ? JSON.stringify(populated) : null;
}

/**
 * iPhone Contact structure from iPhone sync (SPRINT-068, BACKLOG-585)
 */
export interface iPhoneContact {
  name: string;
  phones?: string[];
  emails?: string[];
  company?: string;
  /** iPhone backup contact ID — `ABPerson.ROWID`, and DEVICE-LOCAL (BACKLOG-2407). */
  recordId: string;
  /**
   * BACKLOG-2407 — `ABPerson.ExternalUUID`, the iPhone counterpart of the macOS
   * ZEXTERNALUUID on `MacOSContact` above. Captured, never matched on;
   * portability unverified and population rate measured at parse time.
   */
  externalUuid?: string | null;
  /** BACKLOG-2407 — the remaining iPhone identity fields. Captured, never read. */
  sourceIdentity?: SourceIdentity | null;
}

/**
 * Outlook Contact structure from Microsoft Graph API (TASK-1921)
 * Re-exported from outlookFetchService for convenience
 */
export interface OutlookContactInput {
  external_record_id: string;  // Graph API contact id
  name: string | null;
  emails: string[];
  phones: string[];
  company: string | null;
}

/**
 * Generic external contact input for upsert operations (TASK-2301)
 * Used by both Outlook and Google contacts (and future sources)
 */
export interface ExternalContactInput {
  external_record_id: string;
  name: string | null;
  emails: string[];
  phones: string[];
  /**
   * BACKLOG-2407 — source-specific identity captured beside the record id.
   * Optional: outlook and google_contacts supply nothing and must keep working
   * unchanged. Today only `android_sync` populates it (with `lookupKey`).
   */
  source_identity?: SourceIdentity | null;
  company: string | null;
}

/**
 * Sync result statistics
 */
export interface SyncResult {
  inserted: number;
  updated: number;
  deleted: number;
  total: number;
  /**
   * BACKLOG-2391: rows that were already present and byte-identical on every
   * written column — a real "nothing happened" signal, distinct from an update.
   *
   * Only the macOS `fullSync` populates this. The outlook / google / generic
   * source syncs leave it UNDEFINED on purpose: they still cannot tell an
   * insert from an update, and reporting a fabricated 0 would be a worse lie
   * than admitting the number is unknown.
   */
  unchanged?: number;
}

// ============================================
// READ OPERATIONS
// ============================================

/**
 * One shadow row -> one `ExternalContact`.
 *
 * BACKLOG-2457 — THE RECORD'S OWN REPEATS ARE COLLAPSED HERE, ON THE WAY OUT.
 *
 * `emails_json` stores exactly what the provider handed over, and providers hand
 * over one mailbox more than once as a matter of course: Microsoft Graph returns
 * every email-typed field of an Outlook contact in ONE `emailAddresses` array
 * (the reported record carried one mailbox under both `Email` and the chat
 * field), and `_mapGraphContact` flattens `mobilePhone` + `homePhones` +
 * `businessPhones` into one phone array. Apple's unified cards do the same on
 * their own. The picker then drew one address twice, which reads as a broken
 * import.
 *
 * WHY THE READ AND NOT THE WRITE. Deduping in the upserts would only clean rows
 * written AFTER the fix — every already-synced contact would keep showing its
 * duplicate until the next full sync, and the reported card is already in that
 * state. Collapsing here fixes the existing rows on the very next picker open,
 * costs one pass over a handful of strings per contact, and leaves `emails_json`
 * as the faithful record of what the source actually said.
 *
 * THIS IS ALSO THE IMPORT'S INPUT, not just the card's. `contacts:get-available`
 * copies `emails`/`phones` straight into each picker row's `allEmails`/
 * `allPhones`, and importing that row feeds them to `createContactsBatch` /
 * `backfillContactEmailsSync`. Both of those already refuse a repeat
 * (case-folded `Set` + `UNIQUE(contact_id, email)`), so the duplicate never
 * reached `contact_emails` — see the tests, which prove that rather than assume
 * it. Collapsing here keeps the two layers agreeing about how many addresses a
 * record has instead of relying on the last one to catch it.
 *
 * Order is preserved, so `emails?.[0]` still resolves the same primary.
 */
function toExternalContact(row: ExternalContactRow): ExternalContact {
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    phones: dedupePhoneValues(JSON.parse(row.phones_json || '[]')),
    emails: dedupeEmailValues(JSON.parse(row.emails_json || '[]')),
    company: row.company,
    last_message_at: row.last_message_at,
    external_record_id: row.external_record_id,
    source: row.source as ExternalContactSource,
    synced_at: row.synced_at,
  };
}

/**
 * Get all external contacts for a user, sorted by last_message_at DESC
 * Uses NULLS LAST workaround for SQLite
 */
export function getAllForUser(userId: string): ExternalContact[] {
  // BACKLOG-2355: recency (`last_message_at`) is computed INLINE via the shared
  // EXTERNAL_CONTACTS_GET_ALL_SQL — phone + email, identical to the imported
  // path — so an email-only external contact reads its real last-contacted date
  // (not NULL) and importing it does not change the value (no select-jump). This
  // query is kept byte-for-byte identical to the worker's runExternalQuery.
  // NULLS LAST: Sort NULL dates after non-NULL dates, then by name.
  const rows = dbAll<ExternalContactRow>(EXTERNAL_CONTACTS_GET_ALL_SQL, [userId]);

  // BACKLOG-2391: the per-row `[DIAG-1270] Shadow READ` warn that used to sit
  // here printed the contact's NAME and every EMAIL ADDRESS, once per
  // multi-email row, on every picker open. At ~1000 contacts that is hundreds
  // of PII-bearing lines per open — shipped to production (warn > info), and
  // enough noise to bury the funnel counters this ticket exists to surface.
  // The aggregate that matters is the picker stage line.
  return rows.map(toExternalContact);
}

/**
 * TASK-1956: Async version of getAllForUser that runs the query via the
 * persistent worker pool. No new Worker() spawn per query.
 *
 * Falls back to sync getAllForUser if pool is not ready.
 *
 * @param userId - The user ID to query contacts for
 * @param timeoutMs - Maximum time to wait for the worker (default: 30000ms)
 * @returns Promise resolving to the same ExternalContact[] as getAllForUser
 */
export async function getAllForUserAsync(
  userId: string,
  timeoutMs: number = 30_000,
): Promise<ExternalContact[]> {
  if (!isPoolReady()) {
    // Fallback to sync version if pool not initialized
    return getAllForUser(userId);
  }

  const rawRows = await queryContacts('external', userId, timeoutMs) as ExternalContactRow[];

  // BACKLOG-2391: per-row PII warn removed — see getAllForUser above.
  // BACKLOG-2457: SAME mapper as the sync path. This is the branch the picker
  // actually takes whenever the worker pool is warm, so a collapse applied to
  // only one of the two would read as fixed and behave broken in the field.
  return rawRows.map(toExternalContact);
}

/**
 * Get count of external contacts for a user
 */
export function getCount(userId: string): number {
  const result = dbGet<{ count: number }>(
    'SELECT COUNT(*) as count FROM external_contacts WHERE user_id = ?',
    [userId]
  );
  return result?.count || 0;
}

/**
 * Get the most recent sync time for a user
 */
export function getLastSyncTime(userId: string): string | null {
  const result = dbGet<{ synced_at: string }>(
    'SELECT MAX(synced_at) as synced_at FROM external_contacts WHERE user_id = ?',
    [userId]
  );
  return result?.synced_at || null;
}

/**
 * Check if sync is stale (older than specified hours)
 */
export function isStale(userId: string, maxAgeHours: number = 24): boolean {
  const lastSync = getLastSyncTime(userId);
  if (!lastSync) return true;

  const lastSyncDate = new Date(lastSync);
  const now = new Date();
  const hoursSinceSync = (now.getTime() - lastSyncDate.getTime()) / (1000 * 60 * 60);

  return hoursSinceSync > maxAgeHours;
}

/**
 * Get contact counts grouped by source for a user (TASK-1991)
 * Returns how many external contacts exist per source (macos, iphone, outlook)
 */
export function getContactSourceStats(userId: string): Record<string, number> {
  const rows = dbAll<{ source: string; count: number }>(
    `SELECT source, COUNT(*) as count FROM external_contacts WHERE user_id = ? GROUP BY source`,
    [userId]
  );
  const stats: Record<string, number> = { macos: 0, iphone: 0, outlook: 0, google_contacts: 0, android_sync: 0 };
  for (const row of rows) {
    stats[row.source] = row.count;
  }
  return stats;
}

// ============================================
// WRITE OPERATIONS
// ============================================

/**
 * Upsert contacts from macOS Contacts API
 * Returns count of contacts processed
 */
export function upsertFromMacOS(userId: string, contacts: MacOSContact[]): number {
  const now = new Date().toISOString();

  // BACKLOG-2401: external_uuid (ZEXTERNALUUID) is WRITTEN here and read
  // NOWHERE. It is captured because it cannot be recovered later — a user who
  // changes machines or reinstalls takes the old store with them — and because
  // it is the only candidate identifier that might survive a device change,
  // unlike the device-local ZUNIQUEID in external_record_id. Its portability is
  // unverified, so nothing may depend on it yet.
  //
  // COALESCE on update rather than plain `excluded.external_uuid`: a sync that
  // cannot supply the value must never ERASE one already captured.
  const stmt = `
    INSERT INTO external_contacts (id, user_id, name, phones_json, phones_normalized_json, emails_json, company, external_record_id, source, synced_at, external_uuid)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'macos', ?, ?)
    ON CONFLICT(user_id, source, external_record_id) DO UPDATE SET
      name = excluded.name,
      phones_json = excluded.phones_json,
      phones_normalized_json = excluded.phones_normalized_json,
      emails_json = excluded.emails_json,
      company = excluded.company,
      synced_at = excluded.synced_at,
      external_uuid = COALESCE(excluded.external_uuid, external_contacts.external_uuid)
  `;

  let count = 0;

  // DIAG-1270: Count multi-email contacts being written.
  // BACKLOG-2391: this used to emit one `warn` PER multi-email contact carrying
  // that contact's NAME and every one of their EMAIL ADDRESSES. Production runs
  // at info, so those lines shipped in real user logs and into support tickets.
  // The aggregate below is the number the diagnostic was actually after.
  let multiEmailCount = 0;
  dbTransaction(() => {
    for (const contact of contacts) {
      const emailsArr = contact.emails || [];
      if (emailsArr.length > 1) {
        multiEmailCount++;
      }
      dbRun(stmt, [
        uuidv4(),
        userId,
        contact.name || null,
        JSON.stringify(contact.phones || []),
        normalizedPhonesJson(contact.phones),
        JSON.stringify(emailsArr),
        contact.company || null,
        contact.recordId,
        now,
        contact.externalUuid || null,
      ]);
      count++;
    }
  });

  logService.info(`Upserted ${count} external contacts from macOS (${multiEmailCount} with multiple emails)`, 'ExternalContactDbService', { userId });

  // BACKLOG-2474 — one of the THREE places a record can enter this table.
  // Signals Phase 2; does not run it. See contactLinkingScheduler.
  if (count > 0) requestContactLinking(userId);

  return count;
}

/**
 * Upsert contacts from iPhone sync (SPRINT-068, BACKLOG-585)
 * Returns count of contacts processed
 *
 * TASK-2110: Accepts optional sessionId for ACID rollback.
 * sync_session_id is only set on INSERT (new contacts), not on UPDATE.
 * This ensures rollback only deletes newly-created contacts, not
 * pre-existing contacts that were merely updated during this sync.
 */
export function upsertFromiPhone(userId: string, contacts: iPhoneContact[], sessionId?: string): number {
  const now = new Date().toISOString();

  // BACKLOG-2407: `external_uuid` (ABPerson.ExternalUUID) and
  // `source_identity_json` are WRITTEN here and read NOWHERE, matching what
  // upsertFromMacOS does for ZEXTERNALUUID. `external_record_id` is UNCHANGED —
  // still ABPerson.ROWID. This is capture-now-use-later; it is not a re-key.
  //
  // COALESCE on update rather than plain `excluded.x`, and this path makes that
  // reachable rather than theoretical: the parser emits NULL for any identity
  // column the backup's ABPerson lacks, so a user who re-imports from an OLDER
  // backup after a newer one would otherwise ERASE identifiers already captured
  // — the exact values that cannot be re-read once the device is gone.
  const stmt = `
    INSERT INTO external_contacts (id, user_id, name, phones_json, phones_normalized_json, emails_json, company, source, external_record_id, synced_at, sync_session_id, external_uuid, source_identity_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'iphone', ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, source, external_record_id) DO UPDATE SET
      name = excluded.name,
      phones_json = excluded.phones_json,
      phones_normalized_json = excluded.phones_normalized_json,
      emails_json = excluded.emails_json,
      company = excluded.company,
      synced_at = excluded.synced_at,
      external_uuid = COALESCE(excluded.external_uuid, external_contacts.external_uuid),
      source_identity_json = COALESCE(excluded.source_identity_json, external_contacts.source_identity_json)
  `;

  let count = 0;

  dbTransaction(() => {
    for (const contact of contacts) {
      dbRun(stmt, [
        uuidv4(),
        userId,
        contact.name || null,
        JSON.stringify(contact.phones || []),
        normalizedPhonesJson(contact.phones),
        JSON.stringify(contact.emails || []),
        contact.company || null,
        contact.recordId,
        now,
        sessionId || null,
        contact.externalUuid || null,
        serializeSourceIdentity(contact.sourceIdentity),
      ]);
      count++;
    }
  });

  logService.info(`Upserted ${count} external contacts from iPhone`, 'ExternalContactDbService', { userId });

  // BACKLOG-2474 — DELIBERATELY NOT SIGNALLED WHEN A SESSION IS OPEN.
  //
  // A sessionId means these rows are provisional: TASK-2110 rollback deletes
  // exactly them (`deleteBySessionId`) if a later stage of the iPhone sync
  // fails or the user cancels — and `storeAttachments` runs after this and can
  // take minutes. Linking them now would write `contact_source_links` and
  // `contact_link_proposals` keyed on `source_record_id`s that rollback then
  // deletes, and rollback does not clean either identity table. The result
  // would be links to records that no longer exist — a silent breach of the
  // ACID guarantee, invisible in the review queue because its read INNER JOINs
  // `external_contacts` and drops the orphans.
  //
  // The signal for this path is at the sync's COMMIT point instead
  // (`iPhoneSyncStorageService.persistSyncResult`), once rollback is off the
  // table. Session-less callers are not provisional and signal normally.
  if (count > 0 && sessionId === undefined) requestContactLinking(userId);

  return count;
}

/**
 * Delete external contacts by sync session ID (TASK-2110: ACID rollback)
 * Only deletes contacts that were newly inserted during this session
 * (sync_session_id is only set on INSERT, not UPDATE).
 */
export function deleteBySessionId(userId: string, sessionId: string): number {
  // BACKLOG-2474 — WHOEVER DELETES A SOURCE RECORD MUST NOT LEAVE THE CROSSWALK
  // POINTING AT IT.
  //
  // Suppressing the linking signal for session-scoped writes (see
  // `upsertFromiPhone`) is necessary but NOT sufficient, and a test proved it:
  // the pass reads the whole table, so a signal from ANY OTHER source — a macOS
  // or Outlook sync finishing while the iPhone sync is still copying
  // attachments — runs a pass that sees the provisional rows and links them.
  // Suppression narrows the window; only cleanup closes it.
  //
  // Captured BEFORE the delete, because afterwards there is nothing left to
  // identify. A link to a record that no longer exists is worse than no link:
  // it silently attributes a contact to a source the user cannot see, and the
  // review queue hides the matching proposals because its read INNER JOINs
  // `external_contacts`.
  // BACKLOG-2480: this path's cleanup was the model the other four lacked. It
  // now shares the SAME helper rather than keeping a second copy — two
  // implementations of one rule is how sibling paths drift apart, which is
  // exactly what BACKLOG-2510 and BACKLOG-2525 were.
  const result = {
    changes: deleteExternalContactsAndTheirLinks(
      userId,
      `user_id = ? AND sync_session_id = ?`,
      [userId, sessionId],
    ),
  };

  // `contact_link_verdicts` is DELIBERATELY NOT TOUCHED. A verdict is the
  // user's own answer, not derived data: if this sync is retried and the same
  // record returns, their "different people" must still bind. Clearing it would
  // re-ask a question they already answered — the exact nagging this epic
  // exists to prevent.
  //
  // A `source_id` LINK IS EQUALLY THE USER'S OWN CHOICE, AND IS STILL DELETED.
  // The path is reachable: the user imports one of these records during the
  // attachment phase, `linkImportedContact` writes `match_method: 'source_id'`
  // for it, and then the sync fails.
  //
  // The distinction is what each row MEANS once its record is gone. A verdict
  // is a judgement about two identities and stays true whether or not the
  // record is present. A link is a POINTER — with the row deleted it addresses
  // nothing, and keeping it would attribute the contact to a source that is not
  // there. It also self-heals: the next successful sync re-writes the record
  // and the pass re-derives the link. A deleted verdict could never be
  // recovered, because only the user can supply it.
  //
  // NOTE: THIS INVARIANT HOLDS ONLY HERE. The other four deletion paths in this
  // file — `deleteStaleContactsBySource` (which runs on EVERY full Outlook,
  // Google and Android sync), `deleteByMacOSRecordId`, `deleteBySource` and
  // `clearAllForUser` (since BACKLOG-3029, `clearRefetchableSourcesForUser`) —
  // do no crosswalk cleanup and leave orphans behind. That
  // BACKLOG-2480 CLOSED THIS. When the note above was written this was the ONLY
  // path that cleaned up, and it warned against reading it as evidence the
  // invariant held globally. It now does: all five deletion paths go through
  // `deleteExternalContactsAndTheirLinks`, and the write-atomicity guard
  // (BACKLOG-2530) rejects a new multi-write path that skips a transaction.

  if (result.changes > 0) {
    logService.info(
      `Deleted ${result.changes} external contacts for session ${sessionId} ` +
        `(and any crosswalk links and proposals that pointed at them)`,
      'ExternalContactDbService',
      { userId }
    );
  }

  return result.changes;
}

/**
 * Generic upsert for external contacts with explicit source (TASK-2301)
 * Used by Outlook and Google contacts (and future sources).
 * Returns count of contacts processed.
 *
 * CRITICAL: The source parameter is passed as a SQL value in the INSERT,
 * so contacts are correctly attributed to their origin.
 */
export function upsertExternalContacts(
  userId: string,
  source: ExternalContactSource,
  contacts: ExternalContactInput[],
): number {
  const now = new Date().toISOString();

  // BACKLOG-2407: `source_identity_json` is written here and read nowhere.
  // COALESCE so a source that supplies nothing (outlook, google_contacts) can
  // never erase what another sync captured for the same record.
  const stmt = `
    INSERT INTO external_contacts (id, user_id, name, phones_json, phones_normalized_json, emails_json, company, source, external_record_id, synced_at, source_identity_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, source, external_record_id) DO UPDATE SET
      name = excluded.name,
      phones_json = excluded.phones_json,
      phones_normalized_json = excluded.phones_normalized_json,
      emails_json = excluded.emails_json,
      company = excluded.company,
      synced_at = excluded.synced_at,
      source_identity_json = COALESCE(excluded.source_identity_json, external_contacts.source_identity_json)
  `;

  let count = 0;

  dbTransaction(() => {
    for (const contact of contacts) {
      dbRun(stmt, [
        uuidv4(),
        userId,
        contact.name || null,
        JSON.stringify(contact.phones || []),
        normalizedPhonesJson(contact.phones),
        JSON.stringify(contact.emails || []),
        contact.company || null,
        source,
        contact.external_record_id,
        now,
        serializeSourceIdentity(contact.source_identity),
      ]);
      count++;
    }
  });

  logService.info(`Upserted ${count} external contacts from ${source}`, 'ExternalContactDbService', { userId });

  // BACKLOG-2474 — the path that carries outlook, google_contacts and
  // android_sync. THIS is the line that closes the Windows hole: a user with
  // macosEnabled=false and iphoneEnabled=false reaches Phase 2 through here,
  // and there is no platform gate anywhere on it.
  if (count > 0) requestContactLinking(userId);

  return count;
}

/**
 * Stamp EVERY row of one source as seen in the current sync (BACKLOG-2401).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS — for the upsert-only (incremental) sync paths
 * ---------------------------------------------------------------------------
 * `synced_at` is this table's "was this record present in the latest sync"
 * marker: `deleteStaleContactsBySource` prunes on `synced_at < syncStartTime`,
 * and the identity crosswalk's currency test (`sourceRecordIsCurrent`) reads the
 * same signal to decide whether a competing source record is a live claim.
 *
 * A FULL sync satisfies that by construction — it upserts every record the
 * source returned, so all of them carry the batch stamp. An INCREMENTAL diff
 * does not: it upserts only what CHANGED (localSyncService, android_sync,
 * BACKLOG-2208) and deliberately skips the prune. Every unchanged row therefore
 * keeps an older stamp and reads as "not current" — not because the source
 * stopped returning it, but because the diff had no reason to mention it.
 *
 * The consequence is not cosmetic: it silently DISABLES the crosswalk's
 * reassignment guard for that source between full snapshots, turning a withheld
 * link into a wrong one. Over-flagging is the safe failure here; a silent wrong
 * link into a table with no unlink UI is not.
 *
 * This makes explicit, in the data, the assertion the incremental path ALREADY
 * MAKES: skipping the prune means "rows I did not mention are still present".
 *
 * ---------------------------------------------------------------------------
 * SAFE FOR EVERY OTHER READER OF `synced_at` — audited, not assumed
 * ---------------------------------------------------------------------------
 *  - `getLastSyncTime` / `isStale` take MAX(synced_at) across all sources. The
 *    diff already wrote this instant to its changed rows, so MAX is unmoved; and
 *    where the diff changed NOTHING, advancing it is correct — a sync did run,
 *    so the shadow table is not stale.
 *  - `deleteStaleContactsBySource` prunes `synced_at < syncStartTime` and runs
 *    only on FULL snapshots. A row stamped by an earlier incremental diff is
 *    still older than the next snapshot's start, so a record the source has
 *    genuinely dropped is still pruned then.
 *  - Nothing else reads this column; the remaining hits are row mapping.
 *
 * ONE timestamp for the whole source, applied AFTER the upsert, so every row
 * ends up byte-identical. Stamping only the untouched rows with a fresh value
 * would make them NEWER than the just-upserted ones and invert the very bug
 * this fixes.
 */
export function markSourceRecordsCurrent(
  userId: string,
  source: ExternalContactSource,
  syncedAt: string = new Date().toISOString(),
): number {
  const result = dbRun(
    `UPDATE external_contacts SET synced_at = ? WHERE user_id = ? AND source = ?`,
    [syncedAt, userId, source],
  );
  return result.changes;
}

/**
 * Upsert contacts from Outlook via Microsoft Graph API (TASK-1921)
 * Returns count of contacts processed
 *
 * TASK-2301: Now delegates to generic upsertExternalContacts with source='outlook'
 */
export function upsertFromOutlook(userId: string, contacts: OutlookContactInput[]): number {
  return upsertExternalContacts(userId, 'outlook', contacts);
}

/**
 * Full sync from Outlook contacts (TASK-1921)
 * - Upserts all contacts from Outlook
 * - Deletes Outlook contacts that no longer exist (only source='outlook')
 * - Updates last_message_at from phone_last_message lookup
 *
 * CRITICAL: Does NOT touch macos/iphone contacts — only manages 'outlook' source
 */
export function syncOutlookContacts(userId: string, outlookContacts: OutlookContactInput[]): SyncResult {
  const syncStartTime = new Date().toISOString();

  // Step 1: Upsert all Outlook contacts (sets synced_at to current time)
  const upsertCount = upsertFromOutlook(userId, outlookContacts);

  // Step 2: Delete stale Outlook contacts only (synced_at < syncStartTime, source='outlook')
  const deleteCount = deleteStaleContactsBySource(userId, 'outlook', syncStartTime);

  // Step 3: Update last_message_at from phone_last_message lookup table
  updateLastMessageAtFromLookupTable(userId);

  const result: SyncResult = {
    inserted: upsertCount,
    updated: 0,
    deleted: deleteCount,
    total: getCount(userId),
  };

  logService.info('Outlook contacts sync complete', 'ExternalContactDbService', {
    userId,
    ...result,
  });

  return result;
}

/**
 * Full sync from Google contacts via People API (TASK-2301)
 * - Upserts all contacts from Google with source='google_contacts'
 * - Deletes Google contacts that no longer exist (only source='google_contacts')
 * - Updates last_message_at from phone_last_message lookup
 *
 * CRITICAL: Does NOT touch macos/iphone/outlook contacts -- only manages 'google_contacts' source
 */
export function syncGoogleContacts(userId: string, googleContacts: ExternalContactInput[]): SyncResult {
  const syncStartTime = new Date().toISOString();

  // Step 1: Upsert all Google contacts with correct source
  const upsertCount = upsertExternalContacts(userId, 'google_contacts', googleContacts);

  // Step 2: Delete stale Google contacts only (synced_at < syncStartTime, source='google_contacts')
  const deleteCount = deleteStaleContactsBySource(userId, 'google_contacts', syncStartTime);

  // Step 3: Update last_message_at from phone_last_message lookup table
  updateLastMessageAtFromLookupTable(userId);

  const result: SyncResult = {
    inserted: upsertCount,
    updated: 0,
    deleted: deleteCount,
    total: getCount(userId),
  };

  logService.info('Google contacts sync complete', 'ExternalContactDbService', {
    userId,
    ...result,
  });

  return result;
}

/**
 * Generic sync for any contact source (TASK-2301)
 * Routes to the appropriate source-specific sync function.
 *
 * This is the preferred entry point for the contactSyncService
 * to ensure each source uses the correct sync pipeline.
 */
export function syncContactsBySource(
  userId: string,
  source: ExternalContactSource,
  contacts: ExternalContactInput[],
): SyncResult {
  switch (source) {
    case 'outlook':
      return syncOutlookContacts(userId, contacts);
    case 'google_contacts':
      return syncGoogleContacts(userId, contacts);
    default: {
      // For other sources, use generic upsert + stale deletion
      const syncStartTime = new Date().toISOString();
      const upsertCount = upsertExternalContacts(userId, source, contacts);
      const deleteCount = deleteStaleContactsBySource(userId, source, syncStartTime);
      updateLastMessageAtFromLookupTable(userId);

      const result: SyncResult = {
        inserted: upsertCount,
        updated: 0,
        deleted: deleteCount,
        total: getCount(userId),
      };

      logService.info(`${source} contacts sync complete`, 'ExternalContactDbService', {
        userId,
        ...result,
      });

      return result;
    }
  }
}

/**
 * Update last_message_at for all contacts using the shared phone + email recency
 * computation (BACKLOG-2355 — was phone-only).
 *
 * BACKLOG-1727: Matches phones on the parallel `phones_normalized_json` array
 * populated via `toLookupKey` at insert time so writer and reader agree on the
 * lookup key regardless of how the raw phone was originally formatted.
 *
 * BACKLOG-2355: Now ALSO folds in email recency (email_participants -> emails,
 * matched on emails_json), via EXTERNAL_CONTACT_RECENCY_UPDATE_SQL, so this
 * stored value agrees with the imported path and with the inline load-path
 * computation. This keeps the precomputed column meaningful for any reader that
 * does not use EXTERNAL_CONTACTS_GET_ALL_SQL. Set-based, one transaction.
 */
export function updateLastMessageAtFromLookupTable(userId: string): number {
  const db = ensureDb();

  const result = db.prepare(EXTERNAL_CONTACT_RECENCY_UPDATE_SQL).run(userId);

  logService.info(`Updated last_message_at for ${result.changes} external contacts`, 'ExternalContactDbService', { userId });

  return result.changes;
}

/**
 * Update last_message_at for a single phone number
 * Uses json_each() for proper JSON array phone matching.
 *
 * BACKLOG-1727: Matches on `phones_normalized_json` (populated via shared
 * `toLookupKey`) so the caller's already-normalized key matches
 * the stored key exactly.
 *
 * Called after individual message imports to keep dates current.
 */
export function updateLastMessageAtForPhone(userId: string, normalizedPhone: string, lastMessageAt: string): number {
  const db = ensureDb();

  const result = db.prepare(`
    UPDATE external_contacts
    SET last_message_at = CASE
      WHEN last_message_at IS NULL OR last_message_at < ? THEN ?
      ELSE last_message_at
    END
    WHERE user_id = ?
      AND id IN (
        SELECT ec.id
        FROM external_contacts ec, json_each(ec.phones_normalized_json) AS p
        WHERE ec.user_id = ?
          AND p.value = ?
      )
  `).run(lastMessageAt, lastMessageAt, userId, userId, normalizedPhone);

  return result.changes;
}

/**
 * Delete stale contacts by source that were not updated in the current sync
 * Used during full sync to remove contacts that no longer exist in source system
 *
 * BACKLOG-2385: This is the ONLY stale-deletion entry point. An unscoped
 * `deleteStaleContacts(userId, syncStartTime)` variant used to live here and was
 * called by the macOS `fullSync`; because its DELETE had no `source` predicate, a
 * macOS sync wiped every outlook / google_contacts / iphone / android_sync row
 * that had not been re-synced in that same instant. It was deleted outright
 * rather than left `@deprecated` — a same-shape unscoped sibling is exactly the
 * footgun that caused the incident. Every sync path MUST pass its own `source`.
 */
/**
 * ===========================================================================
 * DELETE SOURCE RECORDS AND EVERYTHING THAT POINTS AT THEM (BACKLOG-2480)
 * ===========================================================================
 * **Whoever deletes a source record must not leave the crosswalk pointing at
 * it.** Five paths delete from `external_contacts`; until this helper existed,
 * only ONE of them cleaned up — the rest left `contact_source_links` and
 * `contact_link_proposals` rows referencing records that no longer exist.
 *
 * The one that mattered most is `deleteStaleContactsBySource`, which runs on
 * **every full Outlook, Google or Android sync** — and BACKLOG-2474 made the
 * linking pass run on every write path, so far more links are created while the
 * same four paths still removed none of them.
 *
 * WHAT AN ORPHAN COSTS:
 *   - A crosswalk row naming a source record that is gone. `sourceRecordIsCurrent`
 *     catches some of it INCIDENTALLY — incidental is not by design.
 *   - A review proposal about a record the user can no longer see, so the
 *     question is unanswerable. BACKLOG-2410's own reasoning: a queue of
 *     unanswerable questions is worse than an empty one.
 *   - Provenance naming a source record that no longer exists.
 *
 * ONE HELPER, NOT FOUR FIXES. Four independent cleanups is four chances to drift
 * — and drift between sibling paths is precisely what caused BACKLOG-2510 and
 * BACKLOG-2525. A path that forgets to call this now has to forget the ONLY way
 * to delete a source record.
 *
 * `contact_link_verdicts` is DELIBERATELY NOT TOUCHED. A verdict is the user's
 * own answer, not derived data: if the record returns on a later sync, their
 * "these are different people" must still bind. Clearing it would re-ask a
 * question they already answered.
 *
 * @param whereSql  predicate over `external_contacts`, WITHOUT the `WHERE`
 * @param params    bound parameters for `whereSql`, in order
 */
function deleteExternalContactsAndTheirLinks(
  userId: string,
  whereSql: string,
  params: unknown[],
): number {
  return dbTransaction(() => {
    // Read the identities FIRST — after the delete there is nothing left to
    // join against, which is exactly why the four unguarded paths could not
    // have cleaned up as an afterthought.
    const doomed = dbAll<{ source: string; external_record_id: string }>(
      `SELECT source, external_record_id FROM external_contacts
        WHERE ${whereSql} AND external_record_id IS NOT NULL`,
      params,
    );

    const result = dbRun(`DELETE FROM external_contacts WHERE ${whereSql}`, params);

    for (const row of doomed) {
      dbRun(
        `DELETE FROM contact_source_links
          WHERE user_id = ? AND source_type = ? AND source_record_id = ?`,
        [userId, row.source, row.external_record_id],
      );
      dbRun(
        `DELETE FROM contact_link_proposals
          WHERE user_id = ? AND source_type = ? AND source_record_id = ?`,
        [userId, row.source, row.external_record_id],
      );
    }

    return result.changes;
  });
}

export function deleteStaleContactsBySource(userId: string, source: ExternalContactSource, currentSyncTime: string): number {
  const changes = deleteExternalContactsAndTheirLinks(
    userId,
    `user_id = ? AND source = ? AND synced_at < ?`,
    [userId, source, currentSyncTime],
  );

  if (changes > 0) {
    logService.info(`Deleted ${changes} stale ${source} external contacts`, 'ExternalContactDbService', { userId });
  }

  return changes;
}

/**
 * Delete stale iPhone contacts (SPRINT-068, BACKLOG-585)
 * Only deletes contacts with source='iphone' that weren't updated in current sync
 */
export function deleteStaleIPhoneContacts(userId: string, currentSyncTime: string): number {
  return deleteStaleContactsBySource(userId, 'iphone', currentSyncTime);
}

/**
 * Delete a specific contact by macOS record ID
 */
export function deleteByMacOSRecordId(userId: string, recordId: string): void {
  deleteExternalContactsAndTheirLinks(
    userId,
    'user_id = ? AND source = ? AND external_record_id = ?',
    [userId, 'macos', recordId],
  );
}

/**
 * Delete all external contacts for a user with a specific source.
 * Used for Android force re-import to clear all android_sync contacts.
 *
 * BACKLOG-1468: Android Force Re-import clears synced data
 *
 * @param userId - User ID for contact ownership
 * @param source - The source to delete (e.g., 'android_sync')
 * @returns Number of contacts deleted
 */
export function deleteBySource(userId: string, source: ExternalContactSource): number {
  const changes = deleteExternalContactsAndTheirLinks(
    userId,
    'user_id = ? AND source = ?',
    [userId, source],
  );
  logService.info(`Deleted ${changes} external contacts with source '${source}'`, 'ExternalContactDbService', { userId });
  return changes;
}

/**
 * BACKLOG-3029 — the emptying half of Force Re-import.
 *
 * Empties the shadow rows for the sources the CALLER says it is about to refill,
 * intersected with the sources the desktop can actually fetch. It replaced
 * `clearAllForUser`, which emptied every row the user had and left every source
 * that was not about to be refilled with nothing to bring it back.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CALLER SUPPLIES THE LIST
 * ---------------------------------------------------------------------------
 * "Is this source about to be refilled" is a question about the caller's own
 * plan — which phases it will run, given the user's preferences and the
 * platform. `SyncOrchestratorService` already computes it to gate those phases.
 * Re-deriving it here would be a second read of one preference, and this
 * codebase has watched two such gates drift apart before (BACKLOG-2986). So the
 * orchestrator declares its plan and this function holds it to the one thing
 * the orchestrator cannot know it is wrong about: whether the source is
 * fetchable at all.
 *
 * ---------------------------------------------------------------------------
 * THE PREDICATE IS AN `IN`, AND THAT IS THE WHOLE POINT
 * ---------------------------------------------------------------------------
 * `source IN (requested and fetchable)`, never `source NOT IN (preserved)`. The
 * two read the same on today's five values and behave oppositely on the sixth:
 * with `IN`, a source nobody has classified is not named by the DELETE and
 * survives; with `NOT IN`, it is emptied the moment it exists. What made this a
 * defect was a source nobody thought about when the DELETE was written.
 *
 * Goes through `deleteExternalContactsAndTheirLinks` like the other four
 * deletion paths, so the crosswalk cleanup (BACKLOG-2480) and the single
 * transaction (BACKLOG-2530) come with it rather than being written again.
 *
 * @param requested raw source names the caller is about to refill; anything
 *                  unrecognised or push-based is dropped, not obeyed
 * @returns the number of `external_contacts` rows actually deleted
 */
export function clearRefetchableSourcesForUser(
  userId: string,
  requested: readonly string[],
): number {
  // De-duplicated so a caller repeating a name cannot produce a longer
  // placeholder list than there are distinct sources.
  const sources = [...new Set(requested)].filter(isDesktopRefetchableSource).sort();
  const dropped = [...new Set(requested)].filter((s) => !isDesktopRefetchableSource(s)).sort();

  if (dropped.length > 0) {
    // Warn rather than throw. Dropping fails safe — those rows stay — whereas
    // rejecting the call would turn a defensive guard into a failed re-import.
    logService.warn(
      `Force re-import asked to empty ${dropped.length} source(s) the desktop cannot ` +
        `re-fetch (${dropped.join(', ')}); their rows were left in place`,
      'ExternalContactDbService',
      { userId }
    );
  }

  // `source IN ()` is a SQLite syntax error, and "refill nothing" is a real
  // state — every contact source switched off.
  if (sources.length === 0) {
    logService.info(
      'Force re-import emptied nothing: no re-fetchable source was named',
      'ExternalContactDbService',
      { userId }
    );
    return 0;
  }

  const placeholders = sources.map(() => '?').join(', ');

  const changes = deleteExternalContactsAndTheirLinks(
    userId,
    `user_id = ? AND source IN (${placeholders})`,
    [userId, ...sources],
  );

  logService.info(
    `Cleared ${changes} external contacts from the sources about to be re-fetched ` +
      `(${sources.join(', ')}); every other source was left in place`,
    'ExternalContactDbService',
    { userId }
  );

  return changes;
}

// ============================================
// SYNC OPERATIONS
// ============================================

/**
 * Full sync from macOS Contacts
 * - Upserts all contacts from macOS
 * - Deletes macOS contacts that no longer exist in macOS (only source='macos')
 * - Updates last_message_at from phone_last_message lookup
 *
 * CRITICAL (BACKLOG-2385): Does NOT touch outlook/google_contacts/iphone/
 * android_sync contacts — only manages the 'macos' source, matching
 * syncOutlookContacts / syncGoogleContacts.
 */
export function fullSync(userId: string, macOSContacts: MacOSContact[]): SyncResult {
  const syncStartTime = new Date().toISOString();

  // Step 0 (BACKLOG-2391): classify BEFORE writing. `ON CONFLICT DO UPDATE`
  // cannot tell an insert from an update after the fact, which is why this
  // function used to report `inserted: <total upserted>, updated: 0` and a user
  // log showed "Upserted 716 external contacts" every single sync — a number
  // that says nothing about whether anything actually changed.
  const { inserted, updated, unchanged } = classifyMacOSSync(userId, macOSContacts);

  // Step 1: Upsert all contacts (this sets synced_at to current time)
  upsertFromMacOS(userId, macOSContacts);

  // Step 2: Delete stale macOS contacts only (synced_at < syncStartTime, source='macos')
  const deleteCount = deleteStaleContactsBySource(userId, 'macos', syncStartTime);

  // Step 3: Update last_message_at from phone_last_message lookup table
  updateLastMessageAtFromLookupTable(userId);

  const result: SyncResult = {
    inserted,
    updated,
    unchanged,
    deleted: deleteCount,
    total: getCount(userId),
  };

  // BACKLOG-2391: funnel stage 3, at info, with no PII.
  recordShadowSync({
    source: 'macos',
    inserted,
    updated,
    unchanged,
    deleted: deleteCount,
    total: result.total,
  });

  return result;
}

/**
 * The columns `upsertFromMacOS` rewrites on conflict, minus `synced_at` (pure
 * bookkeeping — it changes on every sync and would make "unchanged" impossible).
 */
interface MacOSContentSnapshot {
  name: string | null;
  phones_json: string | null;
  phones_normalized_json: string | null;
  emails_json: string | null;
  company: string | null;
}

/** Exactly what the upsert is about to bind, so the comparison is like-for-like. */
function macOSContentOf(contact: MacOSContact): MacOSContentSnapshot {
  return {
    name: contact.name || null,
    phones_json: JSON.stringify(contact.phones || []),
    phones_normalized_json: normalizedPhonesJson(contact.phones),
    emails_json: JSON.stringify(contact.emails || []),
    company: contact.company || null,
  };
}

function sameMacOSContent(a: MacOSContentSnapshot, b: MacOSContentSnapshot): boolean {
  return (
    a.name === b.name &&
    a.phones_json === b.phones_json &&
    a.phones_normalized_json === b.phones_normalized_json &&
    a.emails_json === b.emails_json &&
    a.company === b.company
  );
}

/**
 * BACKLOG-2391: split an incoming macOS payload into genuinely new records,
 * genuinely changed records, and records that are already stored verbatim.
 *
 * Pre-fetches the existing `external_record_id` -> content map for this user's
 * `source='macos'` rows, then walks the payload. The working map is UPDATED as
 * it goes, so a record id repeated inside one payload counts once as an insert
 * and is thereafter compared against what the earlier occurrence will write —
 * rather than being counted as two inserts of the same row.
 *
 * Must be called BEFORE `upsertFromMacOS`, or every record looks unchanged.
 */
export function classifyMacOSSync(
  userId: string,
  contacts: MacOSContact[]
): { inserted: number; updated: number; unchanged: number } {
  const rows = dbAll<MacOSContentSnapshot & { external_record_id: string }>(
    `SELECT external_record_id, name, phones_json, phones_normalized_json, emails_json, company
     FROM external_contacts
     WHERE user_id = ? AND source = 'macos'`,
    [userId]
  );

  const existing = new Map<string, MacOSContentSnapshot>();
  for (const row of rows) {
    existing.set(String(row.external_record_id), {
      name: row.name,
      phones_json: row.phones_json,
      phones_normalized_json: row.phones_normalized_json,
      emails_json: row.emails_json,
      company: row.company,
    });
  }

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  for (const contact of contacts) {
    const key = String(contact.recordId);
    const next = macOSContentOf(contact);
    const prev = existing.get(key);

    if (!prev) {
      inserted++;
    } else if (sameMacOSContent(prev, next)) {
      unchanged++;
    } else {
      updated++;
    }

    existing.set(key, next);
  }

  return { inserted, updated, unchanged };
}

// ============================================
// SEARCH OPERATIONS
// ============================================

/**
 * Look up contact names by normalized phone digits from external_contacts.
 * Uses json_each to expand phones_json arrays for matching.
 */
export function getNamesByPhoneDigits(
  userId: string,
  normalizedPhones: string[]
): { phone: string; name: string; contact_id: string }[] {
  if (normalizedPhones.length === 0) return [];
  const db = ensureDb();
  const placeholders = normalizedPhones.map(() => "?").join(", ");
  // BACKLOG-2757: `ec.id` and a declared ORDER BY. The caller has to distinguish
  // "one external contact, two stored formats of one number" from "two external
  // contacts sharing a line", and it must reach the same answer whichever order
  // the rows were inserted in.
  const sql = `
    SELECT je.value as phone, ec.name, ec.id as contact_id
    FROM external_contacts ec, json_each(ec.phones_json) je
    WHERE ec.user_id = ?
      AND ec.name IS NOT NULL
      AND substr(replace(replace(replace(je.value, '+', ''), '-', ''), ' ', ''), -10) IN (${placeholders})
    ORDER BY ec.name COLLATE NOCASE, ec.id
  `;
  return db.prepare(sql).all(userId, ...normalizedPhones) as {
    phone: string;
    name: string;
    contact_id: string;
  }[];
}

/**
 * Look up contact names by email from external_contacts.
 * Uses json_each to expand emails_json arrays for matching.
 */
export function getNamesByEmails(
  userId: string,
  lowerEmails: string[]
): { email: string; name: string; contact_id: string }[] {
  if (lowerEmails.length === 0) return [];
  const db = ensureDb();
  const placeholders = lowerEmails.map(() => "?").join(", ");
  // BACKLOG-2757: see getNamesByPhoneDigits — identity and a declared order.
  const sql = `
    SELECT je.value as email, ec.name, ec.id as contact_id
    FROM external_contacts ec, json_each(ec.emails_json) je
    WHERE ec.user_id = ?
      AND ec.name IS NOT NULL
      AND LOWER(je.value) IN (${placeholders})
    ORDER BY ec.name COLLATE NOCASE, ec.id
  `;
  return db.prepare(sql).all(userId, ...lowerEmails) as {
    email: string;
    name: string;
    contact_id: string;
  }[];
}

/**
 * Search external contacts by name, phone, or email
 * Useful for contact selection when user types a query
 */
export function search(userId: string, query: string, limit: number = 50): ExternalContact[] {
  const searchPattern = `%${query}%`;

  // BACKLOG-2355: recency computed inline (phone + email) via the shared
  // expression, wrapped in a subquery so the ORDER BY resolves to the computed
  // result column (see EXTERNAL_CONTACTS_GET_ALL_SQL for the alias-safety note).
  const sql = `
    SELECT * FROM (
      SELECT id, user_id, name, phones_json, emails_json, company,
             ${EXTERNAL_CONTACT_LAST_MESSAGE_EXPR} as last_message_at,
             external_record_id, source, synced_at
      FROM external_contacts
      WHERE user_id = ?
        AND (
          name LIKE ?
          OR phones_json LIKE ?
          OR emails_json LIKE ?
          OR company LIKE ?
        )
    )
    ORDER BY last_message_at IS NULL, last_message_at DESC, name ASC
    LIMIT ?
  `;

  const rows = dbAll<ExternalContactRow>(sql, [
    userId,
    searchPattern,
    searchPattern,
    searchPattern,
    searchPattern,
    limit,
  ]);

  // BACKLOG-2457: same mapper, same collapse — a search result renders the same
  // card as a picker row and must not disagree with it about how many addresses
  // the record has.
  return rows.map(toExternalContact);
}
