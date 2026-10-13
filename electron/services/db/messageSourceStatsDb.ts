/**
 * BACKLOG-3156 stage G — "Stored on this computer" for each messages source.
 *
 * Settings > Messages shows, under the macOS Messages, iPhone and Google
 * Messages panes, how many texts and chats Keepr holds from that source and the
 * oldest one. Each source is recognised by the id its importer writes:
 *
 *   macOS Messages   thread_id   `macos-chat-<chat ROWID>`   (schema.sql messages.thread_id note)
 *   iPhone           thread_id   `ios-chat-<chat ROWID>`     (iphoneChatFloorDbService IOS_CHAT_THREAD_PREFIX)
 *   Google Messages  external_id `gmweb:…` or `gmweb2:…`     (rcsImportSql.ts)
 *
 * The Android Companion is NOT counted under Google Messages: its texts carry
 * thread_id `android-thread-<id>` (rcsSourcePresenceDb.ts) and a dedup hash as
 * external_id (localSyncService.ts), so neither gmweb range can match them.
 * A Mac or iPhone text stored with no chat (thread_id NULL) is not attributed
 * to either source, because nothing on the row says which importer wrote it
 * without reading metadata JSON for every text of the user.
 *
 * Every predicate is a RANGE on an indexed column (`>= 'p' AND < 'p.'` /
 * `< 'gmweb;'`), never LIKE: SQLite's default LIKE is case-insensitive and
 * cannot use the index. `+user_id` and `+sent_at` keep the planner on that
 * range instead of walking every text of the user. Reactions (tapbacks) are
 * not texts and are excluded with the shared clause.
 */
import { sql } from "./core/sqlText";
import { reactionExclusion } from "./reactionExclusion";
import type { MessageScanRunner } from "./wizardMessageScansDb";

export interface MessageSourceStat {
  texts: number;
  chats: number;
  /** ISO timestamp of the oldest text, or null when there are none. */
  oldest: string | null;
}

export interface MessageSourceStats {
  macos: MessageSourceStat;
  iphone: MessageSourceStat;
  google: MessageSourceStat;
}

const ROW_FILTER = sql`+m.user_id = ? AND ${reactionExclusion("m")}`;

/** Four bound parameters, all the user id. Three rows: { source, texts, chats, oldest }. */
export const MESSAGE_SOURCE_STATS_SQL = sql`
SELECT 'macos' AS source, COUNT(*) AS texts, COUNT(DISTINCT m.thread_id) AS chats, MIN(+m.sent_at) AS oldest
  FROM messages m
 WHERE m.thread_id >= 'macos-chat-' AND m.thread_id < 'macos-chat.' AND ${ROW_FILTER}
UNION ALL
SELECT 'iphone', COUNT(*), COUNT(DISTINCT m.thread_id), MIN(+m.sent_at)
  FROM messages m
 WHERE m.thread_id >= 'ios-chat-' AND m.thread_id < 'ios-chat.' AND ${ROW_FILTER}
UNION ALL
SELECT 'google', COUNT(*), COUNT(DISTINCT g.thread_id), MIN(g.sent_at)
  FROM (SELECT m.thread_id, m.sent_at FROM messages m
         WHERE m.external_id >= 'gmweb:' AND m.external_id < 'gmweb;' AND ${ROW_FILTER}
        UNION ALL
        SELECT m.thread_id, m.sent_at FROM messages m
         WHERE m.external_id >= 'gmweb2:' AND m.external_id < 'gmweb2;' AND ${ROW_FILTER}) g`;

const EMPTY: MessageSourceStat = { texts: 0, chats: 0, oldest: null };

export function readMessageSourceStatsOn(db: MessageScanRunner, userId: string): MessageSourceStats {
  const rows = db
    .prepare(MESSAGE_SOURCE_STATS_SQL)
    .all(userId, userId, userId, userId) as Array<{
    source: keyof MessageSourceStats;
    texts: number;
    chats: number;
    oldest: string | null;
  }>;
  const out: MessageSourceStats = { macos: { ...EMPTY }, iphone: { ...EMPTY }, google: { ...EMPTY } };
  for (const r of rows) {
    out[r.source] = { texts: Number(r.texts) || 0, chats: Number(r.chats) || 0, oldest: r.oldest ?? null };
  }
  return out;
}
