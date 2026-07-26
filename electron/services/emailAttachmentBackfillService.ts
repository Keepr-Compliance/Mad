/**
 * Email Attachment METADATA Backfill (BACKLOG-2250)
 *
 * BACKLOG-1870 persists attachment metadata (filename / mime / size) at sync time,
 * but ONLY for newly-synced emails. Emails synced BEFORE 1870 have no rows in the
 * `attachments` table until a user opens the attachment, so **filename search does
 * not find attachments on already-synced mail** (SR flagged this as a forward-only
 * coverage gap on PR #2057).
 *
 * This is the one-time, idempotent, metadata-ONLY backfill that closes that gap:
 * for existing emails with `has_attachments` and zero attachment rows, it fetches
 * attachment metadata (filename / mime / size) — never the file bytes — and
 * populates `attachments` via the SAME idempotent path the sync uses
 * ({@link databaseService.upsertEmailAttachmentMetadata}).
 *
 * Guarantees:
 *   - No file bytes are downloaded. Outlook uses `getAttachments` ($select=id,name,
 *     contentType,size → Graph omits `contentBytes`); Gmail uses `getEmailById`
 *     (format=full parses attachment part metadata — the attachment BODY bytes are
 *     only fetched by a separate `attachments.get`, which is never called here).
 *   - Idempotent + safe to re-run: only emails with NO attachment rows are selected
 *     (`NOT EXISTS`), and each row is written through the upsert (keyed by
 *     email_id + filename), so repeated runs create zero duplicate rows. On-demand
 *     downloads later reconcile storage on the SAME row (see emailAttachmentService).
 *   - Bounded: at most `maxEmails` emails are processed per run (default
 *     {@link DEFAULT_MAX_EMAILS}); `remaining` reports how many still need a later
 *     run. Emails are processed sequentially so the provider fetch services' own
 *     rate-limit throttling (Gmail `_throttledCall`, Graph client) is respected.
 *   - Non-blocking: a per-email failure is logged and skipped, never aborting the run.
 *
 * Does NOT touch auto-link / matching, and requires no schema change (the
 * `attachments` metadata columns already exist from BACKLOG-1870).
 */

import * as Sentry from "@sentry/electron/main";
import databaseService from "./databaseService";
import gmailFetchService from "./gmailFetchService";
import outlookFetchService from "./outlookFetchService";
import logService from "./logService";

/** Default cap on emails processed per run (bounds provider round-trips). */
export const DEFAULT_MAX_EMAILS = 1000;

export interface AttachmentMetadataBackfillOptions {
  /** Max emails to process in a single run. Default {@link DEFAULT_MAX_EMAILS}. */
  maxEmails?: number;
}

export interface AttachmentMetadataBackfillResult {
  /** Emails still missing attachment rows at the START of this run. */
  totalMissing: number;
  /** Emails a provider metadata lookup was attempted for (provider was ready). */
  processed: number;
  /** Emails for which >= 1 attachment metadata row was upserted this run. */
  indexed: number;
  /** Total attachment metadata rows upserted (re-runs upsert 0 new rows). */
  attachments: number;
  /** Per-email failures (provider fetch or persist). */
  errors: number;
  /** Emails not attempted this run (totalMissing - fetched) — run again to drain. */
  remaining: number;
}

/** Normalized, byte-free attachment metadata. */
interface AttachmentMetaLite {
  filename: string;
  mimeType: string | null;
  size: number | null;
}

type MissingEmailRow = { id: string; external_id: string; source: string };

/**
 * Normalize a provider attachment shape into `{ filename, mimeType, size }`.
 * Gmail parses `filename`/`mimeType`/`size`; Outlook Graph carries `name`/
 * `contentType`/`size`. Entries without a usable filename are dropped because
 * `attachments.filename` is NOT NULL (and search keys on it). Filenames are
 * `.trim()`-ed to match the sync path's `normalizeAttachmentMeta`, so a later
 * on-demand download reconciles the SAME row instead of creating a duplicate.
 */
function normalizeAttachmentMeta(raw: {
  filename?: string | null;
  name?: string | null;
  mimeType?: string | null;
  contentType?: string | null;
  size?: number | null;
}): AttachmentMetaLite | null {
  const filename = (raw.filename ?? raw.name ?? "").trim();
  if (!filename) return null;
  return {
    filename,
    mimeType: raw.mimeType ?? raw.contentType ?? null,
    size: typeof raw.size === "number" ? raw.size : null,
  };
}

/**
 * Fetch attachment METADATA only (never bytes) for one email.
 * Outlook: `getAttachments` ($select — no contentBytes).
 * Gmail: `getEmailById` (format=full — parses attachment part metadata; the
 * attachment body bytes are only fetched by a separate call that is NOT made here).
 */
