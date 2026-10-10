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
 *      equals that message's `external_id` and whose `email_id` is NULL (an
 *      email attachment's `external_message_id` holds the email's provider id,
 *      never a text's Apple id).
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
      .prepare(
        `SELECT * FROM attachments WHERE external_message_id IN (${widthOf(part)}) AND email_id IS NULL`,
      )
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

/**
 * Columns of the owning text that the transaction Attachments tab shows.
 */
export interface TextAttachmentOwner {
  owner_sent_at: string | null;
  owner_direction: string | null;
  owner_participants_flat: string | null;
}

/** Optional window on the owning text's `sent_at` (ISO strings, inclusive). */
export interface TextAttachmentWindow {
  start?: string | null;
  end?: string | null;
}

/**
 * BACKLOG-3884 — the same rule as {@link selectTextAttachmentsForMessages}, for
 * every text linked to one transaction, WITHOUT reading every linked text.
 *
 * The Attachments tab used to collect the ids of all the transaction's linked
 * texts (105k on one PC, 3.5-5 s on main) and pass them to the lookup above.
 * This reads from the attachments side instead; a `messages` row is read only
 * for an attachment that is a hit.
 *
 * "Linked" is the display join's rule: a per-message link
 * (`communications.message_id = m.id`), or a thread link
 * (`communications.message_id IS NULL`, same `thread_id`, same `user_id`).
 *
 *   1a. per-message links -> their attachments by `message_id`;
 *   1b. thread links -> the thread's message rowids (index only), kept only if
 *       that message owns an attachment row (index only), then the message row
 *       for the user check and the attachment rows;
 *   2.  Apple-id rows. An attachment can resolve to another message by
 *       `external_message_id` only when the message carrying that Apple id is
 *       not the attachment's own message. Those pairs are found index-only and
 *       are almost always none; only they get the full checks (email_id NULL,
 *       owner linked, owner in the window, owner has no direct row).
 *
 * Step-1 rows win; one row per attachment id. Owners are filtered by the
 * window exactly as the old collection was (`m.sent_at >= start`,
 * `m.sent_at <= end`).
 *
 * Known difference: two linked messages with no direct row and the same Apple
 * id (only possible across two users, since (user_id, external_id) is unique)
 * — the old lookup took the last one from an unordered Map, this takes the
 * first. The set of attachments is the same.
 *
 * `+tm.rowid` and the CROSS JOINs fix the join order: without statistics
 * SQLite otherwise drives the thread arm from the attachment list and probes
 * every thread for every attachment (4 s on 668k texts).
 */
export function selectTextAttachmentsForTransaction<T extends AttachmentRowBase>(
  db: DatabaseType,
  transactionId: string,
  window: TextAttachmentWindow = {},
): ResolvedTextAttachment<T & TextAttachmentOwner>[] {
  let windowClause = "";
  const windowParams: string[] = [];
  if (window.start) {
    windowClause += " AND m.sent_at >= ?";
    windowParams.push(window.start);
  }
  if (window.end) {
    windowClause += " AND m.sent_at <= ?";
    windowParams.push(window.end);
  }

  const ownerCols = `m.id AS owner_id, m.sent_at AS owner_sent_at, m.direction AS owner_direction,
         m.participants_flat AS owner_participants_flat`;
  type Row = T & TextAttachmentOwner & { owner_id: string };

  // 1a. Per-message links.
  const viaMessageLinks = db
    .prepare(
      `SELECT a.*, ${ownerCols}
       FROM communications c
       CROSS JOIN attachments a ON a.message_id = c.message_id
       CROSS JOIN messages m ON m.id = a.message_id
       WHERE c.transaction_id = ? AND c.message_id IS NOT NULL${windowClause}`,
    )
    .all(transactionId, ...windowParams) as Row[];

  // 1b. Thread links.
  const viaThreadLinks = db
    .prepare(
      `SELECT a.*, ${ownerCols}
       FROM communications c
       CROSS JOIN messages tm ON tm.thread_id = c.thread_id
       CROSS JOIN messages m ON m.rowid = tm.rowid
       CROSS JOIN attachments a ON a.message_id = m.id
       WHERE c.transaction_id = ? AND c.message_id IS NULL AND c.thread_id IS NOT NULL
         AND +tm.rowid IN (
           SELECT x.rowid FROM attachments ax CROSS JOIN messages x ON x.id = ax.message_id
           WHERE ax.message_id IS NOT NULL)
         AND +m.user_id = c.user_id${windowClause}`,
    )
    .all(transactionId, ...windowParams) as Row[];

  const result: ResolvedTextAttachment<T & TextAttachmentOwner>[] = [];
  const seen = new Set<string>();
  const add = (r: Row): void => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    const { owner_id, ...row } = r;
    result.push({ row: row as unknown as T & TextAttachmentOwner, resolved_message_id: owner_id });
  };
  viaMessageLinks.forEach(add);
  viaThreadLinks.forEach(add);

  // 2. Apple-id rows: pairs where the message carrying the attachment's Apple
  // id is not the attachment's own message.
  type Pair = { ar: number; mr: number };
  const ownMessage = new Map<number, number>(
    (
      db
        .prepare(
          `SELECT a.rowid AS ar, x.rowid AS mr FROM attachments a CROSS JOIN messages x ON x.id = a.message_id
           WHERE a.message_id IS NOT NULL`,
        )
        .all() as Pair[]
    ).map((p) => [p.ar, p.mr]),
  );
  const candidates = (
    db
      .prepare(
        `SELECT a.rowid AS ar, m.rowid AS mr FROM attachments a CROSS JOIN messages m ON m.external_id = a.external_message_id
         WHERE a.external_message_id IS NOT NULL`,
      )
      .all() as Pair[]
  )
    .filter((p) => ownMessage.get(p.ar) !== p.mr)
    .map((p) => [p.ar, p.mr]);
  if (candidates.length === 0) return result;

  for (const part of chunks(candidates)) {
    const rows = db
      .prepare(
        `SELECT a.*, ${ownerCols}
         FROM json_each(?) j
         CROSS JOIN attachments a ON a.rowid = json_extract(j.value, '$[0]')
         CROSS JOIN messages m ON m.rowid = json_extract(j.value, '$[1]')
         WHERE a.email_id IS NULL
           AND (EXISTS (SELECT 1 FROM communications c
                        WHERE c.message_id = m.id AND c.transaction_id = ?)
                OR EXISTS (SELECT 1 FROM communications c
                           WHERE c.thread_id = m.thread_id AND c.transaction_id = ?
                             AND c.message_id IS NULL AND +c.user_id = m.user_id))
           AND NOT EXISTS (SELECT 1 FROM attachments d WHERE d.message_id = m.id)${windowClause}
         ORDER BY j.key`,
      )
      .all(JSON.stringify(part), transactionId, transactionId, ...windowParams) as Row[];
    rows.forEach(add);
  }
  return result;
}
