/**
 * SR M (2026-10-02): Google Messages media options and the pending media read
 * (tables rcs_media_options / rcs_pending_media, schema.sql). Local only.
 */
import { dbGet, dbRun, dbTransaction } from "./core/dbConnection";
import { sql } from "./core/sqlText";

export interface RcsMediaOptions {
  /** Keep photos of every chat in the window (default true). */
  photosAllChats: boolean;
  /** Keep videos of every chat in the window (default false). */
  videosAllChats: boolean;
  lastPhotosSeen: number | null;
  lastVideosSeen: number | null;
}

export const RCS_MEDIA_DEFAULTS: RcsMediaOptions = {
  photosAllChats: true,
  videosAllChats: false,
  lastPhotosSeen: null,
  lastVideosSeen: null,
};

export function getRcsMediaOptions(userId: string): RcsMediaOptions {
  try {
    const row = dbGet<{ photos: number; videos: number; lastPhotos: number | null; lastVideos: number | null }>(
      sql`SELECT photos_all_chats AS photos, videos_all_chats AS videos, last_photos_seen AS lastPhotos,
                 last_videos_seen AS lastVideos FROM rcs_media_options WHERE user_id = ?`,
      [userId],
    );
    if (!row) return { ...RCS_MEDIA_DEFAULTS };
    return { photosAllChats: row.photos === 1, videosAllChats: row.videos === 1, lastPhotosSeen: row.lastPhotos, lastVideosSeen: row.lastVideos };
  } catch {
    return { ...RCS_MEDIA_DEFAULTS }; // no table yet
  }
}

/** Save the toggles; a toggle switched ON marks the next Sync's media read. */
export function setRcsMediaOptions(userId: string, next: { photosAllChats?: boolean; videosAllChats?: boolean }): RcsMediaOptions {
  const prev = getRcsMediaOptions(userId);
  const photos = next.photosAllChats ?? prev.photosAllChats;
  const videos = next.videosAllChats ?? prev.videosAllChats;
  // SR (G1): the toggles and the pending media read together, or neither.
  // (Two tables: rcs_pending_media already exists on installed builds, and
  // schema.sql cannot add a column to an existing table without a migration.)
  dbTransaction(() => {
    dbRun(
      sql`INSERT INTO rcs_media_options (user_id, photos_all_chats, videos_all_chats, updated_at)
          VALUES (?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(user_id) DO UPDATE SET photos_all_chats = excluded.photos_all_chats,
            videos_all_chats = excluded.videos_all_chats, updated_at = CURRENT_TIMESTAMP`,
      [userId, photos ? 1 : 0, videos ? 1 : 0],
    );
    if ((photos && !prev.photosAllChats) || (videos && !prev.videosAllChats)) {
      dbRun(sql`INSERT OR REPLACE INTO rcs_pending_media (user_id, created_at) VALUES (?, CURRENT_TIMESTAMP)`, [userId]);
    }
  });
  return getRcsMediaOptions(userId);
}

/** The bubbles the last Sync counted (counts only). */
export function recordRcsMediaSeen(userId: string, photos: number, videos: number): void {
  dbRun(
    sql`INSERT INTO rcs_media_options (user_id, last_photos_seen, last_videos_seen, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET last_photos_seen = excluded.last_photos_seen,
          last_videos_seen = excluded.last_videos_seen, updated_at = CURRENT_TIMESTAMP`,
    [userId, photos, videos],
  );
}

export function hasPendingMediaRead(userId: string): boolean {
  try {
    return !!dbGet(sql`SELECT 1 FROM rcs_pending_media WHERE user_id = ?`, [userId]);
  } catch {
    return false;
  }
}

export function clearPendingMediaRead(userId: string): void {
  dbRun(sql`DELETE FROM rcs_pending_media WHERE user_id = ?`, [userId]);
}