async function fetchAttachmentMetaOnly(
  provider: "outlook" | "gmail",
  externalId: string,
): Promise<AttachmentMetaLite[]> {
  if (provider === "outlook") {
    const graphAttachments = await outlookFetchService.getAttachments(externalId);
    return graphAttachments
      .map(normalizeAttachmentMeta)
      .filter((m): m is AttachmentMetaLite => m !== null);
  }

  const email = await gmailFetchService.getEmailById(externalId);
  return (email.attachments ?? [])
    .map(normalizeAttachmentMeta)
    .filter((m): m is AttachmentMetaLite => m !== null);
}

/**
 * Initialize the provider once for the run, then persist metadata for each of its
 * emails. If the provider is not connected/ready, its emails are left untouched for
 * a later run (not counted as errors). Mutates `result` in place.
 */
async function backfillProvider(
  userId: string,
  emails: MissingEmailRow[],
  provider: "outlook" | "gmail",
  result: AttachmentMetadataBackfillResult,
): Promise<void> {
  let ready = false;
  try {
    ready =
      provider === "outlook"
        ? await outlookFetchService.initialize(userId)
        : await gmailFetchService.initialize(userId);
  } catch (err) {
    logService.warn(
      `BACKLOG-2250: ${provider} init failed for attachment metadata backfill`,
      "Transactions",
      { error: err instanceof Error ? err.message : "Unknown" },
    );
    return;
  }
  if (!ready) return; // provider not connected — retry on a later run

  for (const email of emails) {
    result.processed++;
    try {
      const meta = await fetchAttachmentMetaOnly(provider, email.external_id);
      let upserted = 0;
      for (const m of meta) {
        databaseService.upsertEmailAttachmentMetadata({
          emailId: email.id,
          externalEmailId: email.external_id,
          filename: m.filename,
          mimeType: m.mimeType,
          fileSizeBytes: m.size,
        });
        upserted++;
      }
      if (upserted > 0) {
        result.indexed++;
        result.attachments += upserted;
      }
    } catch (err) {
      result.errors++;
      logService.warn(
        `BACKLOG-2250: ${provider} attachment metadata backfill failed for email`,
        "Transactions",
        {
          emailId: email.id,
          error: err instanceof Error ? err.message : "Unknown",
        },
      );
    }
  }
}

/**
 * BACKLOG-2250: one-time, idempotent, metadata-only attachment backfill for a user.
 * Populates `attachments` filename/mime/size (no bytes) for emails with
 * `has_attachments` and no existing attachment rows, so their filenames become
 * searchable. Safe to invoke repeatedly.
 */
export async function backfillAttachmentMetadata(
  userId: string,
  options: AttachmentMetadataBackfillOptions = {},
): Promise<AttachmentMetadataBackfillResult> {
  const maxEmails = options.maxEmails ?? DEFAULT_MAX_EMAILS;
  const result: AttachmentMetadataBackfillResult = {
    totalMissing: 0,
    processed: 0,
    indexed: 0,
    attachments: 0,
    errors: 0,
    remaining: 0,
  };

  try {
    const db = databaseService.getRawDatabase();

    // Emails with attachments but no attachment rows yet (the search gap).
    const MISSING_WHERE = `
      FROM emails e
      WHERE e.user_id = ?
        AND e.has_attachments = 1
        AND e.external_id IS NOT NULL
        AND e.source IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.email_id = e.id)
    `;

    const totalRow = db
      .prepare(`SELECT COUNT(*) AS n ${MISSING_WHERE}`)
      .get(userId) as { n: number } | undefined;
    result.totalMissing = totalRow?.n ?? 0;
    if (result.totalMissing === 0) return result;

    const emails = db
      .prepare(
        `SELECT e.id, e.external_id, e.source ${MISSING_WHERE}
         ORDER BY e.received_at DESC
         LIMIT ?`,
      )
      .all(userId, maxEmails) as MissingEmailRow[];

    result.remaining = Math.max(0, result.totalMissing - emails.length);
    if (emails.length === 0) return result;

    logService.info(
      "BACKLOG-2250: backfilling attachment metadata",
      "Transactions",
      { userId, candidates: emails.length, totalMissing: result.totalMissing },
    );

    const outlookEmails = emails.filter((e) => e.source === "outlook");
    const gmailEmails = emails.filter((e) => e.source === "gmail");

    if (outlookEmails.length > 0) {
      await backfillProvider(userId, outlookEmails, "outlook", result);
    }
    if (gmailEmails.length > 0) {
      await backfillProvider(userId, gmailEmails, "gmail", result);
    }

    logService.info(
      "BACKLOG-2250: attachment metadata backfill complete",
      "Transactions",
      { userId, ...result },
    );
  } catch (err) {
    logService.error(
      "BACKLOG-2250: attachment metadata backfill failed",
      "Transactions",
      { error: err instanceof Error ? err.message : "Unknown" },
    );
    Sentry.captureException(err, {
      tags: {
        service: "email-attachment-backfill",
        operation: "backfillAttachmentMetadata",
      },
    });
  }

  return result;
}
