/**
 * Email write planner (BACKLOG-1769)
 *
 * Pure, dependency-free decision logic for the email ingest path. Given a batch
 * of freshly-fetched emails plus lookups of what is already stored, it decides
 * which emails are brand new, which are re-deliveries of an already-stored
 * message under a NEW provider id (ghost resurrection — remap in place), and
 * which are exact duplicates.
 *
 * Extracted from emailSyncService.fetchStoreAndDedup so the resurrection logic is
 * unit-testable without pulling in native modules / provider SDKs.
 *
 * @module electron/services/emailWritePlanner
 * @see BACKLOG-1769 (Message-ID stable identity) / BACKLOG-1764 (ghost resurrection)
 */

/**
 * Minimal shape the planner needs from a fetched email.
 */
export interface PlannableEmail {
  /** Provider message id (Gmail/Outlook) — stored as emails.external_id. */
  id: string;
  /** RFC 5322 Message-ID header, when the provider supplied one. */
  messageIdHeader?: string | null;
  /** BACKLOG-1861: legacy-content forward guard — sender address (= emails.sender). */
  from?: string | null;
  /** BACKLOG-1861: legacy-content forward guard — sent timestamp (= emails.sent_at). */
  date?: Date | string | null;
  /** BACKLOG-1861: legacy-content forward guard — email subject (= emails.subject). */
  subject?: string | null;
}

/**
 * BACKLOG-1861: Compute a normalized content key for legacy-row matching.
 *
 * Used by the forward guard to match 2.19-era rows (message_id_header IS NULL)
 * against freshly-fetched 2.20 emails. Key: lowercased-trimmed subject +
 * lowercased-trimmed from + UTC-minute bucket. Returns null when any required
 * field is absent or the date is invalid.
 */
export function computeLegacyContentKey(
  subject: string | null | undefined,
  from: string | null | undefined,
  sentAt: Date | string | null | undefined,
): string | null {
  if (!subject || !from || !sentAt) return null;
  const nSubject = subject.trim().toLowerCase();
  const nFrom = from.trim().toLowerCase();
  if (!nSubject || !nFrom) return null;
  const dt = sentAt instanceof Date ? sentAt : new Date(sentAt);
  if (isNaN(dt.getTime())) return null;
  // Minute-bucket: same email fetched from the same provider always returns the
  // same timestamp. Minute granularity tolerates sub-minute formatting drift
  // without risk of collapsing distinct emails (same subject + same sender in
  // the same minute — acceptable false-negative rate is near zero).
  const minuteBucket = Math.floor(dt.getTime() / 60000);
  return `${nSubject}|||${nFrom}|||${minuteBucket}`;
}

/** An already-stored email keyed by its RFC Message-ID. */
export interface ExistingByMessageId {
  /** Local emails.id (UUID). */
  id: string;
  /** Provider id currently stored on that row (may be stale after re-delivery). */
  externalId: string | null;
}

/** A resurrection remap: an existing row whose provider id must be updated in place. */
export interface EmailResurrection {
  /** Local emails.id (UUID) of the already-stored row. */
  existingId: string;
  /** The NEW provider id to write onto that row. */
  newExternalId: string;
  /** The shared Message-ID that proved the two are the same message. */
  messageIdHeader: string;
}

export interface EmailWritePlan<T> {
  /** Brand-new emails to INSERT. */
  toInsert: T[];
  /**
   * Re-deliveries of an already-stored message under a NEW provider id
   * (BACKLOG-1764 ghost resurrection). Remap external_id in place — do NOT
   * insert a second row.
   */
  resurrections: EmailResurrection[];
  /** Count of rows skipped as exact duplicates (external_id or in-batch header). */
  duplicates: number;
}

