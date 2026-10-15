/**
 * BACKLOG-3837 follow-up — the Attach Messages roster (contacts with unlinked texts),
 * defined once so the dedicated worker and the test oracle run ONE implementation
 * (moved verbatim from messageDbService.getMessageContacts).
 *
 * Both statements group every unlinked sms/imessage row of the user with json_extract
 * per row: 2.7 s on main at 668k messages on a Mac, measured. Production reads it only on
 * a dedicated worker.
 */
import { reactionExclusion } from "./reactionExclusion";
import type { MessageScanRunner } from "./wizardMessageScansDb";

/** A roster entry in the contact-first message picker. */
export interface MessageContactRow {
  contact: string;
  messageCount: number;
  lastMessageAt: string;
  /**
   * BACKLOG-2816: the user-visible names of the GROUP conversations this contact
   * appears in ("Kingfisher Lane Closing"), so the picker's search box can match
   * on a name the founder typed in Messages and not only on people and numbers.
   * Empty for a contact with no named group — which is every 1:1 contact.
   */
  threadNames: string[];
}

/**
 * The roster's contact expression and its scope filter, written ONCE.
 *
 * BACKLOG-2816 added a second query over the same population (the group names
 * per contact). Both must see exactly the same rows: if the name query were
 * scoped even slightly differently, a group name would surface a contact the
 * roster does not list, and the picker would filter to an empty list.
 */
const ROSTER_CONTACT_EXPR = `
      COALESCE(
        CASE
          WHEN m.direction = 'inbound' THEN json_extract(m.participants, '$.from')
          ELSE json_extract(m.participants, '$.to[0]')
        END,
        m.thread_id
      )`;
const ROSTER_SCOPE = `
      m.user_id = ?
      AND m.transaction_id IS NULL
      AND m.channel IN ('sms', 'imessage')
      AND m.participants IS NOT NULL
      AND ${reactionExclusion("m")}`;
const ROSTER_CONTACT_GUARD = `contact IS NOT NULL AND contact != 'me' AND contact != 'unknown' AND contact != ''`;

export const MESSAGE_ROSTER_SQL = `
    SELECT
      ${ROSTER_CONTACT_EXPR} as contact,
      COUNT(*) as messageCount,
      MAX(m.sent_at) as lastMessageAt
    FROM messages m
    WHERE ${ROSTER_SCOPE}
    GROUP BY contact
    HAVING ${ROSTER_CONTACT_GUARD}
    ORDER BY lastMessageAt DESC
  `;

/** BACKLOG-2816: the group names per roster contact (see the note in runMessageRosterOn). */
export const MESSAGE_ROSTER_NAMES_SQL = `
    SELECT contact, threadName
    FROM (
      SELECT
        ${ROSTER_CONTACT_EXPR} as contact,
        tn.display_name as threadName
      FROM messages m
      JOIN message_thread_names tn
        ON tn.thread_id = m.thread_id AND tn.user_id = m.user_id
      WHERE ${ROSTER_SCOPE}
    )
    WHERE ${ROSTER_CONTACT_GUARD}
      AND threadName IS NOT NULL AND TRIM(threadName) != ''
    GROUP BY contact, threadName
  `;

/**
 * Get distinct contacts (phone numbers) with unlinked message counts
 * Used for contact-first message browsing. Runs on the connection it is given:
 * the dedicated worker in production (messageRosterCache.ts), main only in tests.
 */
export function runMessageRosterOn(db: MessageScanRunner, userId: string): MessageContactRow[] {
  const sql = MESSAGE_ROSTER_SQL;
  const rows = db.prepare(sql).all(userId) as Array<{
    contact: string;
    messageCount: number;
    lastMessageAt: string;
  }>;

  // BACKLOG-2816: group names, as a SECOND query rather than a join + aggregate
  // on the one above. A `group_concat` would have to pick a separator, and a
  // group name is user-typed text that can contain any separator worth picking;
  // splitting it back apart would silently cut names in half. A second query
  // also keeps `COUNT(*) as messageCount` provably untouched.
  //
  // The join key is `(user_id, thread_id)` — the table's PK. macOS thread ids
  // are unique only per machine, so two users of one database can hold the same
  // thread_id, and joining on thread_id alone would put one user's group name
  // on another user's roster entry.
  const namesSql = MESSAGE_ROSTER_NAMES_SQL;
  const nameRows = db.prepare(namesSql).all(userId) as Array<{
    contact: string;
    threadName: string;
  }>;

  const namesByContact = new Map<string, string[]>();
  for (const { contact, threadName } of nameRows) {
    const list = namesByContact.get(contact);
    if (list) list.push(threadName);
    else namesByContact.set(contact, [threadName]);
  }

  return rows.map((r) => ({ ...r, threadNames: namesByContact.get(r.contact) ?? [] }));
}

