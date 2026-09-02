// ============================================
// EMAIL SYNC SERVICE
// Extracted from emailSyncHandlers.ts (TASK-2066)
//
// Encapsulates the full email sync orchestration:
// - Provider fetch (Outlook inbox/sent/all-folders + Gmail search/all-labels)
// - Store & dedup logic
// - Auto-link loop for each contact
// - Attachment backfill
// - Network resilience wrapping
// ============================================

import * as Sentry from "@sentry/electron/main";
import logService from "./logService";
import { autoLinkCommunicationsForContact } from "./autoLinkService";
import type { AutoLinkResult } from "./autoLinkService";
// BACKLOG-2393: scoped support-access tracing. A no-op unless a user has
// granted a support window covering the email-sync scope.
import { supportTrace } from "./supportAccess/trace";
import { countEmailsByUser, getEmailByExternalId } from "./db/emailDbService";
// BACKLOG-3056: the two ends of the locally cached window, read together. See
// the gap comment in `precacheEmails`.
import { getCachedEmailSentAtBounds } from "./db/emailCacheWindow";
import type { BulkMailHeaders } from "../utils/bulkMailHeaders";
import { CURRENT_DERIVATION_VERSION } from "../utils/derivationVersion";
import { reprocessEmailDerivations } from "./emailDerivationReprocessService";
import {
  EMAIL_PRECACHE_PERCENT,
  terminalProgress,
  type EmailPrecacheProgressCallback,
} from "./emailPrecacheProgress";
import { dbGet, dbAll, dbRun, getRawDatabase } from "./db/core/dbConnection";
import gmailFetchService from "./gmailFetchService";
import outlookFetchService from "./outlookFetchService";
import databaseService from "./databaseService";
import failureLogService from "./failureLogService";
import { isNetworkError } from "../utils/networkErrors";
import { retryOnNetwork, networkResilienceService } from "./networkResilience";
import { computeTransactionDateRange } from "../utils/emailDateRange";
import { getEmailCacheDurationMonths, computeEmailCacheSinceDate } from "../utils/preferenceHelper";
import {
  getContactEmailsForTransaction,
  resolveContactEmailsByQuery,
} from "./db/contactDbService";
import { getEmailsByContactId } from "./db/contactDbService";
import { searchLocalEmailCache } from "./db/messageDbService";
import type { TransactionResponse } from "../types/handlerTypes";
import type { TransactionContactResult } from "./db/transactionContactDbService";
import { computeParticipantHash, parseEmailAddressList } from "../utils/emailAddress";
import type { TransactionWithDetails } from "./transactionService/types";
// BACKLOG-1769: pure resurrection/dedup planner (Message-ID stable identity).
// BACKLOG-1861: also import legacy-content key helper for the forward guard.
import { planEmailWrites, computeLegacyContentKey, type ExistingByMessageId } from "./emailWritePlanner";
// BACKLOG-2856: force re-cache (stage-and-swap). See emailForceStaging.ts for why
// the rebuild never touches the live table until one final transaction.
import {
  buildEmailForceSet,
  emailForceReadView,
  emailForceStagingLifecycle,
  restrictForceSetToRebuiltProviders,
  sweepStaleEmailStaging,
  swapEmailStagingIntoLive,
  type EmailForceProvider,
  type EmailForceStaging,
} from "./emailForceStaging";

// TASK-2060: Safety cap for email fetching with date-range filtering.
// With date filtering, we no longer need the old 200 cap. This higher cap
// serves as a safety valve to prevent runaway fetches for extremely high-volume contacts.
export const EMAIL_FETCH_SAFETY_CAP = 2000;

/**
 * How long the email cache is considered fresh after a sync/precache completes.
 * BACKLOG-1802: also the per-transaction auto-sync throttle window — an auto
 * trigger (open/create/scan) will not refetch the same transaction within this
 * window ("don't refetch within minutes", founder policy). Exported so the
 * transactionSyncTrigger reuses the exact same threshold.
 */
export const EMAIL_CACHE_FRESHNESS_MS = 10 * 60 * 1000; // 10 minutes

// ============================================
// TASK-2070: Provider error classification
// ============================================

/**
 * Determines if an error is caused by an expired or revoked OAuth token.
 * These errors require the user to re-authenticate (reconnect) in Settings.
 *
 * Matches patterns from Outlook (AADSTS50173, 401, "token expired") and
 * Gmail ("invalid_grant", "Token has been expired or revoked").
 */
export function isTokenExpiryError(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : (error as { message?: string })?.message ?? "";
  const lowerMessage = message.toLowerCase();

  // Check for HTTP 401 status (common for expired tokens)
  const status = (error as { response?: { status?: number } })?.response?.status
    ?? (error as { status?: number })?.status;
  if (status === 401) return true;

  // Outlook-specific: AADSTS error codes for expired/revoked tokens
  if (/aadsts\d+/i.test(message)) return true;

  // Common token expiry patterns
  const tokenPatterns = [
    "token expired",
    "token has been expired",
    "token has been revoked",
    "invalid_grant",
    "access token expired",
    "refresh failed",
    "please reconnect",
    "invalidauthenticationtoken",
    "compacttoken",
  ];

  return tokenPatterns.some((pattern) => lowerMessage.includes(pattern));
}

/**
 * Returns a user-facing warning message based on the type of provider error.
 * Token expiry errors get a reconnect message; other errors get a generic message.
 */
export function classifyProviderError(error: unknown): string {
  if (isTokenExpiryError(error)) {
    return "Your email connection has expired. Please reconnect in Settings.";
  }
  return "Could not reach your email provider. Showing cached results only.";
}

// ============================================
// TASK-2273: Email sync failure classification for Sentry
// ============================================

/**
 * Classifies email sync errors into structured categories for Sentry reporting.
 * Used to tag Sentry events with actionable failure reasons.
 */
export type EmailSyncFailureReason =
  | "token_expired"
  | "rate_limited"
  | "network_error"
  | "storage_error"
  | "api_error"
  | "unknown";

/**
 * Classifies an email sync error into a structured failure reason.
 * Uses existing isTokenExpiryError() and isNetworkError() helpers,
 * then falls back to HTTP status and error message pattern matching.
 */
export function classifyEmailSyncError(error: unknown): EmailSyncFailureReason {
  if (isTokenExpiryError(error)) return "token_expired";
  if (isNetworkError(error)) return "network_error";

  const status = (error as { response?: { status?: number } })?.response?.status;
  if (status === 429) return "rate_limited";
  if (status && status >= 400) return "api_error";

  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("disk") || message.includes("space") || message.includes("enospc")) return "storage_error";

  return "unknown";
}

// TASK-2060: Safety cap for sent items (per-contact email search)
export const SENT_ITEMS_SAFETY_CAP = 200;

// ============================================
// TASK-2067: Types for new service methods
// ============================================

/**
 * Search parameters passed from the get-unlinked-emails handler.
 */
export interface EmailSearchParams {
  query: string;
  after: Date | null;
  before: Date | null;
  maxResults: number;
  skip?: number;
  contactEmails?: string[];
}

/**
 * A single email result returned to the renderer (matches existing IPC shape).
 */
export interface ProviderEmailResult {
  id: string;
  subject: string | null;
  sender: string | null;
  sent_at: string | null;
  body_preview?: string | null;
  thread_id?: string | null;
  has_attachments?: boolean;
  provider: "gmail" | "outlook";
}

/**
 * Result of searching provider emails and storing them locally.
 */
export interface SearchProviderEmailsResult {
  emails: ProviderEmailResult[];
  noProviderConnected: boolean;
  /** TASK-2070: Warning message when provider fetch failed (token expiry, API error) */
  warning?: string;
}

/**
 * Result of fetching from provider + auto-linking for a contact.
 */
export interface FetchAndAutoLinkResult {
  emailsFetched: number;
  emailsStored: number;
  autoLinkResult: AutoLinkResult;
}

/**
 * TASK-2060: Shared helper for fetching emails from a provider, storing them locally,
 * and deduplicating by external ID.
 *
 * This replaces the duplicated fetch-store-dedup pattern that was repeated for each
 * provider path (Outlook inbox, sent, all-folders, Gmail search, all-labels).
 *
 * Preserves:
 * - Individual email save pattern (TASK-2049: each email saved independently)
 * - Network error propagation (for retryOnNetwork wrapper)
 * - Attachment download with non-blocking error handling
 *
 * @returns Object with counts of fetched, stored, and errored emails
 */
/**
 * BACKLOG-1831: the minimal parsed-email shape the store/dedup path needs. Named
 * (extracted from fetchStoreAndDedup's inline fetchFn type) so the exported
 * storeParsedEmailsForAccount wrapper and other callers can reference it without
 * duplicating the shape. Both fetch services' ParsedEmail is structurally
 * assignable to this.
 */
export interface StoreableEmail {
  id: string;
  threadId: string;
  from?: string | null;
  to?: string | null;
  cc?: string | null;
  // BACKLOG-1722: real header value (previously dropped at INSERT time)
  bcc?: string | null;
  // BACKLOG-1769: RFC 5322 Message-ID — the stable identity that survives a
  // re-delivery under a new provider id (ghost resurrection). Both fetch
  // services already populate it on their ParsedEmail; it was dropped here.
  messageIdHeader?: string | null;
  subject?: string | null;
  body: string;
  bodyPlain: string;
  date: Date;
  hasAttachments: boolean;
  attachmentCount: number;
  attachments?: Array<{
    filename?: string;
    name?: string;
    mimeType?: string;
    contentType?: string;
    size?: number;
    attachmentId?: string;
    id?: string;
  }>;
  // BACKLOG-1722: structured participants for the junction
  participants?: import("../types/models").ParsedParticipant[];
  // BACKLOG-1802: fetch provenance for the emails.ingest_source column.
  // 'filter' (transactionally-consistent $filter / folder sweep / Gmail query)
  // or 'search_validated' (KQL $search, existence-confirmed by the fetcher).
  // Absent ⇒ treated as 'filter'. 'manual' is set by the caller path, not here.
  ingestSource?: "filter" | "search_validated";
  // BACKLOG-2512: five per-message facts that both fetch services had (or can
  // cheaply obtain) but that this interface did not declare — so they were
  // structurally invisible to the writer and hard-coded to NULL at the INSERT.
  // They cannot be reconstructed from anything the app retains; recovering them
  // means re-reading every mailbox, so they are captured at ingest.
  //
  // These stay optional to avoid breaking existing callers; the guard against a
  // future provider silently omitting one is the `_wireCheck` assignability
  // assertion in gmailFetchService.test.ts / outlookFetchService.test.ts.
  /** RFC 5322 In-Reply-To — Message-ID of the parent; the only reply-edge source. */
  inReplyTo?: string | null;
  /** RFC 5322 References — the full ancestor chain. */
  references?: string | null;
  /** When the recipient's server accepted the message. */
  receivedAt?: Date | null;
  /**
   * BACKLOG-2571: the sender-asserted send time, and the source of `sent_at`.
   *
   * Kept SEPARATE from `date` above, which stays the receive time. `date` has
   * four readers in this file and two of them compare it against legacy rows'
   * `sent_at` (receive times) on a ±2 second tolerance; repointing `date` would
   * make that comparison cross semantics and silently stop matching.
   *
   * Optional because a provider that cannot supply it should degrade to the old
   * behaviour rather than write NULL into `sent_at` — see the bind site.
   */
  sentDate?: Date | null;
  /**
   * SHA-256 content hash. BACKLOG-2572: NOT cross-provider comparable — Gmail
   * hashes over internalDate, Outlook over sentDateTime.
   */
  contentHash?: string | null;
  /** Gmail labels / Outlook categories; JSON-encoded into `emails.labels`. */
  labels?: string[];
  /**
   * BACKLOG-2513: retained bulk-mail headers (List-Unsubscribe, Precedence,
   * Auto-Submitted, Authentication-Results), JSON-encoded into
   * `emails.bulk_mail_headers`. These are the negative-filter input for the
   * auto-detection design (BACKLOG-2500 §4.2). Raw facts only — nothing is
   * classified at ingest.
   */
  bulkMailHeaders?: BulkMailHeaders | null;
}

/**
 * BACKLOG-2512: convert a possibly-absent, possibly-unparseable date into an ISO
 * string, or null.
 *
 * `new Date("garbage").toISOString()` throws `RangeError: Invalid time value`.
 * Inside the per-email `try` in the batch insert loop, that RangeError is caught
 * by `catch (emailError) { errors++ }` — which would discard the ENTIRE email
 * over one bad timestamp while the sync still reports success. A provider that
 * returns a malformed `receivedDateTime` would silently cost the user messages.
 *
 * Returning null instead keeps the email and loses only the one field.
 */
function toIsoStringOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** BACKLOG-1870: normalized attachment metadata (no file bytes). */
interface AttachmentMetaLite {
  filename: string;
  mimeType: string | null;
  size: number | null;
}

/**
 * BACKLOG-1870: normalize the loosely-typed attachment shapes (Gmail ParsedEmail
 * attachments carry `filename`/`mimeType`/`size`; Outlook Graph metadata carries
 * `name`/`contentType`/`size`) into one `{ filename, mimeType, size }` shape.
 * Entries without a usable filename are dropped because `attachments.filename` is
 * NOT NULL.
 */
function normalizeAttachmentMeta(
  raw: ReadonlyArray<{
    filename?: string | null;
    name?: string | null;
    mimeType?: string | null;
    contentType?: string | null;
    size?: number | null;
  }>,
): AttachmentMetaLite[] {
  const out: AttachmentMetaLite[] = [];
  for (const a of raw) {
    const filename = (a.filename ?? a.name ?? "").trim();
    if (!filename) continue;
    out.push({
      filename,
      mimeType: a.mimeType ?? a.contentType ?? null,
      size: typeof a.size === "number" ? a.size : null,
    });
  }
  return out;
}

/**
 * BACKLOG-1870: persist attachment METADATA for the emails inserted in this batch
 * so their filenames are searchable after a normal sync. Never downloads file
 * bytes — `storage_path`/`text_content` stay NULL until an on-demand
 * preview/export reconciles the same row.
 *
 * Source of metadata, in order:
 *   1. `email.attachments` already parsed from the provider response (Gmail parses
 *      filenames from the message payload — no extra API call, no bytes).
 *   2. `getAttachmentsFn(externalId)` — a metadata-only ($select, no contentBytes)
 *      lookup for providers whose list response omits filenames (Outlook). Gated on
 *      `hasAttachments` and only invoked for NEWLY inserted emails, so re-syncs of
 *      already-stored emails issue no extra calls.
 *
 * Idempotent (upsert by email_id+filename) and non-blocking: a per-email failure is
 * logged and skipped, never failing the sync.
 */
async function persistEmailAttachmentMetadata(args: {
  emailsToInsert: StoreableEmail[];
  insertedEmailMap: Map<string, string>;
  getAttachmentsFn?: (
    messageId: string,
  ) => Promise<
    Array<{ id: string; name: string; contentType: string; size: number }>
  >;
  /**
   * BACKLOG-2856: during a force re-cache the `emailId` below belongs to a row
   * that exists only in staging, so writing an `attachments` row for it now
   * would fail the `REFERENCES emails(id)` foreign key. Buffer instead; the swap
   * applies these after the emails land in live.
   */
  force?: EmailForceStaging;
}): Promise<void> {
  const { emailsToInsert, insertedEmailMap, getAttachmentsFn, force } = args;

  for (const email of emailsToInsert) {
    const internalId = insertedEmailMap.get(email.id);
    if (!internalId) continue; // insert failed for this row — nothing to attach to

    try {
      let meta: AttachmentMetaLite[] = email.attachments
        ? normalizeAttachmentMeta(email.attachments)
        : [];

      // Provider list response carried no attachment filenames (Outlook): fetch
      // metadata only. contentBytes are never requested (see getAttachments $select).
      if (meta.length === 0 && email.hasAttachments && getAttachmentsFn) {
        const fetched = await getAttachmentsFn(email.id);
        meta = normalizeAttachmentMeta(fetched);
      }

      for (const m of meta) {
        const row = {
          emailId: internalId,
          externalEmailId: email.id,
          filename: m.filename,
          mimeType: m.mimeType,
          fileSizeBytes: m.size,
        };
        if (force) {
          force.attachmentMeta.push(row);
        } else {
          databaseService.upsertEmailAttachmentMetadata(row);
        }
      }
    } catch (err) {
      logService.warn(
        "BACKLOG-1870: failed to persist attachment metadata during sync",
        "Transactions",
        {
          error: err instanceof Error ? err.message : "Unknown",
          emailExternalId: email.id,
        },
      );
    }
  }
}

