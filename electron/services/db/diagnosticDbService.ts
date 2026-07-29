/**
 * Diagnostic Database Service
 * Handles all diagnostic/debugging database operations for message health analysis
 */

import { ensureDb } from "./core/dbConnection";
import { LOCAL_REACTION_EXCLUSION, reactionExclusion } from "./reactionExclusion";

// ============================================
// DIAGNOSTIC OPERATIONS (for debugging data issues)
// ============================================

/**
 * Diagnostic: Find messages with NULL thread_id
 * These messages use fallback grouping which can cause incorrect merging
 */
export function diagnosticGetMessagesWithNullThreadId(userId: string): {
  count: number;
  samples: Array<{ id: string; body_text: string; participants: string; sent_at: string }>;
} {
  const db = ensureDb();

  const countResult = db.prepare(`
    SELECT COUNT(*) as count FROM messages
    WHERE user_id = ? AND thread_id IS NULL AND channel IN ('sms', 'imessage')
      AND ${LOCAL_REACTION_EXCLUSION}
  `).get(userId) as { count: number };

  const samples = db.prepare(`
    SELECT id, body_text, participants, sent_at FROM messages
    WHERE user_id = ? AND thread_id IS NULL AND channel IN ('sms', 'imessage')
      AND ${LOCAL_REACTION_EXCLUSION}
    ORDER BY sent_at DESC LIMIT 10
  `).all(userId) as Array<{ id: string; body_text: string; participants: string; sent_at: string }>;

  return { count: countResult.count, samples };
}

/**
 * Diagnostic: Get recent messages with unknown recipient
 * Returns external_id (macOS ROWID) for cross-referencing
 */
export function diagnosticUnknownRecipientMessages(userId: string): {
  samples: Array<{ external_id: string; body_text: string; participants: string; sent_at: string }>;
} {
  const db = ensureDb();

  const samples = db.prepare(`
    SELECT external_id, body_text, participants, sent_at FROM messages
    WHERE user_id = ? AND thread_id IS NULL AND channel IN ('sms', 'imessage')
    AND participants LIKE '%"unknown"%'
    AND ${LOCAL_REACTION_EXCLUSION}
    ORDER BY sent_at DESC LIMIT 10
  `).all(userId) as Array<{ external_id: string; body_text: string; participants: string; sent_at: string }>;

  return { samples };
}

/**
 * Diagnostic: Find messages with potential garbage text
 * Looks for known parser fallback messages
 */
export function diagnosticGetMessagesWithGarbageText(userId: string): {
  count: number;
  samples: Array<{ id: string; body_text: string; thread_id: string | null; sent_at: string }>;
} {
  const db = ensureDb();

  // DETERMINISTIC: Check for exact fallback messages (no heuristics)
  // These are the only values the parser returns when it cannot parse
  const countResult = db.prepare(`
    SELECT COUNT(*) as count FROM messages
    WHERE user_id = ? AND channel IN ('sms', 'imessage')
    AND body_text IN (
      '[Unable to parse message]',
      '[Message text - parsing error]',
      '[Message text - unable to extract from rich format]'
    )
  `).get(userId) as { count: number };

  const samples = db.prepare(`
    SELECT id, body_text, thread_id, sent_at FROM messages
    WHERE user_id = ? AND channel IN ('sms', 'imessage')
    AND body_text IN (
      '[Unable to parse message]',
      '[Message text - parsing error]',
      '[Message text - unable to extract from rich format]'
    )
    ORDER BY sent_at DESC LIMIT 10
  `).all(userId) as Array<{ id: string; body_text: string; thread_id: string | null; sent_at: string }>;

  return { count: countResult.count, samples };
}

/**
 * Diagnostic: Complete message health report
 * Shows total counts and breakdown of parsing issues
 */
export function diagnosticMessageHealthReport(userId: string): {
  total: number;
  withThreadId: number;
  withNullThreadId: number;
  withGarbageText: number;
  withEmptyText: number;
  healthy: number;
  healthPercentage: number;
} {
  const db = ensureDb();

  const totalResult = db.prepare(`
    SELECT COUNT(*) as count FROM messages
    WHERE user_id = ? AND channel IN ('sms', 'imessage')
      AND ${LOCAL_REACTION_EXCLUSION}
  `).get(userId) as { count: number };

  const withThreadIdResult = db.prepare(`
    SELECT COUNT(*) as count FROM messages
    WHERE user_id = ? AND channel IN ('sms', 'imessage') AND thread_id IS NOT NULL
      AND ${LOCAL_REACTION_EXCLUSION}
  `).get(userId) as { count: number };

  const withNullThreadIdResult = db.prepare(`
    SELECT COUNT(*) as count FROM messages
    WHERE user_id = ? AND channel IN ('sms', 'imessage') AND thread_id IS NULL
      AND ${LOCAL_REACTION_EXCLUSION}
  `).get(userId) as { count: number };

  // DETERMINISTIC: Count messages that failed to parse (exact fallback messages)
  const withGarbageResult = db.prepare(`
    SELECT COUNT(*) as count FROM messages
    WHERE user_id = ? AND channel IN ('sms', 'imessage')
    AND body_text IN (
      '[Unable to parse message]',
      '[Message text - parsing error]',
      '[Message text - unable to extract from rich format]'
    )
  `).get(userId) as { count: number };

  const withEmptyResult = db.prepare(`
    SELECT COUNT(*) as count FROM messages
    WHERE user_id = ? AND channel IN ('sms', 'imessage')
    AND (body_text IS NULL OR LENGTH(body_text) < 1)
    AND ${LOCAL_REACTION_EXCLUSION}
  `).get(userId) as { count: number };

  const healthy = totalResult.count - withNullThreadIdResult.count - withGarbageResult.count - withEmptyResult.count;
  const healthPercentage = totalResult.count > 0
    ? Math.round((healthy / totalResult.count) * 100 * 10) / 10
    : 100;

  return {
    total: totalResult.count,
    withThreadId: withThreadIdResult.count,
    withNullThreadId: withNullThreadIdResult.count,
    withGarbageText: withGarbageResult.count,
    withEmptyText: withEmptyResult.count,
    healthy: Math.max(0, healthy),
    healthPercentage,
  };
}

