/**
 * BACKLOG-3785 — cheap per-source presence reads for the Google Messages
 * handlers, which polled the full per-source coverage scan
 * (MESSAGES_FLOOR_BY_SOURCE_SQL: json_extract over EVERY text of the user) on
 * the main thread every 3 s while the setup screen was open.
 *
 * hasCompanionTexts answers exactly what
 * `getSourceCoverage(u).some((c) => c.source === "android_companion")` answered:
 * a counted Android Companion text exists, or a coverage row was recorded for it.
 * Every Companion text is stored with thread_id `android-thread-<id>`
 * (localSyncService.storeMessages) or, in the form shipped in v2.14.0, '' — so
 * the thread_id index bounds the read to those rows, never every text.
 */

import { dbGet } from "./core/dbConnection";
import { sql } from "./core/sqlText";
import { reactionExclusion } from "./reactionExclusion";
import logService from "../logService";

/** The floor filters of MESSAGES_FLOOR_BY_SOURCE_SQL, for one Companion row. */
const COUNTED_COMPANION_ROW = sql`m.user_id = ?
           AND CASE WHEN json_valid(m.metadata) THEN json_extract(m.metadata, '$.source') END = 'android_wifi_sync'
           AND m.channel IN ('sms', 'imessage')
           AND m.duplicate_of IS NULL
           AND ${reactionExclusion("m")}
           AND m.sent_at IS NOT NULL`;

/** Three bound parameters: user id, user id, user id. One row: { found: 0 | 1 }. */
export const COMPANION_TEXTS_EXIST_SQL = sql`SELECT (
         EXISTS (SELECT 1 FROM messages m
                  WHERE m.thread_id >= 'android-thread-' AND m.thread_id < 'android-thread.'
                    AND ${COUNTED_COMPANION_ROW})
      OR EXISTS (SELECT 1 FROM messages m
                  WHERE m.thread_id = ''
                    AND ${COUNTED_COMPANION_ROW})
      OR EXISTS (SELECT 1 FROM message_source_coverage
                  WHERE user_id = ? AND source = 'android_companion')
       ) AS found`;

/** Two bound parameters: user id, source. */
export const RECORDED_COVERED_SINCE_SQL = sql`SELECT covered_since AS coveredSince
         FROM message_source_coverage WHERE user_id = ? AND source = ?`;

/** Android Companion texts exist for this user (Force re-import names it only then). Never throws (→ false). */
export function hasCompanionTexts(userId: string): boolean {
  try {
    const row = dbGet<{ found: number }>(COMPANION_TEXTS_EXIST_SQL, [userId, userId, userId]);
    return row?.found === 1;
  } catch (error) {
    void logService.warn("[BACKLOG-3785] hasCompanionTexts failed (non-fatal)", "RcsSourcePresence", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** The recorded coverage floor of one source (null = none recorded). Never throws (→ null). */
export function recordedCoveredSince(userId: string, source: string): string | null {
  try {
    return dbGet<{ coveredSince: string | null }>(RECORDED_COVERED_SINCE_SQL, [userId, source])?.coveredSince ?? null;
  } catch (error) {
    void logService.warn("[BACKLOG-3785] recordedCoveredSince failed (non-fatal)", "RcsSourcePresence", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