async function fetchStoreAndDedup(params: {
  provider: "outlook" | "gmail";
  fetchFn: () => Promise<StoreableEmail[]>;
  userId: string;
  seenIds: Set<string>;
  /**
   * BACKLOG-1802: source flag override for the whole batch. When set to 'manual'
   * (user clicked "Sync Emails"), every row is tagged ingest_source='manual'
   * regardless of the per-email fetch provenance. Otherwise each row uses its own
   * `ingestSource` (default 'filter').
   */
  ingestSourceOverride?: "manual";
  /** For Outlook: function to get Graph API attachments by message ID */
  getAttachmentsFn?: (messageId: string) => Promise<Array<{ id: string; name: string; contentType: string; size: number }>>;
  /**
   * BACKLOG-2856: present only during a force re-cache. When set, this batch is
   * written into the run's STAGING tables and the live `emails` table is neither
   * written nor read on its own — every dedup read becomes "survivors of the
   * pending swap ∪ what this run has staged so far" (`emailForceReadView`).
   *
   * Absent, every line below behaves exactly as it did before, which is the
   * property that keeps ordinary delta syncs out of this feature's blast radius.
   */
  force?: EmailForceStaging;
  // BACKLOG-1831: cache HITS for this batch = writePlan.duplicates (exact dupes,
  // already cached) + writePlan.resurrections.length (re-deliveries remapped in
  // place, i.e. the message was already cached under a different provider id).
  // `stored` is the cache MISSES. Surfacing these turns the already-computed
  // dedup signal into the experiment's success metric.
}): Promise<{ fetched: number; stored: number; errors: number; duplicates: number }> {
  const { provider, fetchFn, userId, seenIds, ingestSourceOverride, getAttachmentsFn, force } = params;
  let fetched = 0;
  let stored = 0;
  let errors = 0;

  // BACKLOG-2856: the three "what do we already have" reads below decide what
  // gets written. Under a force re-cache they must NOT read live `emails` alone:
  // live still holds the entire force set (that is the point of staging), so
  // every re-fetched row would match, be classified an already-cached duplicate,
  // and never be staged — staging would finish empty and the swap would delete
  // the user's corpus and put nothing back. `emailForceReadView` substitutes
  // "rows the swap will keep ∪ rows staged so far" for the table name.
  const emailsSource = (columns: string): { sql: string; params: readonly string[] } =>
    force
      ? emailForceReadView(force, columns)
      : { sql: "emails", params: [] };
  const writeEmailsTable = force ? `"${force.emailsTable}"` : "emails";
  const writeParticipantsTable = force ? `"${force.participantsTable}"` : "email_participants";

  // BACKLOG-1549: Look up the user's connected email address to compute direction
  const oauthProvider = provider === "outlook" ? "microsoft" : "google";
  const oauthToken = await databaseService.getOAuthToken(userId, oauthProvider as "microsoft" | "google", "mailbox");
  const userEmail = oauthToken?.connected_email_address?.toLowerCase() ?? null;

  // BACKLOG-1802: resolve the per-account identity (oauth_tokens.id) once for the
  // whole batch and stamp it on every INSERT. Until now account_id was hardcoded
  // NULL, which SILENTLY DISABLED T1's per-account UNIQUE dedup indexes
  // (idx_emails_account_external / idx_emails_account_message_id_header are partial
  // on account_id, and SQLite treats NULL as distinct). Populating account_id is
  // what makes those indexes actually enforce. NULL only when no mailbox row is
  // resolvable (matches the migration's account_id backfill fallback).
  const accountId: string | null = oauthToken?.id ?? null;

  const emails = await fetchFn();

  // Dedup against previously seen IDs
  const newEmails = emails.filter((e) => {
    if (seenIds.has(e.id)) return false;
    seenIds.add(e.id);
    return true;
  });

  fetched = newEmails.length;

  // BACKLOG-1115: Batch dedup check -- find which external_ids already exist in one query
  // instead of N individual SELECT queries. This is the highest-impact perf optimization.
  const existingExternalIds = new Set<string>();
  if (newEmails.length > 0) {
    // Process in chunks of 500 to avoid SQLite variable limit
    const CHUNK_SIZE = 500;
    for (let i = 0; i < newEmails.length; i += CHUNK_SIZE) {
      const chunk = newEmails.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => "?").join(",");
      const src = emailsSource("external_id, user_id");
      const rows = dbAll<{ external_id: string }>(
        `SELECT external_id FROM ${src.sql} WHERE user_id = ? AND external_id IN (${placeholders})`,
        [...src.params, userId, ...chunk.map((e) => e.id)],
      );
      for (const row of rows) {
        existingExternalIds.add(row.external_id);
      }
    }
  }

  // BACKLOG-1769: Also load already-stored rows by RFC Message-ID so a re-delivered
  // message (new provider id, same Message-ID) is caught as a resurrection instead
  // of being inserted as a ghost row. Chunked identically to the external_id lookup.
  const existingByMessageId = new Map<string, ExistingByMessageId>();
  const headersToCheck = newEmails
    .map((e) => e.messageIdHeader)
    .filter((h): h is string => !!h);
  if (headersToCheck.length > 0) {
    const CHUNK_SIZE = 500;
    for (let i = 0; i < headersToCheck.length; i += CHUNK_SIZE) {
      const chunk = headersToCheck.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => "?").join(",");
      const src = emailsSource("id, external_id, message_id_header, user_id");
      const rows = dbAll<{ id: string; external_id: string | null; message_id_header: string }>(
        `SELECT id, external_id, message_id_header FROM ${src.sql} WHERE user_id = ? AND message_id_header IN (${placeholders})`,
        [...src.params, userId, ...chunk],
      );
      for (const row of rows) {
        existingByMessageId.set(row.message_id_header, { id: row.id, externalId: row.external_id });
      }
    }
  }

  // BACKLOG-1861: Last-resort legacy-row lookup for 2.19-era rows with
  // NULL message_id_header. For each incoming email with a messageIdHeader
  // not yet caught by external_id dedup, query the DB for legacy rows sharing
  // the same subject. JS then cross-checks sender + sent_at (±2s) and builds
  // an unambiguous content-key → ExistingByMessageId map for planEmailWrites.
  const byLegacyContent = new Map<string, ExistingByMessageId>();
  const legacyCandidates = newEmails.filter(
    (e) => (e.messageIdHeader ?? null) !== null && !existingExternalIds.has(e.id),
  );
  if (legacyCandidates.length > 0) {
    const subjectsToCheck = [
      ...new Set(
        legacyCandidates
          .map((e) => e.subject?.trim().toLowerCase())
          .filter((s): s is string => !!s),
      ),
    ];
    if (subjectsToCheck.length > 0) {
      const LEGACY_CHUNK = 500;
      for (let i = 0; i < subjectsToCheck.length; i += LEGACY_CHUNK) {
        const chunk = subjectsToCheck.slice(i, i + LEGACY_CHUNK);
        const placeholders = chunk.map(() => "?").join(",");
        const legacySrc = emailsSource(
          "id, external_id, subject, sender, sent_at, user_id, message_id_header",
        );
        const legacyRows = dbAll<{
          id: string;
          external_id: string | null;
          subject: string;
          sender: string;
          sent_at: string;
        }>(
          `SELECT id, external_id, subject, sender, sent_at
           FROM ${legacySrc.sql}
           WHERE user_id = ?
             AND message_id_header IS NULL
             AND sent_at IS NOT NULL
             AND sender IS NOT NULL
             AND subject IS NOT NULL
             AND LOWER(TRIM(subject)) IN (${placeholders})`,
          [...legacySrc.params, userId, ...chunk],
        );
        // Build key → row map and frequency count for ambiguity detection.
        const keyCount = new Map<string, number>();
        const keyToRow = new Map<string, { id: string; external_id: string | null }>();
        for (const row of legacyRows) {
          const key = computeLegacyContentKey(row.subject, row.sender, row.sent_at);
          if (key) {
            keyCount.set(key, (keyCount.get(key) ?? 0) + 1);
            keyToRow.set(key, { id: row.id, external_id: row.external_id });
          }
        }
        // Cross-check each candidate against its matched legacy row for sender
        // exactness and sent_at within ±2 seconds before committing the map entry.
        for (const candidate of legacyCandidates) {
          const candidateKey = computeLegacyContentKey(
            candidate.subject,
            candidate.from,
            candidate.date,
          );
          if (!candidateKey) continue;
          if ((keyCount.get(candidateKey) ?? 0) !== 1) continue; // ambiguous
          const rowRef = keyToRow.get(candidateKey);
          if (!rowRef) continue;
          const legRow = legacyRows.find((r) => r.id === rowRef.id);
          if (!legRow) continue;
          const candSender = (candidate.from ?? "").trim().toLowerCase();
          const legSender = legRow.sender.trim().toLowerCase();
          if (candSender !== legSender) continue;
          const legDt = new Date(legRow.sent_at);
          const candDt =
            candidate.date instanceof Date ? candidate.date : new Date(String(candidate.date));
          if (Math.abs(legDt.getTime() - candDt.getTime()) / 1000 > 2) continue;
          byLegacyContent.set(candidateKey, { id: legRow.id, externalId: legRow.external_id });
        }
      }
    }
  }

  // BACKLOG-1769: Split the batch into brand-new inserts, ghost-resurrection remaps
  // (external_id changed for an already-stored Message-ID), and duplicates.
  const writePlan = planEmailWrites(newEmails, {
    externalIds: existingExternalIds,
    byMessageId: existingByMessageId,
    byLegacyContent,
  });
  const emailsToInsert = writePlan.toInsert;

  // BACKLOG-1115: Batch INSERT within a single SQLite transaction for throughput.
  // Prepared statement is reused across all inserts.
  // BACKLOG-1769: also enter the transaction when there are only resurrection
  // remaps (re-deliveries) and nothing brand-new to insert.
  if (emailsToInsert.length > 0 || writePlan.resurrections.length > 0) {
    try {
      const db = getRawDatabase();
      const crypto = await import("crypto");
      const insertStmt = db.prepare(`
        INSERT INTO ${writeEmailsTable} (
          id, user_id, external_id, source, account_id, direction,
          subject, body_plain, body_html,
          sender, recipients, cc, bcc,
          thread_id, in_reply_to, references_header,
          sent_at, received_at,
          has_attachments, attachment_count,
          message_id_header, content_hash, labels,
          bulk_mail_headers,
          ingest_source, validated_at,
          -- BACKLOG-2857: stamped at write time so a later derivation fix can
          -- tell this row apart from one produced by superseded logic.
          -- APPENDED after every other bound parameter on purpose:
          -- emailSyncService.retainedHeaders.test.ts transcribes positional
          -- indices into this list, so inserting mid-list would silently
          -- re-point its assertions at the wrong columns.
          derived_version,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `);

      // BACKLOG-1722: Junction participant INSERT, prepared once and reused.
      const insertParticipantStmt = db.prepare(`
        INSERT INTO ${writeParticipantsTable}
          (email_id, role, position, participant_hash, email_address, display_name)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      // BACKLOG-1769: resurrection remap — point an already-stored row at the new
      // provider id when the same Message-ID was re-delivered under a fresh id.
      // BACKLOG-1861: also COALESCE-update message_id_header so that legacy rows
      // (NULL → now set) use the fast step-2 path on future fetches rather than
      // requiring the forward guard again. COALESCE is a no-op for rows that
      // already have a message_id_header (standard BACKLOG-1769 resurrections).
      const updateExternalIdStmt = db.prepare(
        `UPDATE emails SET external_id = ?, message_id_header = COALESCE(message_id_header, ?) WHERE id = ?`,
      );

      // Map of external_id -> generated internal id for attachment processing
      const insertedEmailMap = new Map<string, string>();

      const runTransaction = db.transaction(() => {
        // BACKLOG-1769: apply resurrection remaps first (in-place external_id update,
        // no new row) — these are re-deliveries of messages already in the cache.
        //
        // BACKLOG-2856: under a force re-cache these are BUFFERED, not applied.
        // They are UPDATEs against the LIVE table, and the whole safety argument
        // is that live is untouched until the swap. A force-set row can no longer
        // reach here at all — the read view hides it, so a re-fetched copy comes
        // back as a plain staged insert — which means every remaining
        // resurrection targets a SURVIVOR. Applied as the swap's last step, they
        // become visible at exactly the same moment they would have before.
        for (const r of writePlan.resurrections) {
          if (force) {
            force.resurrectionRepairs.push({
              existingId: r.existingId,
              newExternalId: r.newExternalId,
              messageIdHeader: r.messageIdHeader ?? null,
            });
          } else {
            updateExternalIdStmt.run(r.newExternalId, r.messageIdHeader, r.existingId);
          }
        }

        for (const email of emailsToInsert) {
          try {
            const id = crypto.randomUUID();

            // BACKLOG-1549: Compute email direction from sender vs user's email
            let direction: "inbound" | "outbound" | null = null;
            if (userEmail && email.from) {
              // M2 (BACKLOG-1722): use the RFC 5322 parser instead of a naive
              // regex so quoted display names, encoded-words, and routing
              // addresses are handled consistently with all other consumers.
              const parsedFrom = parseEmailAddressList(email.from);
              const fromAddress =
                parsedFrom.addresses[0]?.email_address ?? email.from.toLowerCase().trim();
              direction = fromAddress === userEmail ? "outbound" : "inbound";
            }

            // BACKLOG-1802: per-row ingest provenance. A batch-level 'manual'
            // override (user clicked Sync) wins; otherwise the fetcher's tag
            // (default 'filter'). $search-sourced rows carry validated_at so the
            // "search rows must be existence-validated" invariant is auditable.
            const rowIngestSource: "legacy" | "filter" | "search_validated" | "manual" =
              ingestSourceOverride ?? email.ingestSource ?? "filter";
            const validatedAt =
              rowIngestSource === "search_validated" ? new Date().toISOString() : null;

            insertStmt.run(
              id,
              userId,
              email.id,
              provider,
              accountId, // BACKLOG-1802: resolved oauth_tokens.id (was hardcoded null)
              direction, // BACKLOG-1549: computed from sender vs user email
              email.subject ?? null,
              email.bodyPlain ?? null,
              email.body ?? null,
              email.from ?? null,
              email.to ?? null,
              email.cc ?? null,
              // BACKLOG-1722 / BACKLOG-1550: ParsedEmail carries the real bcc
              // header value. The previous literal `null` here silently
              // discarded BCC headers, making BCC-only matches invisible to
              // search and auto-link.
              email.bcc ?? null,
              email.threadId ?? null,
              // BACKLOG-2512: the reply edge. Previously literal `null`, which
              // made a thread graph unreconstructable from stored data — and
              // reply rate is the strongest signal separating a human
              // correspondent from an automated sender (BACKLOG-2500 §5).
              email.inReplyTo ?? null,
              email.references ?? null,
              /**
               * BACKLOG-2571 — `sent_at` is the SEND time as of this task.
               *
               * It used to be bound from `email.date`, which holds the RECEIVE
               * time for both providers (Gmail `internalDate`, Outlook
               * `receivedDateTime`) — so every date-range query, the
               * `idx_emails_sent_at` index and the UI sort ran on receive time
               * while calling it send time.
               *
               * `sentDate` is a SEPARATE field rather than a repointed `date`
               * on purpose: `email.date` is also read by the legacy-row matcher
               * further up this file, which compares it against legacy rows'
               * `sent_at` (receive times) on a ±2 second tolerance. Repointing
               * `date` would have made that comparison cross semantics and stop
               * matching, silently and with every test still green.
               *
               * Falls back to `email.date` when a provider supplies no
               * `sentDate`, so an un-migrated caller degrades to the OLD
               * behaviour rather than writing NULL into a column eleven
               * consumers read.
               */
              toIsoStringOrNull(email.sentDate ?? email.date),
              /**
               * BACKLOG-2512: server-receipt timestamp.
               *
               * Until BACKLOG-2571 this was byte-identical to `sent_at` on
               * every new row, because both derived from `email.date`. It is
               * now genuinely distinct, and a difference between the two
               * columns IS meaningful — it is the send↔receive delta. Rows
               * written before this task still carry identical values in both,
               * and nothing on disk marks them as legacy: a re-sync is what
               * corrects them (founder decision, 2026-08-09 — the only rows
               * affected were his own test data, so a permanent marker column
               * would have outlived its cause).
               *
               * Parsed via toIsoStringOrNull so an unparseable provider
               * timestamp nulls one field instead of throwing into the
               * per-email catch below and discarding the whole email.
               */
              toIsoStringOrNull(email.receivedAt),
              email.hasAttachments ? 1 : 0,
              email.attachmentCount || 0,
              // BACKLOG-1769: persist the RFC Message-ID (was dropped as null) so
              // dedup-by-Message-ID works on the next sync and re-deliveries remap
              // in place instead of resurrecting as ghost rows.
              email.messageIdHeader ?? null,
              // BACKLOG-2512: content hash, already computed by both fetch
              // services. No reader on `emails.content_hash` today — the dedup
              // service queries the separate `messages` table — so this cannot
              // collide with an existing consumer.
              // BACKLOG-2572: NOT cross-provider comparable (Gmail hashes over
              // internalDate, Outlook over sentDateTime). Do not build
              // cross-provider dedup on this column without fixing that first.
              email.contentHash ?? null,
              // BACKLOG-2512: JSON per the schema contract ("JSON: Gmail
              // labels, Outlook categories") and `NewEmail.labels: string`.
              // Empty array → NULL so untagged mailboxes add no noise.
              email.labels && email.labels.length > 0
                ? JSON.stringify(email.labels)
                : null,
              // BACKLOG-2513: retained bulk-mail headers as JSON. These are the
              // negative-filter input for auto-detection (BACKLOG-2500 §4.2) —
              // the stage that exists because auto-detect manufactured
              // transactions from newsletters and bank mail (BACKLOG-2499).
              // Raw values only; NOTHING is classified here. No column reads
              // this yet, by design: interpreting the headers is a later,
              // revisable choice, and a classifier written now would freeze a
              // decision before scoring has measured anything (BACKLOG-2273).
              // No headers → NULL, so ordinary person-to-person mail adds no
              // noise (same shape as the labels rule above).
              email.bulkMailHeaders &&
              Object.keys(email.bulkMailHeaders).length > 0
                ? JSON.stringify(email.bulkMailHeaders)
                : null,
              rowIngestSource, // BACKLOG-1802: ingest_source provenance
              validatedAt, // BACKLOG-1802: set when ingest_source='search_validated'
              // BACKLOG-2857: this row is being written by the CURRENT derivation,
              // so it is current by construction. Binding the constant (never a
              // literal) is what makes a future bump reprocess these rows: the
              // moment CURRENT_DERIVATION_VERSION moves, everything written under
              // the old value falls below it and the pass picks it up.
              CURRENT_DERIVATION_VERSION,
            );

            // BACKLOG-1722: write the junction rows atomically alongside the
            // email INSERT. Both writers (Outlook + Gmail) now populate
            // `participants` in their ParsedEmail.
            if (email.participants && email.participants.length > 0) {
              for (const p of email.participants) {
                insertParticipantStmt.run(
                  id,
                  p.role,
                  p.position,
                  computeParticipantHash(id, p.role, p.position, p.email_address),
                  p.email_address,
                  p.display_name,
                );
              }
            }

            insertedEmailMap.set(email.id, id);
            stored++;
          } catch (emailError) {
            errors++;
            logService.warn(`Failed to store ${provider} email in batch`, "Transactions", {
              error: emailError instanceof Error ? emailError.message : "Unknown",
            });
          }
        }
      });

      runTransaction();

      // BACKLOG-1769: surface resurrection remaps for observability (ghost fix).
      if (writePlan.resurrections.length > 0) {
        logService.info(
          `Remapped ${writePlan.resurrections.length} re-delivered ${provider} email(s) to a new provider id (BACKLOG-1769)`,
          "Transactions",
        );
        Sentry.addBreadcrumb({
          category: "email_sync.resurrection_remap",
          message: `Remapped ${writePlan.resurrections.length} re-delivered email(s)`,
          level: "info",
          data: { provider, remapped: writePlan.resurrections.length },
        });
      }

      // BACKLOG-1369: Attachment file DOWNLOADS remain out of the sync pipeline
      // (bytes are fetched on-demand at preview/export).
      // BACKLOG-1870: but attachment METADATA (filename/mime/size) is now persisted
      // here so filenames are searchable after a normal sync. Runs after the insert
      // transaction, is idempotent, and never downloads bytes.
      await persistEmailAttachmentMetadata({
        emailsToInsert,
        insertedEmailMap,
        getAttachmentsFn,
        force,
      });
    } catch (batchError) {
      // If the entire batch transaction fails, log and count all as errors
      errors += emailsToInsert.length - stored;
      logService.warn(`Batch email insert failed for ${provider}`, "Transactions", {
        error: batchError instanceof Error ? batchError.message : "Unknown",
        attempted: emailsToInsert.length,
      });
    }
  }

  // BACKLOG-1831: cache hits = exact duplicates + resurrection remaps (both mean
  // "already in the local cache"). `stored` is the misses.
  const duplicates = writePlan.duplicates + writePlan.resurrections.length;
  return { fetched, stored, errors, duplicates };
}

/**
 * BACKLOG-1831: thin exported wrapper over the (module-internal) fetchStoreAndDedup
 * so out-of-file callers (the shadow delta engine) store parsed emails through the
 * EXACT same insert + dedup + counting path T2 uses. This is the concurrency
 * story: the INSERT is per-row try/catch and the emails table's per-account UNIQUE
 * indexes (idx_emails_account_external / idx_emails_account_message_id_header) make
 * duplicate rows impossible even when T2's transaction sync runs concurrently — a
 * race loser just logs a warn. Do NOT write a second INSERT path.
 *
 * Note (BACKLOG-1831): delta-sourced rows are tagged ingest_source='filter' (the
 * default). A dedicated 'delta_shadow' value was intentionally NOT added because
 * emails.ingest_source carries a CHECK constraint (schema.sql:372) and extending
 * it would require a schema migration, which this cheap shadow increment avoids.
 */
export async function storeParsedEmailsForAccount(params: {
  userId: string;
  provider: "outlook" | "gmail";
  emails: StoreableEmail[];
  /** Optional cross-call dedup set; defaults to a fresh per-call set. */
  seenIds?: Set<string>;
  /**
   * BACKLOG-1870: optional metadata-only attachment lookup for providers whose
   * list response omits filenames (Outlook). Never used to download bytes.
   */
  getAttachmentsFn?: (
    messageId: string,
  ) => Promise<
    Array<{ id: string; name: string; contentType: string; size: number }>
  >;
}): Promise<{ fetched: number; stored: number; errors: number; duplicates: number }> {
  return fetchStoreAndDedup({
    provider: params.provider,
    fetchFn: async () => params.emails,
    userId: params.userId,
    seenIds: params.seenIds ?? new Set<string>(),
    getAttachmentsFn: params.getAttachmentsFn,
  });
}

/**
 * TASK-2066: EmailSyncService encapsulates the full email sync orchestration.
 *
 * Extracted from the `sync-and-fetch-emails` IPC handler to keep handlers thin
 * (validation + rate limiting + delegation) while service owns business logic.
 */
class EmailSyncService {
  private precacheInProgress = false;
  /**
   * BACKLOG-2856: the in-flight pre-cache's cancellation handle, mirroring
   * `MacOSMessagesImportService`'s own `abortController`. Non-null only while a
   * run is in progress; `requestPrecacheCancellation` aborts it and every loop
   * boundary in `precacheEmails` consults the signal.
   *
   * BACKLOG-2856, SECOND ROUND — the signal now also goes INTO the fetch
   * services. Checking it here alone was not enough and the founder measured
   * why: one `searchAllFolders()` call spans folder discovery, every folder and
   * every Graph page, so the phase boundaries below could not be reached until
   * the entire download had finished. His cancel took 28.3 seconds, by which
   * point all 487 messages had been fetched AND staged, and were then thrown
   * away. Cancel cost exactly as much as not cancelling.
   *
   * The fetch services check the signal between pages, between folders/labels
   * and between Gmail detail batches, and hand it to axios/gaxios so the request
   * in flight is torn down. On abort they RETURN WHAT THEY HAVE, so fewer rows
   * reach staging — which is the observable difference between a cancel that
   * works and the one he reported.
   *
   * There is deliberately no compensating rollback attached to this: the force
   * run writes to staging and the `finally` drops staging on every exit, so a
   * cancelled run is a no-op against live BY CONSTRUCTION. Cancelling is
   * "stop doing more work", never "undo what was done".
   */
  private precacheAbortController: AbortController | null = null;
  private lastPrecacheCompletedAt: number | null = null;

  /**
   * Returns true if the email cache was populated recently enough to be trusted.
   * Used by the get-unlinked-emails handler to decide cache-vs-provider.
   */
  isCacheFresh(): boolean {
    if (this.lastPrecacheCompletedAt === null) return false;
    return (Date.now() - this.lastPrecacheCompletedAt) < EMAIL_CACHE_FRESHNESS_MS;
  }

  /**
   * Sync emails from provider(s) for a transaction, then auto-link communications.
   *
   * Steps:
   * 1. Compute date range from transaction details
   * 2. Fetch emails from Outlook (inbox/sent/all-folders) with network resilience
   * 3. Fetch emails from Gmail (search/all-labels) with network resilience
   * 4. Auto-link communications for each contact assignment
   */
  async syncTransactionEmails(params: {
    transactionId: string;
    userId: string;
    contactAssignments: TransactionContactResult[];
    contactEmails: string[];
    transactionDetails: TransactionWithDetails;
    // BACKLOG-1802: explicit fetch window. When omitted, defaults to
    // [computeTransactionDateRange().start, today] — the manual "Sync Emails"
    // full-window behavior. The auto-sync orchestrator passes a delta window
    // (forward-fill or backfill) so triggers fetch only the missing range.
    window?: { after: Date; before?: Date | null };
    // BACKLOG-1802: 'manual' when the user clicked Sync Emails (ingest_source).
    ingestSourceOverride?: "manual";
    // BACKLOG-2791: when true, freshly-fetched mail is QUEUED for review instead
    // of being auto-linked. Only the on-transaction-open trigger passes this —
    // the founder's rule is "nothing is ever silently linked (approval links)",
    // and that rule is scoped to discovery on the deal surface. Every other
    // caller (the manual "Sync Emails" button, the global background sync) keeps
    // today's auto-link behavior, which is why this defaults to false.
    queueForReviewInsteadOfLinking?: boolean;
  }): Promise<TransactionResponse> {
    const { transactionId, userId, contactAssignments, contactEmails, transactionDetails, window, ingestSourceOverride, queueForReviewInsteadOfLinking } = params;

    // TASK-2273: Breadcrumb at sync orchestration start with full context
    Sentry.addBreadcrumb({
      category: "email_sync.start",
      message: `Starting email sync for transaction`,
      level: "info",
      data: {
        provider: "all",
        contactCount: contactAssignments.length,
        contactEmailCount: contactEmails.length,
      },
    });

    if (contactEmails.length === 0) {
      // No contact emails -- still resolve phone-based message matching.
      //
      // BACKLOG-2791: this early return sits ~150 lines ABOVE the
      // queueForReviewInsteadOfLinking branch, so before the flag was threaded
      // here it leaked straight past the redirect: a deal whose assigned parties
      // are all PHONE-ONLY had its text messages SILENTLY LINKED on every open —
      // never queued, never announced — on the very path this feature claims to
      // have redirected. runAutoLinkOnly took no flag and had no queue path.
      return this.runAutoLinkOnly(
        transactionId,
        contactAssignments,
        queueForReviewInsteadOfLinking,
      );
    }

    // Diagnostic: how many emails are in the local DB for this user?
    const emailCount = await countEmailsByUser(userId);
    logService.info(`Local emails table has ${emailCount} emails for user`, "Transactions", {
      userId,
    });

    // Step 1: Fetch emails from provider and store locally
    // The auto-link searches the local emails table, so we need to ensure
    // relevant emails are downloaded first.
    // TASK-2049: Wrapped with network resilience -- partial save on disconnect,
    // retry with exponential backoff, auto-retry on reconnect
    let emailsFetched = 0;
    let emailsStored = 0;
    // BACKLOG-1831: cache HITS (already-cached dupes/resurrections) across all providers.
    let emailsDuplicates = 0;
    let networkErrorOccurred = false;
    let networkErrorMessage = "";

    // TASK-2060/2068: Compute date range for email fetching based on transaction audit period.
    // Uses canonical computeTransactionDateRange from electron/utils/emailDateRange.ts.
    // BACKLOG-1802: an explicit `window` (delta from the auto-sync orchestrator)
    // overrides the computed full window so triggers fetch only the missing range.
    const emailFetchSinceDate = window?.after ?? computeTransactionDateRange(transactionDetails).start;
    const emailFetchBeforeDate = window?.before ?? null;
    logService.info(`Email fetch date range: since ${emailFetchSinceDate.toISOString()}${emailFetchBeforeDate ? ` until ${emailFetchBeforeDate.toISOString()}` : ""}`, "Transactions", {
      transactionId,
      sinceDate: emailFetchSinceDate.toISOString(),
      beforeDate: emailFetchBeforeDate?.toISOString() ?? null,
      windowed: !!window,
      source: window ? "window_override" : transactionDetails.started_at ? "started_at" : transactionDetails.created_at ? "created_at" : "fallback_2yr",
    });

    // TASK-2060: Shared seenIds set for cross-provider deduplication
    const seenEmailIds = new Set<string>();

    // TASK-2070: Track provider errors for UI warning
    let providerWarning = "";

    // Try Outlook (TASK-2049: with network resilience)
    const outlookResult = await this.fetchOutlookEmails({
      userId,
      transactionId,
      contactEmails,
      emailFetchSinceDate,
      emailFetchBeforeDate,
      seenEmailIds,
      ingestSourceOverride,
    });
    emailsFetched += outlookResult.fetched;
    emailsStored += outlookResult.stored;
    emailsDuplicates += outlookResult.duplicates;
    if (outlookResult.networkError) {
      networkErrorOccurred = true;
      networkErrorMessage = outlookResult.networkErrorMessage || "";
    }
    if (outlookResult.providerError) {
      providerWarning = outlookResult.providerError;
    }

    // Try Gmail (bidirectional: from + to contacts) (TASK-2049: with network resilience)
    const gmailResult = await this.fetchGmailEmails({
      userId,
      transactionId,
      contactEmails,
      emailFetchSinceDate,
      emailFetchBeforeDate,
      seenEmailIds,
      currentEmailsStored: emailsStored,
      ingestSourceOverride,
    });
    emailsFetched += gmailResult.fetched;
    emailsStored += gmailResult.stored;
    emailsDuplicates += gmailResult.duplicates;
    if (gmailResult.networkError) {
      networkErrorOccurred = true;
      networkErrorMessage = gmailResult.networkErrorMessage || "";
    }
    if (gmailResult.providerError && !providerWarning) {
      providerWarning = gmailResult.providerError;
    }

    logService.info(`Email fetch complete: ${emailsFetched} fetched, ${emailsStored} new stored`, "Transactions");

    // BACKLOG-1831: cache hit/miss instrumentation — the experiment's success
    // metric. `planEmailWrites` already computed which fetched rows were already
    // cached (dupes + resurrection remaps) vs genuinely new; we surface that
    // dropped signal here. HITS = already cached, MISSES = newly stored.
    // Emitted three ways: a [CACHE-HITMISS] log line, a Sentry breadcrumb, and one
    // durable failure_log row (operation='email_cache_hitmiss') so the experiment
    // accumulates across days (subject to failure_log's 500-row / 30-day retention).
    {
      const cacheHits = emailsDuplicates;
      const cacheMisses = emailsStored;
      const hitRate = cacheHits / Math.max(1, cacheHits + cacheMisses);
      const reason = ingestSourceOverride ?? "auto";
      logService.info(
        `[CACHE-HITMISS] transaction=${transactionId} reason=${reason} fetched=${emailsFetched} hits=${cacheHits} misses=${cacheMisses} hitRate=${hitRate.toFixed(3)}`,
        "Transactions",
      );
      Sentry.addBreadcrumb({
        category: "email_sync.cache_hitmiss",
        message: `Cache hit/miss: ${cacheHits} hits / ${cacheMisses} misses (${(hitRate * 100).toFixed(1)}%)`,
        level: "info",
        data: { transactionId, reason, fetched: emailsFetched, cacheHits, cacheMisses, hitRate },
      });
      // Fire-and-forget durable row (must never block or crash the sync path).
      void failureLogService.logEvent("email_cache_hitmiss", {
        transactionId,
        reason,
        fetched: emailsFetched,
        cacheHits,
        cacheMisses,
        hitRate,
      });
    }

    // BACKLOG-1340: Provider fetch summary breadcrumb with safety cap check
    Sentry.addBreadcrumb({
      category: "auto_link.provider_fetch",
      message: `Provider fetch summary: ${emailsFetched} fetched, ${emailsStored} stored`,
      level: emailsFetched >= EMAIL_FETCH_SAFETY_CAP ? "warning" : "info",
      data: {
        transactionId,
        emailsFetched,
        emailsStored,
        hitSafetyCap: emailsFetched >= EMAIL_FETCH_SAFETY_CAP,
        safetyCap: EMAIL_FETCH_SAFETY_CAP,
        networkErrorOccurred,
      },
    });

    // Step 2: Auto-link from local DB
    Sentry.addBreadcrumb({
      category: 'sync',
      message: 'Auto-link started',
      level: 'info',
      data: {
        operation: 'sync-and-fetch-emails',
        contactCount: contactAssignments.length,
      },
    });
    let totalEmailsLinked = 0;
    let totalMessagesLinked = 0;
    let totalAlreadyLinked = 0;
    let totalErrors = 0;

    // BACKLOG-2791 (founder ruling, 2026-08-22): the SHIPPED split is restored.
    // An earlier revision of this PR queued EVERYTHING found here, which made
    // the popup read "0 linked successfully" on every run. The classification is
    // develop's again — confident emails link, texts link — and the only change
    // is that the ambiguous half is queued for review instead of being linked
    // with an address_missing flag.
    let totalQueuedForReview = 0;
    for (const assignment of contactAssignments) {
      try {
        const result = await autoLinkCommunicationsForContact({
          contactId: assignment.contact_id,
          transactionId,
          queueAmbiguousInsteadOfLinking: queueForReviewInsteadOfLinking,
        });

        totalEmailsLinked += result.emailsLinked;
        totalMessagesLinked += result.messagesLinked;
        totalAlreadyLinked += result.alreadyLinked;
        totalQueuedForReview += result.queuedForReview ?? 0;
        totalErrors += result.errors;
      } catch (error) {
        totalErrors++;
        logService.warn(
          `Auto-link failed for contact ${assignment.contact_id}`,
          "Transactions",
          {
            error: error instanceof Error ? error.message : "Unknown",
          }
        );
      }
    }

    Sentry.addBreadcrumb({
      category: 'sync',
      message: 'Auto-link completed',
      level: 'info',
      data: {
        operation: 'sync-and-fetch-emails',
        totalEmailsLinked,
        totalMessagesLinked,
        totalErrors,
      },
    });

    // BACKLOG-1369: Attachment backfill removed from sync pipeline.
    // Attachments are now downloaded on-demand when user views email or during export.

    logService.info("Sync and fetch emails complete", "Transactions", {
      transactionId,
      contactEmails,
      totalEmailsLinked,
      totalMessagesLinked,
      totalAlreadyLinked,
      totalErrors,
      networkErrorOccurred,
    });

    // BACKLOG-2393: the email funnel end to end — fetched from the provider,
    // deduplicated, stored, then linked to this deal. "The email is in Outlook
    // but not on the transaction" has four different causes with the same
    // symptom, and only the gap between these numbers tells them apart. Counts
    // only; addresses are not recorded here. A no-op outside a granted window.
    supportTrace("email-sync", "transaction-sync-complete", {
      transaction_id: transactionId,
      contact_addresses_searched: contactEmails.length,
      contact_assignments: contactAssignments.length,
      window_from: emailFetchSinceDate,
      window_to: emailFetchBeforeDate,
      fetched_from_provider: emailsFetched,
      duplicates_dropped: emailsDuplicates,
      newly_stored: emailsStored,
      emails_linked: totalEmailsLinked,
      threads_linked: totalMessagesLinked,
      already_linked: totalAlreadyLinked,
      errors: totalErrors,
      network_error: networkErrorOccurred,
      provider_warning: providerWarning ?? null,
    });

    // TASK-2049: Return partial success when network error occurred but some emails were saved
    if (networkErrorOccurred) {
      return {
        success: false,
        error: networkErrorMessage || "Network disconnected during email sync. Already-fetched emails have been saved.",
        partialSync: true,
        emailsFetched,
        emailsStored,
        totalEmailsLinked,
        totalMessagesLinked,
        totalAlreadyLinked,
        totalErrors,
      };
    }

    // TASK-2070: Include warning when provider fetch failed but local results are available
    const result: TransactionResponse = {
      success: true,
      totalEmailsLinked,
      totalMessagesLinked,
      totalAlreadyLinked,
      // BACKLOG-2791: the popup's R. Reported separately from linked counts so a
      // queued item can never be counted as a link.
      totalQueuedForReview,
      totalErrors,
    };
    if (providerWarning) {
      result.warning = providerWarning;
    }
    return result;
  }

  /**
   * Run auto-link only (no email fetching) -- used when there are no contact emails
   * but we still want to link phone-based messages.
   */
  private async runAutoLinkOnly(
    transactionId: string,
    contactAssignments: TransactionContactResult[],
    // BACKLOG-2791: same contract as syncTransactionEmails — on the deal surface
    // this QUEUES for review; every other caller keeps auto-linking.
    queueForReviewInsteadOfLinking = false,
  ): Promise<TransactionResponse> {
    let totalMessagesLinked = 0;
    let totalAlreadyLinked = 0;
    let totalErrors = 0;

    // BACKLOG-2791: nothing special to do here any more. This path exists for
    // PHONE-ONLY contacts, and texts are never classified — TASK-2087 removed
    // address filtering from messages entirely, so every matching thread links,
    // exactly as it does on develop. The earlier revision queued them, which is
    // what emptied the linked count on phone-only deals.
    for (const assignment of contactAssignments) {
      try {
        const result = await autoLinkCommunicationsForContact({
          contactId: assignment.contact_id,
          transactionId,
        });
        totalMessagesLinked += result.messagesLinked;
        totalAlreadyLinked += result.alreadyLinked;
        totalErrors += result.errors;
      } catch (error) {
        totalErrors++;
        logService.warn(
          `Auto-link failed for contact ${assignment.contact_id}`,
          "Transactions",
          { error: error instanceof Error ? error.message : "Unknown" }
        );
      }
    }

    return {
      success: true,
      emailsFetched: 0,
      emailsStored: 0,
      totalEmailsLinked: 0,
      totalMessagesLinked,
      totalAlreadyLinked,
    };
  }

  // ============================================
  // TASK-2067: New public methods for Gap 1 & Gap 2
  // ============================================

  /**
   * TASK-2067 Gap 1: Search provider emails and store results locally.
   *
   * Wraps the provider search logic from the get-unlinked-emails handler
   * with fetchStoreAndDedup() so that fetched emails are persisted locally
   * even if the user doesn't manually attach them.
   *
   * Returns the same response shape the renderer expects.
   */
  async searchProviderEmails(params: {
    userId: string;
    searchParams: EmailSearchParams;
    transactionId?: string;
  }): Promise<SearchProviderEmailsResult> {
    const { userId, searchParams, transactionId } = params;

    // Look up contact emails for the transaction (if provided)
    let contactEmails: string[] = [];
    if (transactionId) {
      try {
        contactEmails = getContactEmailsForTransaction(transactionId);
        logService.info(`Found ${contactEmails.length} contact emails for transaction`, "EmailSyncService", {
          transactionId,
        });
      } catch (contactErr) {
        logService.warn("Failed to look up contact emails, proceeding without filter", "EmailSyncService", {
          error: contactErr instanceof Error ? contactErr.message : "Unknown",
        });
      }
    }

    // When user is actively searching, resolve query against contacts DB
    const effectiveSearchParams = { ...searchParams };
    if (searchParams.query?.trim()) {
      const resolvedEmails = resolveContactEmailsByQuery(userId, searchParams.query);
      logService.info(`Search query "${searchParams.query}": resolved to ${resolvedEmails.length} contact emails`, "EmailSyncService", {
        resolvedEmails: resolvedEmails.slice(0, 5),
        willUseContactFilter: resolvedEmails.length > 0,
        willPassthrough: resolvedEmails.length === 0,
      });
      if (resolvedEmails.length > 0) {
        effectiveSearchParams.contactEmails = resolvedEmails;
        effectiveSearchParams.query = "";
      }
    }

    // Check which providers are authenticated
    const googleToken = await databaseService.getOAuthToken(userId, "google", "mailbox");
    const microsoftToken = await databaseService.getOAuthToken(userId, "microsoft", "mailbox");

    let emails: ProviderEmailResult[] = [];
    const seenIds = new Set<string>();
    // TASK-2070: Track provider errors for UI warning
    let providerWarning = "";

    // Fetch from Gmail if authenticated
    if (googleToken) {
      try {
        await retryOnNetwork(async () => {
          const isReady = await gmailFetchService.initialize(userId);
          if (isReady) {
            const gmailEmails = await gmailFetchService.searchEmails(effectiveSearchParams);

            // TASK-2067: Store fetched emails locally via fetchStoreAndDedup
            await fetchStoreAndDedup({
              provider: "gmail",
              fetchFn: async () => gmailEmails,
              userId,
              seenIds,
            });

            // BACKLOG-1579 Phase 2: Return local UUIDs instead of provider-prefixed IDs.
            // Look up each email by external_id to get the local UUID from the emails table.
            emails = await Promise.all(gmailEmails.map(async (email: { id: string; subject: string | null; from: string | null; date: Date; bodyPlain: string; snippet: string; threadId: string; hasAttachments: boolean }) => {
              const localRecord = await getEmailByExternalId(userId, email.id);
              return {
                id: localRecord?.id ?? `gmail:${email.id}`,
                subject: email.subject,
                sender: email.from,
                sent_at: email.date ? new Date(email.date).toISOString() : null,
                body_preview: (email.snippet || email.bodyPlain?.substring(0, 200)) || null,
                thread_id: email.threadId || null,
                has_attachments: email.hasAttachments || false,
                provider: "gmail" as const,
              };
            }));
            logService.info(`Fetched and stored ${emails.length} emails from Gmail`, "EmailSyncService");
          }
        }, undefined, "GmailSearch");
      } catch (gmailError) {
        logService.warn("Failed to fetch from Gmail", "EmailSyncService", {
          error: gmailError instanceof Error ? gmailError.message : "Unknown",
          isNetworkError: isNetworkError(gmailError),
        });
        // TASK-2070: Classify provider error for UI warning
        if (!isNetworkError(gmailError)) {
          Sentry.captureException(gmailError, {
            tags: { service: "email-sync", operation: "provider-fetch", provider: "gmail" },
            level: "warning",
            fingerprint: ["provider-fetch-failure", "gmail"],
          });
          providerWarning = classifyProviderError(gmailError);
        } else {
          providerWarning = "Could not reach your email provider. Showing cached results only.";
        }
        // TASK-2273: Structured failure reporting
        const reason = classifyEmailSyncError(gmailError);
        Sentry.captureMessage(`Email sync failed: ${reason}`, {
          level: reason === "rate_limited" ? "warning" : "error",
          tags: {
            component: "email_sync",
            provider: "gmail",
            failureReason: reason,
          },
          extra: {
            emailsFetchedSoFar: emails.length,
            errorMessage: gmailError instanceof Error ? gmailError.message : String(gmailError),
            responseStatus: (gmailError as any)?.response?.status,
          },
        });
      }
    }

    // Fetch from Outlook if authenticated (and no Gmail emails)
    if (microsoftToken && emails.length === 0) {
      try {
        await retryOnNetwork(async () => {
          const isReady = await outlookFetchService.initialize(userId);
          if (isReady) {
            const outlookEmails = await outlookFetchService.searchEmails(effectiveSearchParams);

            // Also search sent items for emails TO contacts (bidirectional)
            let sentEmails: typeof outlookEmails = [];
            const sentSearchEmails = effectiveSearchParams.contactEmails || [];
            if (sentSearchEmails.length > 0) {
              try {
                sentEmails = await outlookFetchService.searchSentEmailsToContacts(
                  sentSearchEmails, Math.min(50, effectiveSearchParams.maxResults),
                );
              } catch { /* logged inside the method */ }
            }

            // Merge and dedup
            const allOutlook = [...outlookEmails, ...sentEmails];
            const outlookSeenIds = new Set<string>();
            const dedupedOutlook = allOutlook.filter(e => {
              if (outlookSeenIds.has(e.id)) return false;
              outlookSeenIds.add(e.id);
              return true;
            });

            // TASK-2067: Store fetched emails locally via fetchStoreAndDedup
            await fetchStoreAndDedup({
              provider: "outlook",
              fetchFn: async () => dedupedOutlook,
              userId,
              seenIds,
              getAttachmentsFn: (msgId) => outlookFetchService.getAttachments(msgId),
            });

            // BACKLOG-1579 Phase 2: Return local UUIDs instead of provider-prefixed IDs.
            emails = await Promise.all(dedupedOutlook.map(async (email: { id: string; subject: string | null; from: string | null; date: Date; bodyPlain: string; snippet: string; threadId: string; hasAttachments: boolean }) => {
              const localRecord = await getEmailByExternalId(userId, email.id);
              return {
                id: localRecord?.id ?? `outlook:${email.id}`,
                subject: email.subject,
                sender: email.from,
                sent_at: email.date ? new Date(email.date).toISOString() : null,
                body_preview: (email.snippet || email.bodyPlain?.substring(0, 200)) || null,
                thread_id: email.threadId || null,
                has_attachments: email.hasAttachments || false,
                provider: "outlook" as const,
              };
            }));
            logService.info(`Fetched and stored ${outlookEmails.length} inbox + ${sentEmails.length} sent = ${emails.length} unique from Outlook`, "EmailSyncService");
          }
        }, undefined, "OutlookSearch");
      } catch (outlookError) {
        logService.warn("Failed to fetch from Outlook", "EmailSyncService", {
          error: outlookError instanceof Error ? outlookError.message : "Unknown",
          isNetworkError: isNetworkError(outlookError),
        });
        // TASK-2070: Classify provider error for UI warning
        if (!providerWarning) {
          if (!isNetworkError(outlookError)) {
            Sentry.captureException(outlookError, {
              tags: { service: "email-sync", operation: "provider-fetch", provider: "outlook" },
              level: "warning",
              fingerprint: ["provider-fetch-failure", "outlook"],
            });
            providerWarning = classifyProviderError(outlookError);
          } else {
            providerWarning = "Could not reach your email provider. Showing cached results only.";
          }
        }
        // TASK-2273: Structured failure reporting
        const reason = classifyEmailSyncError(outlookError);
        Sentry.captureMessage(`Email sync failed: ${reason}`, {
          level: reason === "rate_limited" ? "warning" : "error",
          tags: {
            component: "email_sync",
            provider: "outlook",
            failureReason: reason,
          },
          extra: {
            emailsFetchedSoFar: emails.length,
            errorMessage: outlookError instanceof Error ? outlookError.message : String(outlookError),
            responseStatus: (outlookError as any)?.response?.status,
          },
        });
      }
    }

    // If provider search returned 0 results and we had a text query,
    // fall back to searching locally cached emails (handles Graph API
    // $search limitations like pure numeric queries returning 400)
    if (emails.length === 0 && searchParams.query?.trim()) {
      const queryLower = searchParams.query.toLowerCase().trim();
      logService.info('Provider search returned 0, falling back to local cache', 'EmailSyncService', { query: searchParams.query });
      try {
        const localEmails = searchLocalEmailCache(userId, queryLower, searchParams.maxResults || 500);
        if (localEmails.length > 0) {
          logService.info('Local cache fallback found results', 'EmailSyncService', { count: localEmails.length, query: searchParams.query });
          emails = localEmails.map(e => ({
            id: e.id,
            subject: e.subject || null,
            sender: e.sender || null,
            sent_at: e.sent_at || null,
            body_preview: e.body_preview || null,
            thread_id: e.thread_id || null,
            has_attachments: e.has_attachments || false,
            provider: "outlook" as const, // sourced from local cache of provider emails
          }));
        }
      } catch (localErr) {
        logService.warn('Local cache fallback failed', 'EmailSyncService', { error: localErr instanceof Error ? localErr.message : String(localErr) });
      }
    }

    // TASK-2070: Include warning when provider fetch failed
    const result: SearchProviderEmailsResult = {
      emails,
      noProviderConnected: emails.length === 0 && !googleToken && !microsoftToken,
    };
    if (providerWarning) {
      result.warning = providerWarning;
    }
    return result;
  }

  /**
   * TASK-2067 Gap 2: Fetch emails from provider for audit period, store locally,
   * then auto-link communications for a contact.
   *
   * Called when a contact is assigned to a transaction. This ensures provider emails
   * for the audit period are in the local DB before auto-link searches it.
   */
  /**
   * Check if local email cache extends back to before the audit start for given contact emails.
   * If we have cached emails from before the audit period started, a provider fetch is redundant.
   */
  private localCacheCoversAuditPeriod(
    userId: string,
    contactEmails: string[],
    auditStart: Date,
  ): boolean {
    if (contactEmails.length === 0) return false;

    // BACKLOG-1722: Junction-backed exact lookup replaces the previous
    // LOWER(sender) IN (...) OR LOWER(recipients) LIKE ... scan, which
    // could miss BCC-only and Outlook display-name-only matches and was
    // unindexed for the LIKE clause.
    const placeholders = contactEmails.map(() => "?").join(", ");
    const sql = `
      SELECT MIN(e.sent_at) as earliest, COUNT(DISTINCT e.id) as total
      FROM email_participants ep
      JOIN emails e ON e.id = ep.email_id
      WHERE e.user_id = ?
        AND ep.email_address IN (${placeholders})
    `;
    const lowerEmails = contactEmails.map((e) => e.toLowerCase().trim());
    const params = [userId, ...lowerEmails];

    const row = dbGet<{ earliest: string | null; total: number }>(sql, params);

    if (!row || row.total === 0 || !row.earliest) {
      return false;
    }

    const earliest = new Date(row.earliest);
    const covers = earliest <= auditStart;

    logService.info(`Cache coverage check for contact`, "EmailSyncService", {
      cachedEmails: row.total,
      earliest: earliest.toISOString(),
      auditStart: auditStart.toISOString(),
      covers,
    });

    return covers;
  }

  async fetchAndAutoLinkForContact(params: {
    userId: string;
    transactionId: string;
    contactId: string;
    transactionDetails: {
      started_at?: Date | string | null;
      created_at?: Date | string | null;
      closed_at?: Date | string | null;
    };
    // BACKLOG-2791: when true, whatever the fetch brings in is QUEUED for review
    // instead of auto-linked. The transaction-details contact-save paths pass
    // this (discovery on the deal surface never links silently); every other
    // caller keeps today's behavior, hence the default.
    queueForReviewInsteadOfLinking?: boolean;
  }): Promise<FetchAndAutoLinkResult> {
    const { userId, transactionId, contactId, transactionDetails, queueForReviewInsteadOfLinking } = params;

    // Get contact email addresses
    const contactEmails = getEmailsByContactId(contactId);

    // BACKLOG-1340: Breadcrumb for contact email resolution in sync flow
    Sentry.addBreadcrumb({
      category: "auto_link.sync_trigger",
      message: `Sync triggered for contact assignment`,
      level: "info",
      data: {
        transactionId,
        contactId,
        contactEmailCount: contactEmails.length,
      },
    });

    let emailsFetched = 0;
    let emailsStored = 0;

    if (contactEmails.length > 0) {
      // Compute audit period date range
      const emailFetchSinceDate = computeTransactionDateRange(transactionDetails).start;

      // Skip provider fetch if local cache already covers the audit period for this contact
      if (this.localCacheCoversAuditPeriod(userId, contactEmails, emailFetchSinceDate)) {
        logService.info(`Skipping provider fetch — local cache covers audit period for contact`, "EmailSyncService", {
          transactionId,
          contactId,
          contactEmailCount: contactEmails.length,
        });
        // BACKLOG-1340: Log cache-skip decision
        Sentry.addBreadcrumb({
          category: "auto_link.provider_fetch",
          message: "Skipped provider fetch — local cache covers audit period",
          level: "info",
          data: { transactionId, contactId },
        });
      } else {
      logService.info(`Fetching provider emails for contact assignment`, "EmailSyncService", {
        transactionId,
        contactId,
        contactEmailCount: contactEmails.length,
        sinceDate: emailFetchSinceDate.toISOString(),
      });

      const seenEmailIds = new Set<string>();

      // Fetch from Outlook
      const outlookResult = await this.fetchOutlookEmails({
        userId,
        transactionId,
        contactEmails,
        emailFetchSinceDate,
        seenEmailIds,
      });
      emailsFetched += outlookResult.fetched;
      emailsStored += outlookResult.stored;

      // Fetch from Gmail
      const gmailResult = await this.fetchGmailEmails({
        userId,
        transactionId,
        contactEmails,
        emailFetchSinceDate,
        seenEmailIds,
        currentEmailsStored: emailsStored,
      });
      emailsFetched += gmailResult.fetched;
      emailsStored += gmailResult.stored;

      logService.info(`Provider fetch for contact assignment complete`, "EmailSyncService", {
        transactionId,
        contactId,
        emailsFetched,
        emailsStored,
      });

      // BACKLOG-1340: Breadcrumb for provider fetch results
      Sentry.addBreadcrumb({
        category: "auto_link.provider_fetch",
        message: `Provider fetch complete: ${emailsFetched} fetched, ${emailsStored} new stored`,
        level: emailsFetched === 0 ? "warning" : "info",
        data: {
          transactionId,
          contactId,
          emailsFetched,
          emailsStored,
          hitSafetyCap: emailsFetched >= EMAIL_FETCH_SAFETY_CAP,
        },
      });
      } // end else (provider fetch)
    } else {
      // BACKLOG-1340: Contact has no emails — log this edge case
      Sentry.addBreadcrumb({
        category: "auto_link.provider_fetch",
        message: "No contact emails — skipping provider fetch (phone-only contact)",
        level: "info",
        data: { transactionId, contactId },
      });
    }

    // Now resolve from the local DB (which includes newly fetched emails).
    // BACKLOG-2791: on the deal surface this QUEUES for review rather than
    // linking — the founder's "nothing is ever silently linked" rule. The scan
    // is scoped to THIS contact's identities across the full window, which is
    // the direction the on-open watermark cannot cover (a newly added contact's
    // matching mail is older than the watermark).
    // BACKLOG-2791: develop's classification, with the ambiguous half queued on
    // the details-discovery paths. Confident emails and every text still link.
    const autoLinkResult: AutoLinkResult = await autoLinkCommunicationsForContact({
      contactId,
      transactionId,
      queueAmbiguousInsteadOfLinking: queueForReviewInsteadOfLinking,
    });

    return {
      emailsFetched,
      emailsStored,
      autoLinkResult,
    };
  }

  // ============================================
  // BACKLOG-1362: Bulk email pre-cache
  // ============================================

  /**
   * BACKLOG-1362: Pre-cache emails from connected providers.
   *
   * Unlike syncTransactionEmails (which fetches per-contact for a transaction),
   * this fetches ALL emails within the user's configured cache window
   * (emailCache.durationMonths). It is incremental: if the local cache already
   * has emails, only emails newer than the latest cached email are fetched.
   *
   * Called:
   * - After onboarding email connection (via SyncOrchestrator)
   * - Manually via "Re-cache Emails" button in Settings
   *
   * No auto-linking is performed here; that happens per-transaction.
   *
   * BACKLOG-2856: `options.force` runs the same fetch as a FORCE RE-CACHE —
   * every provider row in the cache window is re-downloaded and replaces what is
   * stored, rather than only mail newer than the newest cached row. Parity with
   * the macOS messages Force Re-import, link loss included (founder decision,
   * 2026-08-24). Written through stage-and-swap, so an interrupted force run
   * leaves the live table exactly as it was.
   */
  /**
   * Stop the in-flight email pre-cache at its next loop boundary (BACKLOG-2856).
   *
   * Mirrors `macOSMessagesImportService.requestCancellation()` and, like it, is
   * only ever "stop doing more work". It does NOT undo anything, because there
   * is nothing to undo: an ordinary run has written only repaired rows that were
   * already correct to write, and a force run has written only to staging, which
   * the `finally` drops. Live email is untouched until the swap, so a cancelled
   * run is a no-op against it by construction rather than by recovery.
   *
   * DIVERGENCE FROM THE MESSAGES VERSION, ON PURPOSE: no pending-cancellation
   * held for a future run. The messages importer stores one because its cancel
   * can race a not-yet-started import; the email Cancel control only exists
   * while a run is in flight, so holding an unconsumed abort would let a stray
   * click kill an unrelated re-cache the user started minutes later.
   *
   * @returns true if a run was in flight and has been asked to stop.
   */
  requestPrecacheCancellation(): boolean {
    if (!this.precacheInProgress || !this.precacheAbortController) {
      logService.info(
        "Email pre-cache cancellation requested with no run in flight — ignored",
        "EmailSyncService",
      );
      return false;
    }
    logService.info("Email pre-cache cancellation requested", "EmailSyncService");
    this.precacheAbortController.abort();
    return true;
  }

  async precacheEmails(
    userId: string,
    onProgress?: EmailPrecacheProgressCallback,
    options?: { force?: boolean },
  ): Promise<{
    fetched: number;
    stored: number;
    error?: string;
    /**
     * BACKLOG-2856: the user stopped the run via `requestPrecacheCancellation`.
     * Set only when the abort was observed BEFORE the swap committed — a cancel
     * that lands after the swap is too late to mean anything and the run reports
     * its real success, because the mail has already been rebuilt.
     *
     * Never accompanied by `error`: a cancel is the user getting what they asked
     * for, and painting it as a failure would be wrong.
     */
    cancelled?: boolean;
    /** BACKLOG-2856: present only on a force run that reached the swap. */
    forceSwap?: {
      emailsDeleted: number;
      emailsInserted: number;
      participantsInserted: number;
      providers: EmailForceProvider[];
    };
    // BACKLOG-2127: set ONLY for auth-class (token expiry) failures so the
    // sync UI can surface a reconnect prompt instead of a green "0 new".
    // Transient/network failures leave this undefined so the sync still
    // completes (see AC: NOT_CONNECTED / transient must not error).
    providerError?: {
      provider: "microsoft" | "google";
      message: string;
      tokenExpired: boolean;
    };
  }> {
    if (this.precacheInProgress) {
      logService.info("[EmailSync] Precache already in progress, skipping", "EmailSync");
      // BACKLOG-2856 — DELIBERATELY NO TERMINAL PROGRESS EVENT ON THIS PATH.
      //
      // Every other exit emits one so the bar cannot strand. This one must not,
      // and emitting it here would cause the very defect the others prevent:
      // the guard means a run IS already live, the progress channel is shared by
      // every window, so a rejected second invocation's "done" would settle the
      // RUNNING run's bar and hide a re-cache that is still going.
      //
      // The rejected caller is settled by its own invoke response instead — the
      // `error` below — and the renderer clears its bar on promise resolution
      // regardless of events, which is the stronger guarantee anyway. Covered at
      // the handler/renderer boundary, not here.
      return { fetched: 0, stored: 0, error: "Precache already in progress" };
    }
    this.precacheInProgress = true;
    // BACKLOG-2856: the force run's staging handle, held here so every exit path
    // — success, thrown error, or the `finally` below — can drop it. Live is
    // untouched until `swapEmailStagingIntoLive`, so an abandoned run costs two
    // ephemeral tables and nothing else.
    const isForce = options?.force === true;
    // BACKLOG-2856: fresh controller per run; cleared in the `finally` so a
    // cancel requested between runs can never abort the next one.
    const abort = new AbortController();
    this.precacheAbortController = abort;
    const isCancelled = (): boolean => abort.signal.aborted;

    // Progress bookkeeping. Declared out here because the terminal event is
    // emitted from the `finally`, which cannot see the counters declared inside
    // the try. `progressOutcome` defaults to "error" so an exit nobody
    // anticipated — a throw, a return added later — still settles the bar, and
    // settles it honestly rather than claiming success.
    let lastPercent = 0;
    let progressCurrent = 0;
    let progressOutcome: "success" | "error" | "cancelled" = "error";
    const emitProgress: EmailPrecacheProgressCallback = (progress) => {
      lastPercent = progress.percent;
      progressCurrent = progress.current;
      onProgress?.(progress);
    };

    let forceStaging: EmailForceStaging | null = null;
    let forceSwap: {
      emailsDeleted: number;
      emailsInserted: number;
      participantsInserted: number;
      providers: EmailForceProvider[];
    } | undefined;
    try {
    logService.info("Starting email pre-cache", "EmailSyncService", { userId, force: isForce });

    // BACKLOG-2857 — repair rows produced by a superseded derivation, BEFORE any
    // fetching.
    //
    // Placed here, unconditionally, rather than after the fetch loop and rather
    // than gated on "new messages arrived". A fully-cached mailbox fetches ZERO
    // new messages, and that is exactly the mailbox most in need of repair — its
    // rows are the OLD ones. Gating the pass on new mail would mean the users with
    // the most damage get the least repair, and the founder's own case (test the
    // truncation fix against an existing mailbox with no re-download) would
    // silently do nothing.
    //
    // It is safe to run every time: when nothing is stale the partial index makes
    // the first SELECT return no rows immediately. Failures are swallowed — a
    // repair pass must never be the reason a sync fails, and the rows it did not
    // reach are still correctly stamped for the next run.
    //
    // BACKLOG-2856: SKIPPED on a force run. Every row it would repair is in the
    // force set and is about to be deleted and re-fetched, and a re-fetched row
    // is stamped with the current derivation by construction. Running it anyway
    // would rewrite the whole corpus immediately before discarding it — and it
    // writes LIVE, which a force run's whole design is to avoid until the swap.
    if (!isForce) {
    // BACKLOG-2856: the repair pass is the FIRST thing an ordinary re-cache
    // waits through and on a large mailbox it is minutes of it, so it reports
    // before anything fetch-related. `percent` holds at REPAIRING while
    // `current` climbs — the count moves, the bar does not go backwards when
    // fetching starts.
    //
    // (There is no repairing phase on a force run at all: the pass is skipped
    // there, because every row it would repair is inside the force set and about
    // to be deleted and re-fetched. Its sequence starts at `fetching`.)
    emitProgress({
      phase: "repairing",
      current: 0,
      total: 0,
      percent: EMAIL_PRECACHE_PERCENT.REPAIRING,
    });
    try {
      const repair = await reprocessEmailDerivations({
        userId,
        // Consulted BETWEEN batches by the pass itself, so a cancel takes effect
        // at a batch boundary with every already-processed row correctly
        // stamped — never mid-transaction.
        shouldCancel: isCancelled,
        onProgress: ({ scanned, rewritten }) => {
          emitProgress({
            phase: "repairing",
            current: scanned,
            total: scanned,
            percent: EMAIL_PRECACHE_PERCENT.REPAIRING,
          });
          void rewritten;
        },
      });
      if (repair.scanned > 0) {
        logService.info("Derivation reprocess complete", "EmailSyncService", {
          userId,
          scanned: repair.scanned,
          rewritten: repair.rewritten,
          unchanged: repair.unchanged,
          batches: repair.batches,
        });
      }
    } catch (repairError) {
      logService.warn("Derivation reprocess failed (sync continues)", "EmailSyncService", {
        userId,
        error: repairError instanceof Error ? repairError.message : String(repairError),
      });
    }

    // Cancelled during the repair pass — the earliest phase, and the one a user
    // is most likely to reach for the Cancel button in, because it is the part
    // that shows no mail arriving. Nothing has been fetched and (on this path)
    // no staging exists, so returning here leaves everything as it was.
    if (isCancelled()) {
      logService.info("Email pre-cache cancelled during derivation repair", "EmailSyncService", { userId });
      progressOutcome = "cancelled";
      this.lastPrecacheCompletedAt = Date.now();
      return { fetched: 0, stored: 0, cancelled: true };
    }
    }

    Sentry.addBreadcrumb({
      category: "email_precache.start",
      message: "Starting bulk email pre-cache",
      level: "info",
      data: { userId },
    });

    // Read user's cache duration preference
    const cacheDurationMonths = await getEmailCacheDurationMonths(userId);
    const cacheSinceDate = computeEmailCacheSinceDate(cacheDurationMonths);

    // Incremental: find the latest cached email timestamp.
    //
    // ---------------------------------------------------------------------
    // BACKLOG-2856 — THIS CLAMP IS WHAT A FORCE RE-CACHE HAS TO BYPASS
    // ---------------------------------------------------------------------
    // Traced, and worth stating because the item was filed against a different
    // mechanism: the thing that would make a force re-cache "delete everything
    // and then fetch almost nothing" is THIS local high-water mark, not a stored
    // Graph delta cursor. `email_sync_state.cursor` (the `{folderId: deltaLink}`
    // map) has exactly two readers, both in `shadowDeltaSyncService`, which is
    // opt-in behind `KEEPR_SHADOW_DELTA_SYNC=1` / `shadowDeltaSync.enabled` and
    // is not on this path at all — `searchEmails` / `searchAllFolders` /
    // `searchAllLabels` never consult a deltaLink.
    //
    // The failure it would cause is nonetheless exactly as bad as advertised.
    // Stage-and-swap leaves live `emails` populated for the whole rebuild, so
    // `MAX(sent_at)` still returns the newest cached row, `fetchSinceDate`
    // collapses to roughly "now", the rebuild stages next to nothing, and the
    // swap deletes the corpus and puts that nothing back in its place.
    //
    // So a force run reads from `cacheSinceDate` — the user's full configured
    // window — and the clamp is simply not applied.
    //
    // BACKLOG-3056: the bounds are read in ONE pass (`MIN`/`MAX`) and the force
    // path still reads NEITHER. `isForce ? null : …` is unchanged in meaning —
    // a force run has no high-water mark to clamp to and no gap to backfill,
    // because it re-fetches the entire configured window by construction.
    const cachedBounds = isForce ? null : getCachedEmailSentAtBounds(userId);
    let fetchSinceDate = cacheSinceDate;
    if (cachedBounds?.newest) {
      const latestCached = new Date(cachedBounds.newest);
      if (latestCached > cacheSinceDate) {
        fetchSinceDate = latestCached;
      }
    }

    // ---------------------------------------------------------------------
    // BACKLOG-3056 — THE GAP THE CLAMP ABOVE CANNOT REACH
    // ---------------------------------------------------------------------
    // The clamp only ever moves the fetch start FORWARD. So when the user
    // widens Email History — 3 months to 6 to 12 — `cacheSinceDate` travels
    // backwards, the clamp overrides it, and the run fetches from today
    // regardless. The founder measured exactly that: the configured floor moved
    // back nine months while `fetchSinceDate` never moved at all, and each run
    // reported "Cached 0 new emails" in about two seconds.
    //
    // The span between the newly-configured floor and the OLDEST row already
    // cached is mail the app has never fetched. One incremental run now asks
    // for both ranges:
    //
    //     [cacheSinceDate .. oldestCached)   this backfill
    //     [latestCached   .. now]            the usual incremental
    //
    // Backfilling rather than telling the user to press Force re-cache is the
    // founder's decision, and the reason is `communications`: a force run
    // deletes every email row and the link rows die with them by ON DELETE
    // CASCADE, so "use Force re-cache to get your own history" would unlink
    // every email from its transaction. A backfill only inserts.
    //
    // STRICTLY EARLIER, and that matters: when the floor EQUALS the oldest
    // cached row there is no gap, and a `<=` here would make every ordinary
    // re-cache issue a second, always-empty round trip per provider.
    //
    // KNOWN COST, stated rather than hidden: the gap is derived from the DATA
    // (the oldest cached row) and not from a stored "floor already swept". So a
    // mailbox holding nothing older than the configured floor — a new agent
    // with a young mailbox and a 1-year window — re-asks for that empty older
    // range on every run. Correct, but not free. Recording a durable
    // floor-of-record would remove the repeat; it adds per-user state, so it is
    // a founder decision and is deliberately not smuggled in here.
    const oldestCached = cachedBounds?.oldest ? new Date(cachedBounds.oldest) : null;
    const backfillWindow =
      oldestCached && cacheSinceDate < oldestCached
        ? { after: cacheSinceDate, before: oldestCached }
        : null;

    logService.info("Email pre-cache date range computed", "EmailSyncService", {
      cacheDurationMonths,
      cacheSinceDate: cacheSinceDate.toISOString(),
      fetchSinceDate: fetchSinceDate.toISOString(),
      isIncremental: !!cachedBounds?.newest,
      // BACKLOG-3056: this bug was found in the founder's own dev log, by
      // reading `cacheSinceDate` against `fetchSinceDate`. The gap decision is
      // logged beside them so the same reading answers "and did it backfill?".
      oldestCached: cachedBounds?.oldest ?? null,
      backfill: backfillWindow
        ? {
            after: backfillWindow.after.toISOString(),
            before: backfillWindow.before.toISOString(),
          }
        : "none",
      force: isForce,
    });

    const seenEmailIds = new Set<string>();
    let totalFetched = 0;
    let totalStored = 0;
    // BACKLOG-2127: records the FIRST auth-class provider failure so the
    // caller (SyncOrchestrator) can raise a reconnect prompt. Transient
    // (network) failures are intentionally NOT recorded here.
    let providerError:
      | { provider: "microsoft" | "google"; message: string; tokenExpired: boolean }
      | undefined;

    // Check which providers are connected
    const googleToken = await databaseService.getOAuthToken(userId, "google", "mailbox");
    const microsoftToken = await databaseService.getOAuthToken(userId, "microsoft", "mailbox");

    if (!googleToken && !microsoftToken) {
      logService.info("No email provider connected, skipping pre-cache", "EmailSyncService");
      return { fetched: 0, stored: 0 };
    }

    // BACKLOG-2856: providers this run COULD rebuild, from the connected tokens.
    // The force set starts optimistic — every connected provider — so the
    // rebuild's dedup reads treat those rows as "about to be replaced" and stage
    // their re-fetched copies. It is narrowed to the providers that actually
    // finished, immediately before the swap.
    const connectedProviders: EmailForceProvider[] = [
      ...(microsoftToken ? (["outlook"] as const) : []),
      ...(googleToken ? (["gmail"] as const) : []),
    ];
    // A provider joins this only when its ENTIRE fetch succeeded — the inbox
    // round AND the all-folders/all-labels round. A partial fetch must not
    // delete that provider's live rows; see `restrictForceSetToRebuiltProviders`.
    const rebuiltProviders: EmailForceProvider[] = [];

    if (isForce) {
      const db = getRawDatabase();
      const swept = sweepStaleEmailStaging(db);
      if (swept.length > 0) {
        logService.info("Dropped stale email force-recache staging tables", "EmailSyncService", {
          tables: swept.length,
        });
      }
      forceStaging = emailForceStagingLifecycle.create(db, {
        userId,
        forceSet: buildEmailForceSet({
          userId,
          providers: connectedProviders,
          cacheSinceIso: cacheSinceDate.toISOString(),
        }),
      });
      logService.info("Email force re-cache staging created", "EmailSyncService", {
        userId,
        providers: connectedProviders,
        cacheSince: cacheSinceDate.toISOString(),
      });
    }

    // Cancelled before any provider was contacted. On a force run the staging
    // tables exist by now; the `finally` drops them, and live was never touched.
    if (isCancelled()) {
      logService.info("Email pre-cache cancelled before fetching", "EmailSyncService", { userId });
      progressOutcome = "cancelled";
      this.lastPrecacheCompletedAt = Date.now();
      return { fetched: 0, stored: 0, cancelled: true };
    }

    emitProgress({
      phase: "fetching",
      current: 0,
      total: 0,
      percent: EMAIL_PRECACHE_PERCENT.FETCH_START,
    });

    // Fetch from Outlook (no contact filter = all emails)
    if (microsoftToken && !isCancelled()) {
      try {
        await retryOnNetwork(async () => {
          const outlookReady = await outlookFetchService.initialize(userId);
          if (outlookReady) {
            // Fetch inbox emails (no contact filter fetches all)
            const inboxResult = await fetchStoreAndDedup({
              provider: "outlook",
              fetchFn: () => outlookFetchService.searchEmails({
                maxResults: EMAIL_FETCH_SAFETY_CAP,
                after: fetchSinceDate,
                // BACKLOG-2856: the signal reaches the paging loop and the HTTP
                // request, not just the boundary check above.
                signal: abort.signal,
              }),
              userId,
              seenIds: seenEmailIds,
              getAttachmentsFn: (msgId) => outlookFetchService.getAttachments(msgId),
              force: forceStaging ?? undefined,
            });

            // Also search all folders (sent, archives, custom folders)
            let allFolderResult = { fetched: 0, stored: 0, errors: 0 };
            // BACKLOG-2856: a force run may only delete Outlook's live rows if
            // it re-fetched ALL of them. The all-folders round is most of the
            // mailbox (sent, archives, custom folders), so a failure here means
            // this run holds the inbox and little else — deleting the rest would
            // trim the corpus to whatever arrived before the failure.
            let allFoldersComplete = true;
            // BACKLOG-2856: a cancel between the two Outlook rounds skips the
            // second one AND withholds the rebuilt mark. The pre-swap checkpoint
            // would stop the swap anyway; withholding the mark means that even
            // if it were ever removed, a half-fetched Outlook could not license
            // deleting Outlook's live rows.
            if (isCancelled()) allFoldersComplete = false;
            try {
              if (!isCancelled()) {
              allFolderResult = await fetchStoreAndDedup({
                provider: "outlook",
                fetchFn: () => outlookFetchService.searchAllFolders({
                  maxResults: EMAIL_FETCH_SAFETY_CAP,
                  after: fetchSinceDate,
                  // BACKLOG-2856: THE call the founder's 28.3 seconds were spent
                  // inside. It walks every folder under one await; without the
                  // signal the next boundary check below is unreachable until it
                  // has finished.
                  signal: abort.signal,
                }),
                userId,
                seenIds: seenEmailIds,
                getAttachmentsFn: (msgId) => outlookFetchService.getAttachments(msgId),
                force: forceStaging ?? undefined,
              });
              }
            } catch (folderError) {
              if (isNetworkError(folderError)) throw folderError;
              allFoldersComplete = false;
              logService.warn("Pre-cache: all-folders fetch failed, continuing", "EmailSyncService", {
                error: folderError instanceof Error ? folderError.message : "Unknown",
              });
            }

            if (allFoldersComplete && !rebuiltProviders.includes("outlook")) {
              rebuiltProviders.push("outlook");
            }

            totalFetched += inboxResult.fetched + allFolderResult.fetched;
            totalStored += inboxResult.stored + allFolderResult.stored;

            logService.info("Outlook pre-cache complete", "EmailSyncService", {
              inboxFetched: inboxResult.fetched,
              allFoldersFetched: allFolderResult.fetched,
              totalStored: inboxResult.stored + allFolderResult.stored,
            });
          }
        }, undefined, "OutlookPrecache");
      } catch (outlookError) {
        logService.warn("Outlook pre-cache failed", "EmailSyncService", {
          error: outlookError instanceof Error ? outlookError.message : "Unknown",
        });
        // BACKLOG-2127: surface auth-class (expired/revoked token) failures so
        // the sync UI can prompt a reconnect. Transient/network errors are left
        // unrecorded so the sync still completes green (AC).
        if (isTokenExpiryError(outlookError) && !providerError) {
          providerError = {
            provider: "microsoft",
            message: classifyProviderError(outlookError),
            tokenExpired: true,
          };
        }
        // Don't fail entirely; continue to Gmail
      }
    }

    emitProgress({
      phase: "fetching",
      current: totalFetched,
      total: totalFetched,
      percent: EMAIL_PRECACHE_PERCENT.FETCH_SECOND_PROVIDER,
    });

    // Fetch from Gmail (no contact filter = all emails).
    // Skipped outright if the user cancelled during the Outlook round — a cancel
    // must stop the NEXT unit of work, not merely stop the current one early.
    if (googleToken && !isCancelled()) {
      try {
        await retryOnNetwork(async () => {
          const gmailReady = await gmailFetchService.initialize(userId);
          if (gmailReady) {
            const gmailResult = await fetchStoreAndDedup({
              provider: "gmail",
              fetchFn: () => gmailFetchService.searchEmails({
                maxResults: EMAIL_FETCH_SAFETY_CAP,
                after: fetchSinceDate,
                signal: abort.signal,
              }),
              userId,
              seenIds: seenEmailIds,
              force: forceStaging ?? undefined,
            });

            // Also search all labels (archives, custom labels)
            let allLabelResult = { fetched: 0, stored: 0, errors: 0 };
            // BACKLOG-2856: same rule as Outlook's all-folders round — a partial
            // Gmail fetch must not license deleting Gmail's live rows.
            let allLabelsComplete = true;
            // Same rule as Outlook's rounds above.
            if (isCancelled()) allLabelsComplete = false;
            try {
              if (!isCancelled()) {
              allLabelResult = await fetchStoreAndDedup({
                provider: "gmail",
                fetchFn: () => gmailFetchService.searchAllLabels({
                  maxResults: EMAIL_FETCH_SAFETY_CAP,
                  after: fetchSinceDate,
                  signal: abort.signal,
                }),
                userId,
                seenIds: seenEmailIds,
                force: forceStaging ?? undefined,
              });
              }
            } catch (labelError) {
              if (isNetworkError(labelError)) throw labelError;
              allLabelsComplete = false;
              logService.warn("Pre-cache: all-labels fetch failed, continuing", "EmailSyncService", {
                error: labelError instanceof Error ? labelError.message : "Unknown",
              });
            }

            if (allLabelsComplete && !rebuiltProviders.includes("gmail")) {
              rebuiltProviders.push("gmail");
            }

            totalFetched += gmailResult.fetched + allLabelResult.fetched;
            totalStored += gmailResult.stored + allLabelResult.stored;

            logService.info("Gmail pre-cache complete", "EmailSyncService", {
              searchFetched: gmailResult.fetched,
              allLabelsFetched: allLabelResult.fetched,
              totalStored: gmailResult.stored + allLabelResult.stored,
            });
          }
        }, undefined, "GmailPrecache");
      } catch (gmailError) {
        logService.warn("Gmail pre-cache failed", "EmailSyncService", {
          error: gmailError instanceof Error ? gmailError.message : "Unknown",
        });
        // BACKLOG-2127: surface auth-class Gmail failures symmetrically.
        if (isTokenExpiryError(gmailError) && !providerError) {
          providerError = {
            provider: "google",
            message: classifyProviderError(gmailError),
            tokenExpired: true,
          };
        }
      }
    }

    // -------------------------------------------------------------------
    // BACKLOG-3056 — THE BACKFILL ROUND: [cacheSinceDate .. oldestCached)
    // -------------------------------------------------------------------
    // Everything above fetched forward from the high-water mark. This fetches
    // the span the widened Email History setting just opened up BEHIND the
    // cache, which the clamp can never reach.
    //
    // SECOND, NOT FIRST. New mail is what the user sees on the screen they
    // pressed the button from, and a backfill over a year of history is the
    // long part of the run. Running it after the incremental rounds means a
    // cancel half way through the backfill still leaves today's mail cached.
    //
    // NON-FORCE ONLY, structurally: `backfillWindow` is derived from
    // `cachedBounds`, and `cachedBounds` is null on a force run. Nothing here
    // touches `forceStaging` or `rebuiltProviders` — a force run's rebuilt set
    // must describe the FULL-window rounds above and nothing else.
    //
    // Rounds mirror the incremental ones exactly (inbox + all folders, search +
    // all labels), because the coverage question is identical; only the window
    // differs. `before` is inclusive on Graph (`receivedDateTime le`) and
    // exclusive on Gmail (`before:` epoch seconds), so Outlook may hand back the
    // oldest already-cached message again — `fetchStoreAndDedup` recognises it
    // as a duplicate and stores nothing. That asymmetry is provider behaviour,
    // not a bound to "fix" here.
    if (backfillWindow && !isCancelled()) {
      logService.info("Email pre-cache backfilling the widened window", "EmailSyncService", {
        userId,
        after: backfillWindow.after.toISOString(),
        before: backfillWindow.before.toISOString(),
      });

      // Progress holds at the same percent while `current` climbs — the idiom
      // the repair pass already uses. The bar must not go backwards, and a
      // backfill over a year of mail must not look like a frozen run.
      emitProgress({
        phase: "fetching",
        current: totalFetched,
        total: totalFetched,
        percent: EMAIL_PRECACHE_PERCENT.FETCH_SECOND_PROVIDER,
      });

      if (microsoftToken && !isCancelled()) {
        try {
          await retryOnNetwork(async () => {
            const outlookReady = await outlookFetchService.initialize(userId);
            if (!outlookReady) return;

            const inboxBackfill = await fetchStoreAndDedup({
              provider: "outlook",
              fetchFn: () => outlookFetchService.searchEmails({
                maxResults: EMAIL_FETCH_SAFETY_CAP,
                after: backfillWindow.after,
                before: backfillWindow.before,
                signal: abort.signal,
              }),
              userId,
              seenIds: seenEmailIds,
              getAttachmentsFn: (msgId) => outlookFetchService.getAttachments(msgId),
            });

            let folderBackfill = { fetched: 0, stored: 0, errors: 0 };
            try {
              if (!isCancelled()) {
                folderBackfill = await fetchStoreAndDedup({
                  provider: "outlook",
                  fetchFn: () => outlookFetchService.searchAllFolders({
                    maxResults: EMAIL_FETCH_SAFETY_CAP,
                    after: backfillWindow.after,
                    before: backfillWindow.before,
                    signal: abort.signal,
                  }),
                  userId,
                  seenIds: seenEmailIds,
                  getAttachmentsFn: (msgId) => outlookFetchService.getAttachments(msgId),
                });
              }
            } catch (folderError) {
              if (isNetworkError(folderError)) throw folderError;
              // A failed backfill sweep costs the user history, never their
              // cache: nothing has been deleted, and the next run recomputes
              // the same gap and tries again.
              logService.warn("Pre-cache backfill: all-folders fetch failed, continuing", "EmailSyncService", {
                error: folderError instanceof Error ? folderError.message : "Unknown",
              });
            }

            totalFetched += inboxBackfill.fetched + folderBackfill.fetched;
            totalStored += inboxBackfill.stored + folderBackfill.stored;

            logService.info("Outlook window backfill complete", "EmailSyncService", {
              inboxFetched: inboxBackfill.fetched,
              allFoldersFetched: folderBackfill.fetched,
              totalStored: inboxBackfill.stored + folderBackfill.stored,
            });
          }, undefined, "OutlookBackfill");
        } catch (outlookError) {
          logService.warn("Outlook window backfill failed", "EmailSyncService", {
            error: outlookError instanceof Error ? outlookError.message : "Unknown",
          });
          if (isTokenExpiryError(outlookError) && !providerError) {
            providerError = {
              provider: "microsoft",
              message: classifyProviderError(outlookError),
              tokenExpired: true,
            };
          }
        }
      }

      if (googleToken && !isCancelled()) {
        try {
          await retryOnNetwork(async () => {
            const gmailReady = await gmailFetchService.initialize(userId);
            if (!gmailReady) return;

            const searchBackfill = await fetchStoreAndDedup({
              provider: "gmail",
              fetchFn: () => gmailFetchService.searchEmails({
                maxResults: EMAIL_FETCH_SAFETY_CAP,
                after: backfillWindow.after,
                before: backfillWindow.before,
                signal: abort.signal,
              }),
              userId,
              seenIds: seenEmailIds,
            });

            let labelBackfill = { fetched: 0, stored: 0, errors: 0 };
            try {
              if (!isCancelled()) {
                labelBackfill = await fetchStoreAndDedup({
                  provider: "gmail",
                  fetchFn: () => gmailFetchService.searchAllLabels({
                    maxResults: EMAIL_FETCH_SAFETY_CAP,
                    after: backfillWindow.after,
                    before: backfillWindow.before,
                    signal: abort.signal,
                  }),
                  userId,
                  seenIds: seenEmailIds,
                });
              }
            } catch (labelError) {
              if (isNetworkError(labelError)) throw labelError;
              logService.warn("Pre-cache backfill: all-labels fetch failed, continuing", "EmailSyncService", {
                error: labelError instanceof Error ? labelError.message : "Unknown",
              });
            }

            totalFetched += searchBackfill.fetched + labelBackfill.fetched;
            totalStored += searchBackfill.stored + labelBackfill.stored;

            logService.info("Gmail window backfill complete", "EmailSyncService", {
              searchFetched: searchBackfill.fetched,
              allLabelsFetched: labelBackfill.fetched,
              totalStored: searchBackfill.stored + labelBackfill.stored,
            });
          }, undefined, "GmailBackfill");
        } catch (gmailError) {
          logService.warn("Gmail window backfill failed", "EmailSyncService", {
            error: gmailError instanceof Error ? gmailError.message : "Unknown",
          });
          if (isTokenExpiryError(gmailError) && !providerError) {
            providerError = {
              provider: "google",
              message: classifyProviderError(gmailError),
              tokenExpired: true,
            };
          }
        }
      }
    }

    emitProgress({
      phase: "fetching",
      current: totalFetched,
      total: totalFetched,
      percent: EMAIL_PRECACHE_PERCENT.FETCH_DONE,
    });

    // BACKLOG-1369: Attachment backfill removed from precache pipeline.
    // Attachments are now downloaded on-demand when user views email or during export.

    // -------------------------------------------------------------------
    // BACKLOG-2856 — THE SWAP. Everything above wrote to staging only.
    // -------------------------------------------------------------------
    // Reached only when the run got this far without throwing. Cancel, crash,
    // disk-full or any error above skips it entirely and the `finally` drops the
    // staging tables, which is why an interrupted force re-cache leaves live
    // exactly as it was BY CONSTRUCTION rather than by rollback.
    // THE LAST MOMENT A CANCEL CAN MEAN ANYTHING (BACKLOG-2856).
    //
    // Placed here, before the swap block, so it governs BOTH paths: an ordinary
    // run that was cancelled during the fetch must report `cancelled` too, not
    // fall through to the success return and tell the user it completed.
    //
    // On a force run everything above wrote to staging only, so stopping here
    // costs nothing but the download. One line further and the swap has begun;
    // past that point "cancel" would have to mean UNDO, and undoing a committed
    // swap is precisely the compensating-rollback design that stage-and-swap was
    // adopted to get rid of. So the signal is consulted here and never again: a
    // cancel arriving during or after the swap is too late, and the run reports
    // the success it actually achieved.
    if (isCancelled()) {
      logService.info(
        "Email pre-cache cancelled before the swap — the email store was never touched",
        "EmailSyncService",
        { userId, staged: totalStored, force: isForce },
      );
      progressOutcome = "cancelled";
      this.lastPrecacheCompletedAt = Date.now();
      return { fetched: totalFetched, stored: totalStored, cancelled: true };
    }

    if (isForce && forceStaging) {
      emitProgress({
        phase: "swapping",
        current: totalFetched,
        total: totalFetched,
        percent: EMAIL_PRECACHE_PERCENT.SWAPPING,
      });

      const db = getRawDatabase();
      const restricted = restrictForceSetToRebuiltProviders(
        db,
        forceStaging,
        rebuiltProviders,
        cacheSinceDate.toISOString(),
      );

      if (!restricted) {
        // No provider finished a rebuild, so there is nothing to put back and a
        // swap would be a pure deletion. Reported as an error rather than a
        // green "0 re-cached", which is the BACKLOG-2127 lesson: a run that
        // achieved nothing must not look like a run that found nothing to do.
        logService.warn("Email force re-cache: no provider rebuilt, skipping swap", "EmailSyncService", {
          userId,
          connectedProviders,
        });
        this.lastPrecacheCompletedAt = Date.now();
        return {
          fetched: totalFetched,
          stored: totalStored,
          providerError,
          error: "Re-cache could not complete for any connected mailbox. Nothing was changed.",
        };
      }

      // The swap either happens completely or not at all, so a throw here means
      // the user's mail is exactly as it was. Reported as a structured error
      // rather than allowed to propagate: the caller cannot distinguish a thrown
      // precache from a crashed one, and this is the case where the single most
      // useful thing to tell the user is that NOTHING changed.
      let counts;
      try {
        counts = swapEmailStagingIntoLive(db, forceStaging, {
          persistAttachmentMeta: (meta) => databaseService.upsertEmailAttachmentMetadata(meta),
        });
      } catch (swapError) {
        logService.error("Email force re-cache swap failed; nothing was changed", "EmailSyncService", {
          userId,
          error: swapError instanceof Error ? swapError.message : String(swapError),
        });
        Sentry.captureException(swapError);
        this.lastPrecacheCompletedAt = Date.now();
        return {
          fetched: totalFetched,
          stored: totalStored,
          providerError,
          error: "Re-cache could not be applied. Your emails were left unchanged.",
        };
      }

      forceSwap = {
        emailsDeleted: counts.emailsDeleted,
        emailsInserted: counts.emailsInserted,
        participantsInserted: counts.participantsInserted,
        providers: [...rebuiltProviders],
      };

      // The shadow delta engine's bookmark describes a mailbox state that no
      // longer exists on this side: every row it had seen has just been replaced
      // under a new local id. Clearing it makes its next round start over, which
      // is the honest reading of "re-cache". Best-effort — the shadow engine is
      // opt-in and comparison-only, so it must never fail a real re-cache.
      try {
        this.clearShadowDeltaCursors(userId);
      } catch (cursorError) {
        logService.warn("Email force re-cache: could not clear shadow delta cursor", "EmailSyncService", {
          error: cursorError instanceof Error ? cursorError.message : String(cursorError),
        });
      }

      logService.info("Email force re-cache swap complete", "EmailSyncService", {
        userId,
        ...forceSwap,
        resurrectionsRepaired: counts.resurrectionsRepaired,
        attachmentMetaApplied: counts.attachmentMetaApplied,
      });
      Sentry.addBreadcrumb({
        category: "email_precache.force_swap",
        message: `Force re-cache swap: ${counts.emailsDeleted} deleted, ${counts.emailsInserted} inserted`,
        level: "info",
        data: forceSwap,
      });
    }

    // The terminal event is emitted once, from the `finally` — not here — so
    // that every exit path gets exactly one and no path can be added later that
    // forgets it. Marking the outcome is all this line has to do.
    progressOutcome = "success";

    logService.info("Email pre-cache complete", "EmailSyncService", {
      totalFetched,
      totalStored,
      userId,
    });

    Sentry.addBreadcrumb({
      category: "email_precache.complete",
      message: `Email pre-cache complete: ${totalFetched} fetched, ${totalStored} stored`,
      level: "info",
      data: { totalFetched, totalStored },
    });

    this.lastPrecacheCompletedAt = Date.now();
    return { fetched: totalFetched, stored: totalStored, providerError, forceSwap };
    } finally {
      this.precacheInProgress = false;
      this.precacheAbortController = null;

      // BACKLOG-2856 — THE ONE TERMINAL PROGRESS EVENT, on every exit path.
      //
      // Success, a structured error return, a thrown failure, a cancel: all of
      // them land here, so the bar cannot be stranded at whatever fraction it
      // last saw. That is the failure the messages importer's explicit final
      // 100% exists to prevent, arrived at from the other side — instead of one
      // emission per happy path, one emission for all paths.
      //
      // `percent` reaches 100 only when `progressOutcome` is "success"; a cancel
      // or an error reports the last percent actually reached and settles the UI
      // by `phase: "done"`.
      onProgress?.(terminalProgress(progressOutcome, progressCurrent, lastPercent));
      // BACKLOG-2856: the one cleanup that runs on EVERY exit path — success,
      // early return, thrown error, cancellation. On the success path the swap
      // has already consumed these tables; on every other path dropping them is
      // what makes the interrupted run a no-op against live.
      if (forceStaging) {
        try {
          forceStaging.drop();
        } catch (dropError) {
          // Left behind, not fatal: nothing else reads these tables, and the next
          // force run's `sweepStaleEmailStaging` reclaims them.
          logService.warn("Could not drop email force-recache staging", "EmailSyncService", {
            error: dropError instanceof Error ? dropError.message : String(dropError),
          });
        }
      }
    }
  }

  /**
   * BACKLOG-2856: reset the shadow delta engine's per-folder bookmarks for this
   * user, so its next round re-reads the mailbox instead of asking "what changed
   * since a state that no longer exists".
   *
   * Best-effort and deliberately narrow: it writes `email_sync_state.cursor`,
   * which no other feature reads (`shadowDeltaSyncService` is its only consumer
   * and is opt-in behind a flag). It is NOT what makes a force re-cache re-fetch
   * — that is the high-water-mark bypass above — so a failure here is logged and
   * swallowed rather than allowed to fail the run.
   */
  private clearShadowDeltaCursors(userId: string): void {
    dbRun(
      `UPDATE email_sync_state SET cursor = NULL, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
      [userId],
    );
  }

  /**
   * Fetch emails from Outlook (inbox, sent items, all folders) with network resilience.
   */
  private async fetchOutlookEmails(params: {
    userId: string;
    transactionId: string;
    contactEmails: string[];
    emailFetchSinceDate: Date;
    // BACKLOG-1802: optional upper date bound for backfill/forward delta windowing.
    emailFetchBeforeDate?: Date | null;
    seenEmailIds: Set<string>;
    // BACKLOG-1802: 'manual' when the user clicked Sync Emails (tags ingest_source).
    ingestSourceOverride?: "manual";
  }): Promise<{ fetched: number; stored: number; duplicates: number; networkError: boolean; networkErrorMessage?: string; providerError?: string }> {
    const { userId, transactionId, contactEmails, emailFetchSinceDate, emailFetchBeforeDate, seenEmailIds, ingestSourceOverride } = params;
    let fetched = 0;
    let stored = 0;
    // BACKLOG-1831: cache HITS (dupes/resurrections) aggregated across inbox/sent/all-folders.
    let duplicates = 0;

    Sentry.addBreadcrumb({
      category: 'email_sync.start',
      message: 'Starting outlook email sync',
      level: 'info',
      data: {
        syncType: 'emails',
        provider: 'outlook',
        operation: 'sync-and-fetch-emails',
        transactionId,
        contactCount: contactEmails.length,
        dateRange: { after: emailFetchSinceDate?.toISOString() },
      },
    });

    try {
      await retryOnNetwork(async () => {
        const outlookReady = await outlookFetchService.initialize(userId);
        if (outlookReady) {
          // TASK-2060: Fetch inbox emails with date-range filtering via shared helper
          const inboxResult = await fetchStoreAndDedup({
            provider: "outlook",
            fetchFn: () => outlookFetchService.searchEmails({
              contactEmails,
              maxResults: EMAIL_FETCH_SAFETY_CAP,
              after: emailFetchSinceDate,
              before: emailFetchBeforeDate ?? null,
            }),
            userId,
            seenIds: seenEmailIds,
            ingestSourceOverride,
            getAttachmentsFn: (msgId) => outlookFetchService.getAttachments(msgId),
          });

          // TASK-2060: Fetch sent items with date-range filtering via shared helper
          const sentResult = await fetchStoreAndDedup({
            provider: "outlook",
            fetchFn: () => outlookFetchService.searchSentEmailsToContacts(
              contactEmails,
              SENT_ITEMS_SAFETY_CAP,
              emailFetchSinceDate,
              emailFetchBeforeDate ?? null,
            ),
            userId,
            seenIds: seenEmailIds,
            ingestSourceOverride,
            getAttachmentsFn: (msgId) => outlookFetchService.getAttachments(msgId),
          });

          // TASK-2046: Also fetch from all folders (custom folders, archives, etc.)
          let allFolderResult = { fetched: 0, stored: 0, errors: 0, duplicates: 0 };
          try {
            allFolderResult = await fetchStoreAndDedup({
              provider: "outlook",
              fetchFn: () => outlookFetchService.searchAllFolders({
                maxResults: EMAIL_FETCH_SAFETY_CAP,
                after: emailFetchSinceDate,
                before: emailFetchBeforeDate ?? null,
              }),
              userId,
              seenIds: seenEmailIds,
              ingestSourceOverride,
              getAttachmentsFn: (msgId) => outlookFetchService.getAttachments(msgId),
            });
            logService.info(`Fetched ${allFolderResult.fetched} emails from all Outlook folders`, "Transactions");
          } catch (folderError) {
            // TASK-2049: If folder fetch fails due to network, let it bubble up for retry
            if (isNetworkError(folderError)) throw folderError;
            logService.warn("Failed to fetch from all Outlook folders, continuing with inbox/sent only", "Transactions", {
              error: folderError instanceof Error ? folderError.message : "Unknown",
            });
          }

          const totalFetched = inboxResult.fetched + sentResult.fetched + allFolderResult.fetched;
          const totalStored = inboxResult.stored + sentResult.stored + allFolderResult.stored;
          fetched += totalFetched;
          stored += totalStored;
          // BACKLOG-1831: aggregate cache hits across the three Outlook sources.
          duplicates += inboxResult.duplicates + sentResult.duplicates + allFolderResult.duplicates;

          logService.info(`Outlook sync: ${inboxResult.fetched} inbox + ${sentResult.fetched} sent + ${allFolderResult.fetched} all-folders = ${totalFetched} unique, ${totalStored} new stored`, "Transactions");

          // TASK-2060: Warn if safety cap was hit (may indicate missing emails)
          if (inboxResult.fetched >= EMAIL_FETCH_SAFETY_CAP) {
            logService.warn(`Outlook inbox fetch hit safety cap of ${EMAIL_FETCH_SAFETY_CAP}. Some emails may be missing.`, "Transactions");
          }
        }
      }, undefined, "OutlookSync");

      Sentry.addBreadcrumb({
        category: 'sync',
        message: 'Outlook email fetch completed',
        level: 'info',
        data: {
          syncType: 'emails',
          provider: 'outlook',
          operation: 'sync-and-fetch-emails',
          emailsFetched: fetched,
          emailsStored: stored,
        },
      });

      return { fetched, stored, duplicates, networkError: false };
    } catch (outlookError) {
      // TASK-2273: Structured failure reporting for all Outlook sync errors
      const reason = classifyEmailSyncError(outlookError);
      Sentry.captureMessage(`Email sync failed: ${reason}`, {
        level: reason === "rate_limited" ? "warning" : "error",
        tags: {
          component: "email_sync",
          provider: "outlook",
          failureReason: reason,
        },
        extra: {
          emailsFetchedSoFar: fetched,
          expectedTotal: EMAIL_FETCH_SAFETY_CAP,
          errorMessage: outlookError instanceof Error ? outlookError.message : String(outlookError),
          responseStatus: (outlookError as any)?.response?.status,
        },
      });

      if (isNetworkError(outlookError)) {
        // TASK-2049: Network error after all retries exhausted
        networkResilienceService.recordPartialSync(userId, "outlook", stored);
        logService.warn("Outlook sync failed due to network disconnect after retries", "Transactions", {
          emailsStoredBeforeFailure: stored,
          error: outlookError instanceof Error ? outlookError.message : "Unknown",
        });
        // TASK-2058: Log failure for offline diagnostics
        failureLogService.logFailure(
          "outlook_email_fetch",
          outlookError instanceof Error ? outlookError.message : "Unknown error",
          { emailsStoredBeforeFailure: stored }
        );
        return {
          fetched,
          stored,
          duplicates,
          networkError: true,
          networkErrorMessage: "Network disconnected during Outlook sync. Emails saved so far will be preserved.",
        };
      } else {
        const errorMsg = outlookError instanceof Error ? outlookError.message : "";
        if (errorMsg.includes("needs to connect")) {
          // Provider not configured — skip silently (not a provider error)
          logService.info("Outlook not connected, skipping", "Transactions");
          return { fetched, stored, duplicates, networkError: false };
        } else {
          // TASK-2070: Non-network provider error (token expiry, API error, etc.)
          logService.warn("Outlook fetch failed, falling back to local search", "Transactions", {
            error: errorMsg || "Unknown",
          });
          Sentry.captureException(outlookError, {
            tags: { service: "email-sync", operation: "provider-fetch", provider: "outlook" },
            level: "warning",
            fingerprint: ["provider-fetch-failure", "outlook"],
          });
        }
      }
      // TASK-2058: Log failure for offline diagnostics
      failureLogService.logFailure(
        "outlook_email_fetch",
        outlookError instanceof Error ? outlookError.message : "Unknown error",
        { emailsStoredBeforeFailure: stored }
      );
      // TASK-2070: Return classified provider error for UI warning
      return { fetched, stored, duplicates, networkError: false, providerError: classifyProviderError(outlookError) };
    }
  }

  /**
   * Fetch emails from Gmail (search, all labels) with network resilience.
   */
  private async fetchGmailEmails(params: {
    userId: string;
    transactionId: string;
    contactEmails: string[];
    emailFetchSinceDate: Date;
    // BACKLOG-1802: optional upper date bound for backfill/forward delta windowing.
    emailFetchBeforeDate?: Date | null;
    seenEmailIds: Set<string>;
    currentEmailsStored: number;
    // BACKLOG-1802: 'manual' when the user clicked Sync Emails (tags ingest_source).
    ingestSourceOverride?: "manual";
  }): Promise<{ fetched: number; stored: number; duplicates: number; networkError: boolean; networkErrorMessage?: string; providerError?: string }> {
    const { userId, transactionId, contactEmails, emailFetchSinceDate, emailFetchBeforeDate, seenEmailIds, currentEmailsStored, ingestSourceOverride } = params;
    let fetched = 0;
    let stored = 0;
    // BACKLOG-1831: cache HITS (dupes/resurrections) aggregated across contact-search + all-labels.
    let duplicates = 0;

    Sentry.addBreadcrumb({
      category: 'email_sync.start',
      message: 'Starting gmail email sync',
      level: 'info',
      data: {
        syncType: 'emails',
        provider: 'gmail',
        operation: 'sync-and-fetch-emails',
        transactionId,
        contactCount: contactEmails.length,
        dateRange: { after: emailFetchSinceDate?.toISOString() },
      },
    });

    try {
      await retryOnNetwork(async () => {
        const gmailReady = await gmailFetchService.initialize(userId);
        if (gmailReady) {
          // TASK-2060: Fetch contact emails with date-range filtering via shared helper
          const gmailResult = await fetchStoreAndDedup({
            provider: "gmail",
            fetchFn: () => {
              const gmailSearchOptions: { query?: string; maxResults: number; contactEmails?: string[]; after?: Date | null; before?: Date | null } = {
                maxResults: EMAIL_FETCH_SAFETY_CAP,
                after: emailFetchSinceDate,
                before: emailFetchBeforeDate ?? null,
              };
              if (contactEmails.length > 0) {
                // Use contactEmails param -- gmailFetchService.searchEmails builds bidirectional filter
                gmailSearchOptions.contactEmails = contactEmails;
              }
              return gmailFetchService.searchEmails(gmailSearchOptions);
            },
            userId,
            seenIds: seenEmailIds,
            ingestSourceOverride,
          });

          // TASK-2046: Also fetch from all labels (custom labels, archives, etc.)
          let allLabelResult = { fetched: 0, stored: 0, errors: 0, duplicates: 0 };
          try {
            allLabelResult = await fetchStoreAndDedup({
              provider: "gmail",
              fetchFn: () => gmailFetchService.searchAllLabels({
                maxResults: EMAIL_FETCH_SAFETY_CAP,
                after: emailFetchSinceDate,
                before: emailFetchBeforeDate ?? null,
              }),
              userId,
              seenIds: seenEmailIds,
              ingestSourceOverride,
            });
            logService.info(`Fetched ${allLabelResult.fetched} emails from all Gmail labels`, "Transactions");
          } catch (labelError) {
            // TASK-2049: If label fetch fails due to network, let it bubble up for retry
            if (isNetworkError(labelError)) throw labelError;
            logService.warn("Failed to fetch from all Gmail labels, continuing with default search only", "Transactions", {
              error: labelError instanceof Error ? labelError.message : "Unknown",
            });
          }

          const totalFetched = gmailResult.fetched + allLabelResult.fetched;
          const totalStored = gmailResult.stored + allLabelResult.stored;
          fetched += totalFetched;
          stored += totalStored;
          // BACKLOG-1831: aggregate cache hits across the two Gmail sources.
          duplicates += gmailResult.duplicates + allLabelResult.duplicates;

          logService.info(`Gmail sync: ${gmailResult.fetched} contact-search + ${allLabelResult.fetched} all-labels = ${totalFetched} unique, ${totalStored} new stored`, "Transactions");

          // TASK-2060: Warn if safety cap was hit (may indicate missing emails)
          if (gmailResult.fetched >= EMAIL_FETCH_SAFETY_CAP) {
            logService.warn(`Gmail contact-search hit safety cap of ${EMAIL_FETCH_SAFETY_CAP}. Some emails may be missing.`, "Transactions");
          }
        }
      }, undefined, "GmailSync");

      Sentry.addBreadcrumb({
        category: 'sync',
        message: 'Gmail email fetch completed',
        level: 'info',
        data: {
          syncType: 'emails',
          provider: 'gmail',
          operation: 'sync-and-fetch-emails',
          emailsFetched: fetched,
          emailsStored: stored,
        },
      });

      return { fetched, stored, duplicates, networkError: false };
    } catch (gmailError) {
      const totalStored = currentEmailsStored + stored;
      // TASK-2273: Structured failure reporting for all Gmail sync errors
      const reason = classifyEmailSyncError(gmailError);
      Sentry.captureMessage(`Email sync failed: ${reason}`, {
        level: reason === "rate_limited" ? "warning" : "error",
        tags: {
          component: "email_sync",
          provider: "gmail",
          failureReason: reason,
        },
        extra: {
          emailsFetchedSoFar: fetched,
          expectedTotal: EMAIL_FETCH_SAFETY_CAP,
          errorMessage: gmailError instanceof Error ? gmailError.message : String(gmailError),
          responseStatus: (gmailError as any)?.response?.status,
        },
      });
      if (isNetworkError(gmailError)) {
        // TASK-2049: Network error after all retries exhausted
        networkResilienceService.recordPartialSync(userId, "gmail", totalStored);
        logService.warn("Gmail sync failed due to network disconnect after retries", "Transactions", {
          emailsStoredBeforeFailure: totalStored,
          error: gmailError instanceof Error ? gmailError.message : "Unknown",
        });
        // TASK-2058: Log failure for offline diagnostics
        failureLogService.logFailure(
          "gmail_email_fetch",
          gmailError instanceof Error ? gmailError.message : "Unknown error",
          { emailsStoredBeforeFailure: totalStored }
        );
        return {
          fetched,
          stored,
          duplicates,
          networkError: true,
          networkErrorMessage: "Network disconnected during Gmail sync. Emails saved so far will be preserved.",
        };
      } else {
        const errorMsg = gmailError instanceof Error ? gmailError.message : "";
        if (errorMsg.includes("needs to connect")) {
          // Provider not configured — skip silently (not a provider error)
          logService.info("Gmail not connected, skipping", "Transactions");
          return { fetched, stored, duplicates, networkError: false };
        } else {
          // TASK-2070: Non-network provider error (token expiry, API error, etc.)
          logService.warn("Gmail fetch failed, falling back to local search", "Transactions", {
            error: errorMsg || "Unknown",
          });
          Sentry.captureException(gmailError, {
            tags: { service: "email-sync", operation: "provider-fetch", provider: "gmail" },
            level: "warning",
            fingerprint: ["provider-fetch-failure", "gmail"],
          });
        }
      }
      // TASK-2058: Log failure for offline diagnostics
      failureLogService.logFailure(
        "gmail_email_fetch",
        gmailError instanceof Error ? gmailError.message : "Unknown error",
        { emailsStoredBeforeFailure: totalStored }
      );
      // TASK-2070: Return classified provider error for UI warning
      return { fetched, stored, duplicates, networkError: false, providerError: classifyProviderError(gmailError) };
    }
  }
}

// Export singleton instance
const emailSyncService = new EmailSyncService();
export default emailSyncService;