/**
 * Diagnostic: Get thread_id distribution for a contact
 * Shows which chats a contact appears in
 */
export function diagnosticGetThreadsForContact(userId: string, phoneDigits: string): {
  threads: Array<{ thread_id: string | null; message_count: number; participants_sample: string }>;
} {
  const db = ensureDb();

  const threads = db.prepare(`
    SELECT
      thread_id,
      COUNT(*) as message_count,
      (SELECT participants FROM messages m2
       WHERE m2.thread_id = messages.thread_id
       AND m2.user_id = ? AND ${reactionExclusion("m2")} LIMIT 1) as participants_sample
    FROM messages
    WHERE user_id = ?
      AND channel IN ('sms', 'imessage')
      AND participants_flat LIKE ?
      AND ${LOCAL_REACTION_EXCLUSION}
    GROUP BY thread_id
    ORDER BY message_count DESC
  `).all(userId, userId, `%${phoneDigits}%`) as Array<{
    thread_id: string | null;
    message_count: number;
    participants_sample: string;
  }>;

  return { threads };
}

/**
 * Diagnostic: Detailed analysis of NULL thread_id messages
 * Groups by sender, channel, and month to identify patterns
 */
export function diagnosticNullThreadIdAnalysis(userId: string): {
  total: number;
  byChannel: Array<{ channel: string; count: number }>;
  bySender: Array<{ sender: string; count: number; sampleText: string }>;
  byMonth: Array<{ month: string; count: number }>;
  unknownRecipient: number;
} {
  const db = ensureDb();

  const totalResult = db.prepare(`
    SELECT COUNT(*) as count FROM messages
    WHERE user_id = ? AND thread_id IS NULL AND channel IN ('sms', 'imessage')
      AND ${LOCAL_REACTION_EXCLUSION}
  `).get(userId) as { count: number };

  const byChannel = db.prepare(`
    SELECT channel, COUNT(*) as count FROM messages
    WHERE user_id = ? AND thread_id IS NULL AND channel IN ('sms', 'imessage')
      AND ${LOCAL_REACTION_EXCLUSION}
    GROUP BY channel ORDER BY count DESC
  `).all(userId) as Array<{ channel: string; count: number }>;

  const bySender = db.prepare(`
    SELECT
      CASE
        WHEN participants LIKE '%"from":"me"%' THEN
          json_extract(participants, '$.to[0]')
        ELSE
          json_extract(participants, '$.from')
      END as sender,
      COUNT(*) as count,
      (SELECT body_text FROM messages m2
       WHERE m2.user_id = ? AND m2.thread_id IS NULL
       AND m2.participants = messages.participants
       AND ${reactionExclusion("m2")}
       LIMIT 1) as sampleText
    FROM messages
    WHERE user_id = ? AND thread_id IS NULL AND channel IN ('sms', 'imessage')
      AND ${LOCAL_REACTION_EXCLUSION}
    GROUP BY sender
    ORDER BY count DESC
    LIMIT 20
  `).all(userId, userId) as Array<{ sender: string; count: number; sampleText: string }>;

  const byMonth = db.prepare(`
    SELECT
      strftime('%Y-%m', sent_at) as month,
      COUNT(*) as count
    FROM messages
    WHERE user_id = ? AND thread_id IS NULL AND channel IN ('sms', 'imessage')
      AND ${LOCAL_REACTION_EXCLUSION}
    GROUP BY month
    ORDER BY month DESC
    LIMIT 12
  `).all(userId) as Array<{ month: string; count: number }>;

  const unknownResult = db.prepare(`
    SELECT COUNT(*) as count FROM messages
    WHERE user_id = ? AND thread_id IS NULL AND channel IN ('sms', 'imessage')
    AND participants LIKE '%"unknown"%'
    AND ${LOCAL_REACTION_EXCLUSION}
  `).get(userId) as { count: number };

  return {
    total: totalResult.count,
    byChannel,
    bySender,
    byMonth,
    unknownRecipient: unknownResult.count,
  };
}
