/**
 * Live (0.3.15): chats the user switched back ON (the eye, Settings "Sync
 * again" / "Sync all again") have no new message, so the incremental cache
 * Sync (since = last finished − 1 day) never picked them up. They are
 * recorded here; the next cache Sync reads them to the FULL floor whatever
 * their age, and each is cleared once the chat is saved. Conversation ids and
 * chat hashes only (no names). Local only.
 */

import crypto from "crypto";
import { dbAll, dbRun } from "./core/dbConnection";
import { sql } from "./core/sqlText";

export interface ExclusionKey {
  conversationId: string | null;
  chatHash: string | null;
}

const SELECT_FOR_CONVERSATION = sql`
    SELECT conversation_id AS conversationId, chat_hash AS chatHash FROM rcs_chat_exclusions
    WHERE user_id = ? AND (
      conversation_id = ?
      OR (chat_hash IS NOT NULL AND chat_hash IN (
        SELECT chat_hash FROM rcs_chat_exclusions WHERE user_id = ? AND conversation_id = ? AND chat_hash IS NOT NULL
      ))
    )`;

/** The exclusion rows the eye is about to switch back on (by its conversation id; the eye is the only switch). */
export function exclusionKeysFor(userId: string, by: { conversationId?: string }): ExclusionKey[] {
  if (by.conversationId) return dbAll<ExclusionKey>(SELECT_FOR_CONVERSATION, [userId, by.conversationId, userId, by.conversationId]);
  return [];
}

/** Record chats switched back on: the next cache Sync reads them in full. */
export function markPendingFullRead(userId: string, keys: readonly ExclusionKey[]): void {
  for (const k of keys) {
    if (!k.conversationId && !k.chatHash) continue;
    dbRun(
      sql`INSERT INTO rcs_pending_full_sync (id, user_id, conversation_id, chat_hash) VALUES (?, ?, ?, ?)`,
      [crypto.randomUUID(), userId, k.conversationId, k.chatHash],
    );
  }
}

/** Conversation ids the next cache Sync must read in full (most recent first, unique). */
export function listPendingFullRead(userId: string, max = 500): string[] {
  try {
    return dbAll<{ conversationId: string }>(
      sql`SELECT conversation_id AS conversationId FROM rcs_pending_full_sync
           WHERE user_id = ? AND conversation_id IS NOT NULL
           GROUP BY conversation_id ORDER BY MAX(created_at) DESC LIMIT ?`,
      [userId, max],
    ).map((r) => r.conversationId);
  } catch {
    return []; // no table yet
  }
}

/** A chat was saved: it is no longer pending (by its conversation id or its hash). */
export function clearPendingFullRead(userId: string, conversationId: string, chatHash: string): number {
  return dbRun(
    sql`DELETE FROM rcs_pending_full_sync WHERE user_id = ? AND (conversation_id = ? OR chat_hash = ?)`,
    [userId, conversationId, chatHash],
  ).changes;
}

/** Force re-import: everything is read again anyway. */
export function clearAllPendingFullRead(userId: string): void {
  dbRun(sql`DELETE FROM rcs_pending_full_sync WHERE user_id = ?`, [userId]);
}
