/**
 * BACKLOG-3731 — the ONE text-attachment lookup.
 *
 * Three surfaces used to answer "which attachments belong to these texts"
 * three different ways:
 *
 *   - the Messages view matched `message_id`, then — for every message with
 *     ZERO direct rows — matched `external_message_id` to the message's
 *     Apple id, whatever `message_id` held (TASK-1110);
 *   - the Attachments tab only used the Apple id when `message_id IS NULL`,
 *     which the attachments CHECK makes impossible for a text row;
 *   - the submit matched `message_id` only.
 *
 * So a row whose `message_id` points at a message that no longer exists was
 * shown in the conversation and never sent. All three now call this function,
 * which copies the Messages-view rule:
 *
 *   1. rows whose `message_id` is one of the given ids;
 *   2. for each given id with no row in (1): rows whose `external_message_id`
 *      equals that message's `external_id`.
 *
 * Read-only. The Messages view keeps its own repair write; nothing here
 * writes, so the submit and the Attachments tab never mutate.
 *
 * Each row comes back with `resolved_message_id` — the message it belongs to
 * under the rule above. Callers key on that, never on `row.message_id`, which
 * for a step-2 row names a different (or missing) message.
 *
 * An attachment is returned once. If one row matches two of the given
 * messages (only possible when its own `message_id` and `external_message_id`
 * disagree), the step-1 match wins.
 */

import type { Database as DatabaseType } from "better-sqlite3";

/** IN-list width per statement, well under SQLite's bound-parameter limit. */
export const TEXT_ATTACHMENT_LOOKUP_CHUNK = 500;

export interface ResolvedTextAttachment<T> {
  row: T;
  resolved_message_id: string;
}

interface AttachmentRowBase {
  id: string;
  message_id: string | null;
  external_message_id?: string | null;
}

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += TEXT_ATTACHMENT_LOOKUP_CHUNK) {
    out.push(items.slice(i, i + TEXT_ATTACHMENT_LOOKUP_CHUNK));
  }
  return out;
}

const widthOf = (ids: readonly string[]): string => ids.map(() => "?").join(", ");

/**
 * Attachments for the given internal message ids, under the Messages-view rule.
 * Rows are full `attachments` rows (`SELECT *`).
 */
export function selectTextAttachmentsForMessages<T extends AttachmentRowBase>(
  db: DatabaseType,
  messageIds: readonly string[],
): ResolvedTextAttachment<T>[] {
  const ids = Array.from(new Set(messageIds));
  if (ids.length === 0) return [];

  const result: ResolvedTextAttachment<T>[] = [];
  const seen = new Set<string>();
  const withDirectRows = new Set<string>();

  // 1. Direct rows.
  for (const part of chunks(ids)) {
    const rows = db
      .prepare(`SELECT * FROM attachments WHERE message_id IN (${widthOf(part)})`)
      .all(...part) as T[];
    for (const row of rows) {
      const owner = row.message_id as string;
      withDirectRows.add(owner);
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      result.push({ row, resolved_message_id: owner });
    }
  }

  // 2. Apple-id rows, only for messages with no direct row.
  const missing = ids.filter((id) => !withDirectRows.has(id));
  if (missing.length === 0) return result;

  const ownerByExternal = new Map<string, string>();
  for (const part of chunks(missing)) {
    const rows = db
      .prepare(
        `SELECT id, external_id FROM messages WHERE id IN (${widthOf(part)}) AND external_id IS NOT NULL`,
      )
      .all(...part) as { id: string; external_id: string }[];
    for (const m of rows) ownerByExternal.set(m.external_id, m.id);
  }

  const externalIds = Array.from(ownerByExternal.keys());
  for (const part of chunks(externalIds)) {
    const rows = db
      .prepare(`SELECT * FROM attachments WHERE external_message_id IN (${widthOf(part)})`)
      .all(...part) as T[];
    for (const row of rows) {
      const owner = ownerByExternal.get(row.external_message_id as string);
      if (!owner || seen.has(row.id)) continue;
      seen.add(row.id);
      result.push({ row, resolved_message_id: owner });
    }
  }

  return result;
}
