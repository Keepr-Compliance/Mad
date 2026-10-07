/**
 * BACKLOG-3658 L2: the last finished Google Messages cache run per user — its
 * floor, whether it was a full read, how its list scan stopped, whether it
 * reached its floor, and how many chats it could not confirm complete
 * (not_settled). Written in the commit's transaction; read to backfill the
 * coverage and to say "N chats may be incomplete". Local only.
 */

import { dbGet, dbRun } from "./core/dbConnection";
import { sql } from "./core/sqlText";

export interface RcsCacheRun {
  floorISO: string;
  fullRead: boolean;
  listStop: string | null;
  reachedFloor: boolean;
  notSettledChats: number;
  finishedAt: string;
}

export function recordRcsCacheRun(userId: string, run: RcsCacheRun): void {
  dbRun(
    sql`INSERT INTO rcs_cache_runs (user_id, floor_iso, full_read, list_stop, reached_floor, not_settled_chats, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          floor_iso = excluded.floor_iso, full_read = excluded.full_read, list_stop = excluded.list_stop,
          reached_floor = excluded.reached_floor, not_settled_chats = excluded.not_settled_chats,
          finished_at = excluded.finished_at`,
    [userId, run.floorISO, run.fullRead ? 1 : 0, run.listStop, run.reachedFloor ? 1 : 0, run.notSettledChats, run.finishedAt],
  );
}

export function getRcsCacheRun(userId: string): RcsCacheRun | null {
  try {
    const r = dbGet<{
      floorISO: string; fullRead: number; listStop: string | null; reachedFloor: number; notSettledChats: number; finishedAt: string;
    }>(
      sql`SELECT floor_iso AS floorISO, full_read AS fullRead, list_stop AS listStop, reached_floor AS reachedFloor,
                 not_settled_chats AS notSettledChats, finished_at AS finishedAt
            FROM rcs_cache_runs WHERE user_id = ?`,
      [userId],
    );
    return r
      ? { floorISO: r.floorISO, fullRead: r.fullRead === 1, listStop: r.listStop, reachedFloor: r.reachedFloor === 1, notSettledChats: r.notSettledChats ?? 0, finishedAt: r.finishedAt }
      : null;
  } catch {
    return null; // no table yet: nothing known
  }
}

/** Force re-import: the run record goes with the texts. */
export function clearRcsCacheRun(userId: string): void {
  dbRun(sql`DELETE FROM rcs_cache_runs WHERE user_id = ?`, [userId]);
}