/**
 * Decide, for a batch of freshly-fetched emails, which are brand new (insert),
 * which are re-deliveries of an already-stored message under a DIFFERENT provider
 * id (resurrection → remap external_id in place), and which are exact duplicates.
 *
 * This is the durable root-fix for ghost resurrection (BACKLOG-1764): a
 * re-delivered message keeps its RFC Message-ID but receives a new provider id,
 * so external-id dedup misses it and a second (ghost) row is created. Matching on
 * (user_id, message_id_header) catches it; when the provider id changed we update
 * the existing row in place rather than inserting the ghost.
 *
 * Pure function — all DB reads happen in the caller. Precedence per email:
 *   1. external_id already stored              → exact duplicate (skip)
 *   2. Message-ID already stored, id changed   → resurrection (remap, skip insert)
 *   3. Message-ID already stored, id unchanged → exact duplicate (skip)
 *   4. Message-ID already claimed in THIS batch (e.g. inbox + sent) → skip
 *   5. otherwise                               → insert
 *
 * @param emails   Fetched emails (already deduped against the in-session seenIds).
 * @param existing Already-stored lookups: external_ids (Set) and byMessageId (Map).
 */
export function planEmailWrites<T extends PlannableEmail>(
  emails: T[],
  existing: {
    externalIds: Set<string>;
    byMessageId: Map<string, ExistingByMessageId>;
    /**
     * BACKLOG-1861: Last-resort legacy-row lookup. Key = computeLegacyContentKey
     * output. Only populated for legacy rows (message_id_header IS NULL).
     * Each key maps to exactly ONE row (ambiguous multi-row keys excluded by
     * caller). Consulted only for emails that have a messageIdHeader and were
     * not caught by steps 1–4.
     */
    byLegacyContent?: Map<string, ExistingByMessageId>;
  },
): EmailWritePlan<T> {
  const toInsert: T[] = [];
  const resurrections: EmailResurrection[] = [];
  let duplicates = 0;

  // Message-IDs already claimed by a row we are about to insert in THIS batch, so
  // two rows carrying the same header (e.g. the same message surfaced from both
  // the inbox and the sent folder) collapse to one even before they hit the DB.
  const claimedHeaders = new Set<string>();

  for (const email of emails) {
    // (1) Same provider id already stored → exact duplicate.
    if (existing.externalIds.has(email.id)) {
      duplicates++;
      continue;
    }

    const header = email.messageIdHeader ?? null;
    if (header) {
      // (2)/(3) Same Message-ID already stored.
      const match = existing.byMessageId.get(header);
      if (match) {
        if (match.externalId !== email.id) {
          // Provider id changed → ghost resurrection. Remap in place.
          resurrections.push({
            existingId: match.id,
            newExternalId: email.id,
            messageIdHeader: header,
          });
        } else {
          duplicates++;
        }
        continue; // never insert a second row for a known Message-ID
      }

      // (4) Same Message-ID appears twice within this batch.
      if (claimedHeaders.has(header)) {
        duplicates++;
        continue;
      }
      claimedHeaders.add(header);

      // (5) BACKLOG-1861: last-resort legacy check.
      // Incoming email has a Message-ID but no stored row was found by steps
      // 1–4. Check whether a 2.19-era row (message_id_header IS NULL) with
      // matching content exists. If the caller pre-loaded exactly one such row
      // keyed by (subject, sender, sent_at), treat it as a resurrection: remap
      // external_id in place and backfill message_id_header. Gated on the email
      // having a messageIdHeader so NULL→NULL pairs are never merged here.
      if (existing.byLegacyContent) {
        const legacyKey = computeLegacyContentKey(email.subject, email.from, email.date);
        if (legacyKey) {
          const legacyMatch = existing.byLegacyContent.get(legacyKey);
          if (legacyMatch) {
            resurrections.push({
              existingId: legacyMatch.id,
              newExternalId: email.id,
              messageIdHeader: header,
            });
            continue;
          }
        }
      }
    }

    // (6) Genuinely new.
    toInsert.push(email);
  }

  return { toInsert, resurrections, duplicates };
}
