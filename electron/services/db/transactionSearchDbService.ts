// ============================================
// TRANSACTION LINKED-CONTENT SEARCH (BACKLOG-1866)
// ============================================
// Powers the Overview-tab search bar. Searches ONLY content already linked to a
// single transaction: assigned contacts, linked emails, and linked texts.
//
// SCOPING GUARANTEE (the whole point of this feature):
//   - Contacts  → gated by transaction_contacts.transaction_id
//   - Emails    → gated by communications.email_id + communications.transaction_id
//   - Texts     → gated by communications (message_id OR thread_id-batch) + transaction_id
// A matching-but-UNLINKED row can never appear because every query is joined
// through the transaction's junction rows.
//
// MATCHING: parameterized `LIKE ... ESCAPE '\'` (SQLite LIKE is ASCII
// case-insensitive). Per the team's tsvector insight, email addresses tokenize
// as single FTS tokens, so identity fields use escaped LIKE (not FTS). Phone
// matching normalizes the query with the canonical `toLookupKey` helper and
// matches against the pre-normalized `contact_phones.phone_normalized` column.
// ALL user input is bound as a parameter — never string-interpolated.

import type { Database as DatabaseType } from "better-sqlite3";
import { toLookupKey } from "../../utils/phoneNormalization";
import { handleToIdentityToken } from "../../utils/handleIdentity";
import { reactionExclusion } from "./reactionExclusion";
import { ACTIVE_CONTACTS_CLAUSE_C } from "./contactTombstoneSql";

// ---------------------------------------------------------------------------
// Public result types (wire shape returned through IPC)
// ---------------------------------------------------------------------------

export interface LinkedContactHit {
  contactId: string;
  displayName: string;
  role: string | null;
}

export interface LinkedEmailHit {
  id: string;
  subject: string | null;
  sender: string | null;
  sentAt: string | null;
  snippet: string | null;
  /**
   * BACKLOG-1870 Phase 1.5: the attachment filename(s) that matched the query
   * (only the ones that matched, not every attachment). Absent when the email
   * matched on subject/body/sender only. Lets the UI show WHY the email surfaced.
   */
  matchedAttachmentFilenames?: string[];
}

export interface LinkedTextHit {
  id: string;
  sender: string | null;
  snippet: string | null;
  sentAt: string | null;
  /** BACKLOG-1870 Phase 1.5: attachment filename(s) that matched the query. */
  matchedAttachmentFilenames?: string[];
  /**
   * BACKLOG-2816: set ONLY on a thread-level (group chat name) hit — its presence
   * makes this row a CONVERSATION rather than a message, and the renderer shows
   * no body text on it at all.
   */
  threadDisplayName?: string;
  /** BACKLOG-2816: raw member handles, for the caller to resolve. Never rendered. */
  memberHandles?: string[];
  /**
   * BACKLOG-2816: resolved contact names of a few members. Unresolvable members
   * are OMITTED rather than shown as digits (founder: "with name not numbers").
   */
  memberNames?: string[];
}

export interface LinkedGroup<T> {
  /** Up to `limit` hits. */
  items: T[];
  /**
   * BACKLOG-2863: whether the database held MORE matches than `items` carries.
   *
   * IT REPLACED A COUNT, AND THE COUNT IS NOT COMING BACK. Six `SELECT COUNT(*)`
   * queries ran on every keystroke, uncapped, at 190-210 ms each — and unlike the
   * row queries they could not exit early, because proving a total means visiting
   * every match. Capping them would have made the badges read "200+".
   *
   * Founder, choosing between the two: *"i'm also fine with just show more and not
   * counting it."* So the panel now says "Show more" where it used to say a
   * number, and this flag is what that control is gated on.
   *
   * It costs nothing to know: each row query fetches ONE row beyond the limit, so
   * a group that came back full is a group with more behind it.
   */
  hasMore: boolean;
}

export interface LinkedContentSearchResults {
  contacts: LinkedGroup<LinkedContactHit>;
  emails: LinkedGroup<LinkedEmailHit>;
  /**
   * BACKLOG-2858: MESSAGE-level hits only — body, participants, or an attachment
   * filename matched. Each row IS the thing that matched.
   */
  texts: LinkedGroup<LinkedTextHit>;
  /**
   * BACKLOG-2858: THREAD-level hits — the conversation's NAME matched, and the
   * conversation is a group (2+ other members; see `GROUP_THREAD_PREDICATE`).
   *
   * Each row is a CONVERSATION, not a message — which is why the badge that used
   * to sit here counted conversations rather than the 546 messages inside one.
   * BACKLOG-2863 retired the badge altogether; `hasMore` is still derived from the
   * COLLAPSED set for the same reason the count was.
   *
   * Required, not optional, so every construction site is a compile error until
   * it decides what to put here.
   */
  groupChats: LinkedGroup<LinkedTextHit>;
}

// ---------------------------------------------------------------------------
// BACKLOG-1876: Global (unscoped) search result types
// ---------------------------------------------------------------------------
// The global mode drops the single-transaction gate. Each attributable hit
// carries the owning transaction (primary/earliest link) so the renderer can
// badge it and deep-navigate. "Unattached" collects emails/texts with no
// communications row (not linked to any transaction).

/** The transaction a global hit is attributed to (primary/earliest link). */
export interface TransactionAttribution {
  transactionId: string;
  propertyAddress: string;
}

/** A transaction whose address or a linked contact name matched the query. */
export interface GlobalTransactionHit {
  id: string;
  propertyAddress: string;
}

/** A contact (any of the user's) that matched, with its owning transaction. */
export interface GlobalContactHit {
  contactId: string;
  displayName: string;
  role: string | null;
  attribution: TransactionAttribution | null;
}

/** An email linked to some transaction that matched, with attribution. */
export interface GlobalEmailHit {
  id: string;
  subject: string | null;
  sender: string | null;
  sentAt: string | null;
  snippet: string | null;
  attribution: TransactionAttribution | null;
  /** BACKLOG-1870 Phase 1.5: attachment filename(s) that matched the query. */
  matchedAttachmentFilenames?: string[];
}

/** A text linked to some transaction that matched, with attribution. */
export interface GlobalTextHit {
  id: string;
  sender: string | null;
  snippet: string | null;
  sentAt: string | null;
  attribution: TransactionAttribution | null;
  /** BACKLOG-1870 Phase 1.5: attachment filename(s) that matched the query. */
  matchedAttachmentFilenames?: string[];
  /**
   * BACKLOG-2816: set ONLY on a thread-level (group chat name) hit. Its presence
   * is what makes this row a CONVERSATION rather than a message: the renderer
   * shows this as the primary line and shows no body text at all.
   */
  threadDisplayName?: string;
  /**
   * BACKLOG-2816: raw handles of the group's members, for the caller to resolve
   * to contact names. Never rendered as-is — see `memberNames`.
   */
  memberHandles?: string[];
  /**
   * BACKLOG-2816: resolved contact names of a few group members, filled in by the
   * handler via the shared `resolveHandles`. Members with no matching contact are
   * OMITTED rather than shown as digits (founder: "with name not numbers").
   */
  memberNames?: string[];
}

/** An email or text with NO communications row (not attached to any transaction). */
export interface UnattachedHit {
  kind: "email" | "text";
  id: string;
  /** Email subject or text sender — the primary display line. */
  title: string | null;
  sender: string | null;
  snippet: string | null;
  sentAt: string | null;
  /**
   * BACKLOG-2816: set ONLY on a thread-level (group chat name) hit — its presence
   * makes this row a CONVERSATION rather than a message, and the renderer shows
   * no body text on it at all.
   */
  threadDisplayName?: string;
  /** BACKLOG-2816: raw member handles, for the caller to resolve. Never rendered. */
  memberHandles?: string[];
  /**
   * BACKLOG-2816: resolved contact names of a few members. Unresolvable members
   * are OMITTED rather than shown as digits (founder: "with name not numbers").
   */
  memberNames?: string[];
}

/** Grouped results for a global search: six groups, all optional-empty. */
export interface GlobalContentSearchResults {
  transactions: LinkedGroup<GlobalTransactionHit>;
  contacts: LinkedGroup<GlobalContactHit>;
  emails: LinkedGroup<GlobalEmailHit>;
  /** BACKLOG-2858: message-level hits only — one row per message. */
  texts: LinkedGroup<GlobalTextHit>;
  /**
   * BACKLOG-2858: group-chat-name hits — one row per CONVERSATION.
   * See `LinkedContentSearchResults.groupChats`.
   */
  groupChats: LinkedGroup<GlobalTextHit>;
  /**
   * Emails and texts with no communications row. Group-chat-name rows for
   * UNATTACHED threads stay HERE rather than moving to `groupChats`
   * (BACKLOG-2858): the founder's ask was that a group chat stop appearing under
   * Texts, and this bucket is not Texts. Its rows are also inert by design (P1
   * has no standalone viewer), so hoisting them into a navigable Group chats
   * section would produce a row that either goes nowhere or sits dead among live
   * ones.
   */
  unattached: LinkedGroup<UnattachedHit>;
}

/**
 * Minimal structural interface for the better-sqlite3 database so this module
 * can be unit-tested with an injected fake (the native driver is mocked in the
 * jest tier). The real `Database` instance satisfies this shape.
 */
export interface SearchableDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
}

export interface SearchLinkedContentOptions {
  /** Max hits returned per group (default 20). */
  limit?: number;
}

const DEFAULT_LIMIT = 20;
const SNIPPET_LEN = 160;

// ---------------------------------------------------------------------------
// LIKE escaping
// ---------------------------------------------------------------------------

/**
 * Escape a raw search term for safe use inside a `LIKE ? ESCAPE '\'` clause.
 * Escapes the escape character first, then the two LIKE wildcards, so a query
 * of `50%` or `a_b` is matched literally instead of as a wildcard.
 */
export function escapeLike(term: string): string {
  return term
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

/** Wrap an already-escaped term as a `%term%` contains-pattern. */
function containsPattern(rawTerm: string): string {
  return `%${escapeLike(rawTerm)}%`;
}

// ---------------------------------------------------------------------------
// BACKLOG-1870: attachment-filename matching
// ---------------------------------------------------------------------------
// A filename token (e.g. "wire", "disclosure") should surface the containing
// email/text even when the word appears only in an attachment's name. Attachment
// metadata (filename) is persisted at sync — for emails by BACKLOG-1870, for texts
// already by the iMessage import. These are EXISTS predicates (scalar — no row
// fan-out, so no DISTINCT is required) and each adds exactly ONE bound `?` (the
// filename LIKE pattern) at its call site, appended after the body/sender params.
const EMAIL_ATTACHMENT_MATCH = `EXISTS (
        SELECT 1 FROM attachments a
        WHERE a.email_id = e.id AND a.filename LIKE ? ESCAPE '\\'
      )`;
// Texts link attachments by message_id; fall back to external_message_id because
// iMessage rows carry both and message_id can be remapped after sync.
const TEXT_ATTACHMENT_MATCH = `EXISTS (
        SELECT 1 FROM attachments a
        WHERE (a.message_id = m.id OR a.external_message_id = m.external_id)
          AND a.filename LIKE ? ESCAPE '\\'
      )`;

// ---------------------------------------------------------------------------
// BACKLOG-2858: what makes a conversation a GROUP CHAT
// ---------------------------------------------------------------------------
// Founder, verbatim: "group chat in the search should show up as a separate
// category called Group chats. (not under texts where it shows now)".
//
// A "has a display name" test is the wrong one and this is the boundary it gets
// wrong: Apple lets a 1:1 chat carry a name, and the name writer does not care.
// `syncMacChatThreadNames` is fed by `SELECT ROWID, display_name FROM chat WHERE
// display_name IS NOT NULL` — every named chat, group or not — so a named 1:1 has
// a `message_thread_names` row exactly like a group's.
//
// THE ROSTER IS THE TEST, AND THE IMPORTER IS WHY IT WORKS. `chat_members` is
// written into `messages.participants` only when the chat has more than one
// member (`macOSMessagesImportService`: `...(chatMembers && chatMembers.length > 1
// ? { chat_members: chatMembers } : {})`), and the list comes from Apple's
// `chat_handle_join JOIN handle`, which holds the OTHER ends and never the account
// owner. A 1:1 therefore yields exactly one handle and NO `chat_members` key; a
// group yields two or more.
//
// `>= 2` rather than "key present" is belt and braces: it also rejects a
// one-element or empty roster, shapes the importer does not currently write but
// which a test fixture or a future producer could.
//
// `json_valid` IS LOAD-BEARING, NOT DECORATION. `json_extract` THROWS `malformed
// JSON` on a bad blob rather than returning NULL — verified against
// better-sqlite3-multiple-ciphers before this predicate was chosen — so a single
// corrupt `participants` value would fail the whole search without the guard.
// (`json_array_length(NULL)` is NULL, so a NULL `participants` filters out
// quietly, as it should.)
const GROUP_THREAD_PREDICATE = `json_valid(m.participants)
      AND json_array_length(json_extract(m.participants, '$.chat_members')) >= 2`;

// BACKLOG-1870 Phase 1.5: also PROJECT the matched filename(s) so the UI can show
// WHY a hit surfaced. Correlated subqueries using the SAME escaped `filename LIKE ?`
// term as the filter — group_concat with a newline separator (filenames never
// contain newlines), split + de-duped + capped in `parseMatchedAttachments`. Each
// SELECT adds exactly ONE bound `?` at the FRONT of the statement (the SELECT list
// precedes WHERE), so callers prepend the pattern to `params`.
const MATCHED_ATTACHMENT_CAP = 5;
const EMAIL_MATCHED_ATTACHMENTS_SELECT = `(
      SELECT group_concat(a.filename, char(10))
      FROM attachments a
      WHERE a.email_id = e.id AND a.filename LIKE ? ESCAPE '\\'
    ) AS matchedAttachments`;
const TEXT_MATCHED_ATTACHMENTS_SELECT = `(
      SELECT group_concat(a.filename, char(10))
      FROM attachments a
      WHERE (a.message_id = m.id OR a.external_message_id = m.external_id)
        AND a.filename LIKE ? ESCAPE '\\'
    ) AS matchedAttachments`;

/**
 * BACKLOG-1870 Phase 1.5: turn the group_concat blob from a matched-attachments
 * projection into a de-duped, capped filename list. Returns undefined when nothing
 * matched (so the field is omitted and the UI shows no indicator).
 */
function parseMatchedAttachments(raw: unknown): string[] | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const seen = new Set<string>();
  for (const part of raw.split("\n")) {
    const name = part.trim();
    if (name) seen.add(name);
    if (seen.size >= MATCHED_ATTACHMENT_CAP) break;
  }
  return seen.size > 0 ? [...seen] : undefined;
}

// Markers let the injected test double route queries deterministically without
// parsing SQL. They are inert SQL comments in production.
//
// BACKLOG-1876: the global (unscoped) mode reuses the contacts/emails/texts
// markers (a single search issues EITHER scoped OR global queries, never both,
// so there is no routing collision) and adds transaction + unattached markers.
// Substring routing stays collision-free: "mad:search:unattached:emails" does
// not contain "mad:search:emails".
const MARK = {
  contacts: "/* mad:search:contacts */",
  emails: "/* mad:search:emails */",
  texts: "/* mad:search:texts */",
  // BACKLOG-2816: thread-level (group-name) text hits. Substring routing stays
  // collision-free — "mad:search:textthreads" does not contain "mad:search:texts".
  textThreads: "/* mad:search:textthreads */",
  // BACKLOG-2863: the per-row attribution lookup that replaced the `link` join.
  // Routing stays collision-free — "mad:search:textthreads:attribution" contains
  // "mad:search:textthreads", so a test double that routes the group-chat rows
  // and nothing else would answer this query too; every such double in the repo
  // therefore routes this marker EXPLICITLY, and it is listed FIRST wherever
  // routes are matched by substring.
  textThreadsAttribution: "/* mad:search:textthreads:attribution */",
  unattachedTextThreads: "/* mad:search:unattached:textthreads */",
  transactions: "/* mad:search:transactions */",
  unattachedEmails: "/* mad:search:unattached:emails */",
  unattachedTexts: "/* mad:search:unattached:texts */",
} as const;

// ---------------------------------------------------------------------------
// Query builders (pure — exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * BACKLOG-2863 removed `countSql` / `countParams` from this shape. See
 * `LinkedGroup.hasMore` for why, and `runGroup` for what replaced them.
 */
export interface BuiltQuery {
  sql: string;
  params: unknown[];
}

/**
 * BACKLOG-2858: what the three `build*TextThreadNameQuery` builders return.
 *
 * IT HAS NO `LIMIT` ON `sql`, and BACKLOG-2863 left that alone while removing
 * every count in the search path. The reason it never had a count is the reason
 * it still has no limit.
 *
 * The Group chats badge counts CONVERSATIONS. A conversation is not a
 * `thread_id`: BACKLOG-2854 established that Apple keeps several chat rows for
 * one human conversation, and the rule for merging them (same display name AND
 * same normalized member set) runs `handleToIdentityToken` over each roster — JS,
 * not SQL. So `SELECT COUNT(*)` over these rows would count Apple's chat rows and
 * report 2 for the one conversation the founder is looking at, which is the
 * BACKLOG-2854 defect moved into the badge.
 *
 * The total therefore has to come from the collapsed set, which means the fetch
 * cannot be truncated before the collapse. `sql` returns EVERY matching thread,
 * `runThreadNameGroup` collapses, and the caller's `limit` is applied to the
 * result. This also retires `THREAD_SIBLING_FETCH_PAD` — the padding existed
 * because `LIMIT` ran before the collapse, and now nothing does.
 *
 * The set is bounded by NAMED THREADS matching the query, not by messages: one
 * row per `thread_id` with a matching `message_thread_names.display_name`. It is
 * the same set the count query it replaces already had to scan.
 */
export interface ThreadNameBuiltQuery {
  sql: string;
  params: unknown[];
}

/**
 * Contacts assigned to the transaction, matching display name OR any email OR
 * any phone (digits-normalized). Scoped strictly by transaction_contacts.
 */
export function buildContactQuery(
  transactionId: string,
  rawQuery: string,
  limit: number,
): BuiltQuery {
  const pat = containsPattern(rawQuery);
  // Phone: only attempt a phone match when the query actually carries digits
  // (>= 3) — this avoids a short/incidental digit turning into a `%5%` pattern
  // that matches every stored number. When it does, normalize the query with the
  // canonical lookup-key helper so it lines up with the pre-normalized
  // `contact_phones.phone_normalized` column. Empty key ⇒ the `<> ''` guard
  // disables the phone predicate entirely.
  const digitsOnly = (rawQuery.match(/\d/g) || []).join("");
  const phoneKey = digitsOnly.length >= 3 ? toLookupKey(rawQuery) : "";
  const phonePat = phoneKey ? containsPattern(phoneKey) : "";

  // BACKLOG-2366: `tc.removed_at IS NULL` — searching within a transaction must
  // not return a party who was removed from it.
  const where = `
    WHERE tc.transaction_id = ?
      AND tc.removed_at IS NULL
      AND (
        c.display_name LIKE ? ESCAPE '\\'
        OR ce.email LIKE ? ESCAPE '\\'
        OR (? <> '' AND cp.phone_normalized LIKE ? ESCAPE '\\')
      )`;
  const from = `
    FROM transaction_contacts tc
    JOIN contacts c ON c.id = tc.contact_id
    LEFT JOIN contact_emails ce ON ce.contact_id = c.id
    LEFT JOIN contact_phones cp ON cp.contact_id = c.id`;
  const whereParams = [transactionId, pat, pat, phoneKey, phonePat];

  return {
    sql: `${MARK.contacts}
    SELECT DISTINCT c.id AS contactId, c.display_name AS displayName, tc.role AS role
    ${from}
    ${where}
    ORDER BY c.display_name COLLATE NOCASE ASC
    LIMIT ?`,
    params: [...whereParams, limit],
  };
}

/**
 * Emails linked to the transaction via the communications junction, matching
 * subject / body / sender / recipients. Unlinked emails are excluded because the
 * JOIN requires a communications row for THIS transaction.
 */
export function buildEmailQuery(
  transactionId: string,
  rawQuery: string,
  limit: number,
): BuiltQuery {
  const pat = containsPattern(rawQuery);
  const from = `
    FROM emails e
    JOIN communications comm ON comm.email_id = e.id`;
  const where = `
    WHERE comm.transaction_id = ?
      AND (
        e.subject LIKE ? ESCAPE '\\'
        OR e.body_plain LIKE ? ESCAPE '\\'
        OR e.sender LIKE ? ESCAPE '\\'
        OR e.recipients LIKE ? ESCAPE '\\'
        OR ${EMAIL_ATTACHMENT_MATCH}
      )`;
  const whereParams = [transactionId, pat, pat, pat, pat, pat];

  return {
    sql: `${MARK.emails}
    SELECT e.id AS id, e.subject AS subject, e.sender AS sender, e.sent_at AS sentAt,
           substr(e.body_plain, 1, ${SNIPPET_LEN}) AS snippet,
           ${EMAIL_MATCHED_ATTACHMENTS_SELECT}
    ${from}
    ${where}
    ORDER BY e.sent_at DESC
    LIMIT ?`,
    // Projection pattern binds first (SELECT precedes WHERE).
    params: [pat, ...whereParams, limit],
  };
}

/**
 * Texts (SMS/iMessage) linked to the transaction. Texts link either directly
 * (communications.message_id) or by thread batch (communications.thread_id with
 * no message/email). Matches body_text or the flattened participants.
 */
export function buildTextQuery(
  transactionId: string,
  rawQuery: string,
  limit: number,
): BuiltQuery {
  const pat = containsPattern(rawQuery);
  const from = `
    FROM messages m`;
  const where = `
    WHERE m.channel IN ('sms', 'imessage')
      AND ${reactionExclusion("m")}
      AND m.id IN (
        SELECT comm.message_id
        FROM communications comm
        WHERE comm.transaction_id = ? AND comm.message_id IS NOT NULL
        UNION
        SELECT m2.id
        FROM messages m2
        JOIN communications comm2 ON comm2.thread_id = m2.thread_id
        WHERE comm2.transaction_id = ?
          AND comm2.message_id IS NULL
          AND comm2.email_id IS NULL
          AND comm2.thread_id IS NOT NULL
      )
      AND (
        m.body_text LIKE ? ESCAPE '\\'
        OR m.participants_flat LIKE ? ESCAPE '\\'
        OR ${TEXT_ATTACHMENT_MATCH}
      )`;
  // BACKLOG-2858: rows and count share ONE predicate string again. The
  // thread-name clause used to be appended here and only here, so the badge
  // counted messages in name-matching threads whose rows had been collapsed away.
  // Those conversations now have their own category and their own badge; leaving
  // them in this count would head an empty Texts list with their message count.
  const whereParams = [transactionId, transactionId, pat, pat, pat];

  return {
    sql: `${MARK.texts}
    SELECT m.id AS id, m.body_text AS body_text, m.participants_flat AS participants_flat,
           m.sent_at AS sentAt,
           ${TEXT_MATCHED_ATTACHMENTS_SELECT}
    ${from}
    ${where}
    ORDER BY m.sent_at DESC
    LIMIT ?`,
    // Projection pattern binds first (SELECT precedes WHERE).
    params: [pat, ...whereParams, limit],
  };
}

/**
 * BACKLOG-2816 (founder test, 2026-08-23): texts linked to the transaction whose
 * THREAD carries a matching group chat name — ONE row per thread, not one per
 * message. BACKLOG-2858 routes these rows to the **Group chats** category and
 * restricts them to actual groups via `GROUP_THREAD_PREDICATE`.
 *
 * A NAMED 1:1 NOW MATCHES NOTHING HERE. It used to produce a thread row (an
 * "unmergeable" one, since it has no roster to agree on). It is not a group
 * chat, so it does not belong in a Group chats category, and BACKLOG-2858 chose
 * dropping it over inventing a third home for it. Its messages still surface
 * normally in Texts whenever a body or participant matches.
 *
 * THE ROW CARRIES NO MESSAGE CONTENT (founder ruling, 2026-08-23: "just show the
 * group name, not anything from the body"). Nothing in any message's body caused
 * this hit — the thread's NAME did — so a snippet here would be decoration that
 * implies a match that did not happen. It also keeps other people's
 * correspondence off a search-results screen, which is the right default for a
 * compliance product.
 *
 * What it projects instead is `participants`, so the caller can show a few of the
 * group's MEMBERS by resolved contact name. The `chat_members` array on the
 * representative message is the authoritative membership list (the same source
 * `MessageThreadCard.getThreadParticipants` treats as authoritative); `from`/`to`
 * on a single message is not, because one message names only its own two ends.
 *
 * `id` is the newest message's id on purpose: the result's click handler
 * deep-navigates by message id and locates the containing CONVERSATION card
 * (`msgs.some(m => m.id === targetId)`), so a collapsed row navigates exactly
 * where the 546 uncollapsed ones did.
 */
export function buildTextThreadNameQuery(
  transactionId: string,
  rawQuery: string,
): ThreadNameBuiltQuery {
  const pat = containsPattern(rawQuery);
  const linkage = `
        SELECT comm.message_id
        FROM communications comm
        WHERE comm.transaction_id = ? AND comm.message_id IS NOT NULL
        UNION
        SELECT m2.id
        FROM messages m2
        JOIN communications comm2 ON comm2.thread_id = m2.thread_id
        WHERE comm2.transaction_id = ?
          AND comm2.message_id IS NULL
          AND comm2.email_id IS NULL
          AND comm2.thread_id IS NOT NULL`;
  // One row per thread: rank the thread's messages by recency and keep the first.
  const ranked = `
    SELECT m.id AS id, m.participants AS participants, m.sent_at AS sentAt,
           tn.display_name AS threadDisplayName,
           ROW_NUMBER() OVER (
             PARTITION BY m.thread_id
             ORDER BY m.sent_at DESC, m.id ASC
           ) AS rn
    FROM messages m
    JOIN message_thread_names tn
      ON tn.thread_id = m.thread_id AND tn.user_id = m.user_id
    WHERE m.channel IN ('sms', 'imessage')
      AND ${reactionExclusion("m")}
      AND ${GROUP_THREAD_PREDICATE}
      AND m.id IN (${linkage})
      AND tn.display_name LIKE ? ESCAPE '\\'`;

  return {
    sql: `${MARK.textThreads}
    SELECT id, participants, sentAt, threadDisplayName
    FROM (${ranked})
    WHERE rn = 1
    ORDER BY sentAt DESC`,
    params: [transactionId, transactionId, pat],
  };
}

/**
 * BACKLOG-2863: the linkage test for a global group-chat row — "this message
 * belongs to SOME transaction" — as a pair of EXISTS predicates.
 *
 * ===========================================================================
 * WHY THIS IS NOT A JOIN ANY MORE
 * ===========================================================================
 * `buildGlobalTextThreadNameQuery` used to JOIN a materialized `link` table:
 * every transaction-linked message in the database, ROW_NUMBER-ranked to its
 * primary transaction. SQLite chose to DRIVE the query through that table, and
 * the plan read:
 *
 *     SCAN tn
 *     SEARCH rankedLink USING AUTOMATIC PARTIAL COVERING INDEX (rn=?)
 *     SEARCH m USING INDEX sqlite_autoindex_messages_1 (id=?)
 *
 * — a probe per message inside every matching named thread. At ONE character
 * nearly every named group chat matches, so a single keystroke fanned out across
 * every message in every named conversation. Measured on a synthetic 150k-message
 * corpus built from the real `schema.sql`: 6,185 ms for `"a"`, while the founder
 * typed the second letter of a word.
 *
 * An EXISTS is a SCALAR test, so it cannot be a join driver, and the planner is
 * free to drive `tn -> messages` through `idx_messages_thread_id`. That is
 * exactly what `buildUnattachedTextThreadNameQuery` — the same query shape minus
 * the join — has always done, and it is why the BACKLOG-2863 investigation
 * measured that sibling at 211 ms where this one cost 11,884.
 *
 * ===========================================================================
 * BOTH BRANCHES JOIN `transactions`, AND THAT IS LOAD-BEARING
 * ===========================================================================
 * The derived table this replaces INNER JOINed `transactions` before ranking, so
 * a `communications` row pointing at a transaction that no longer exists never
 * produced a link, and its message never surfaced as a thread row. An EXISTS
 * without that join would admit rows the old query excluded — a behaviour change
 * wearing a performance change's clothes. The identity test in
 * `transactionSearchDbService.threadJoinPlan-2863.test.ts` mutates exactly this
 * join out and watches the id sets diverge.
 *
 * The remaining differences from the old `ml` sub-select are all implied rather
 * than dropped: `comm.message_id = m.id` implies `message_id IS NOT NULL`, the
 * `JOIN transactions` implies `transaction_id IS NOT NULL`, and
 * `comm3.thread_id = m.thread_id` implies `thread_id IS NOT NULL` (a NULL
 * `thread_id` matches nothing, exactly as the old `JOIN ... ON comm3.thread_id =
 * m3.thread_id` matched nothing).
 */
const GLOBAL_THREAD_LINKAGE_EXISTS = `(
        EXISTS (
          SELECT 1
          FROM communications comm
          JOIN transactions t ON t.id = comm.transaction_id
          WHERE comm.message_id = m.id
        )
        OR EXISTS (
          SELECT 1
          FROM communications comm3
          JOIN transactions t ON t.id = comm3.transaction_id
          WHERE comm3.thread_id = m.thread_id
            AND comm3.message_id IS NULL
            AND comm3.email_id IS NULL
        )
      )`;

/**
 * Global analogue of `buildTextThreadNameQuery`: named GROUP threads linked to
 * ANY transaction, one row per thread.
 *
 * BACKLOG-2863 SPLIT THE ATTRIBUTION OUT OF THIS QUERY. It no longer projects
 * `attrTxnId` / `attrAddress`; `buildThreadNameAttributionQuery` resolves those
 * one row at a time, and `searchGlobalContent` runs it only for the rows that
 * survive the sibling collapse and the caller's limit — at most `limit` of them,
 * against a join that previously ranked every linked message in the database.
 *
 * That relocation is invisible to the result: attribution is read by neither
 * `threadCollapseKey` nor `compareThreadRows`, so it cannot influence which row
 * survives a merge, and the surviving row carries its own message id to look it
 * up with.
 */
export function buildGlobalTextThreadNameQuery(
  userId: string,
  rawQuery: string,
): ThreadNameBuiltQuery {
  const pat = containsPattern(rawQuery);
  const ranked = `
    SELECT m.id AS id, m.participants AS participants, m.sent_at AS sentAt,
           tn.display_name AS threadDisplayName,
           ROW_NUMBER() OVER (
             PARTITION BY m.thread_id
             ORDER BY m.sent_at DESC, m.id ASC
           ) AS rn
    FROM messages m
    JOIN message_thread_names tn
      ON tn.thread_id = m.thread_id AND tn.user_id = m.user_id
    WHERE m.user_id = ?
      AND m.channel IN ('sms', 'imessage')
      AND ${reactionExclusion("m")}
      AND ${GROUP_THREAD_PREDICATE}
      AND tn.display_name LIKE ? ESCAPE '\\'
      AND ${GLOBAL_THREAD_LINKAGE_EXISTS}`;

  return {
    sql: `${MARK.textThreads}
    SELECT id, participants, sentAt, threadDisplayName
    FROM (${ranked})
    WHERE rn = 1
    ORDER BY sentAt DESC`,
    params: [userId, pat],
  };
}

/**
 * BACKLOG-2863: the transaction ONE message is attributed to — the primary,
 * meaning earliest-linked, one.
 *
 * This is the old `link` derived table with its PARTITION restricted to a single
 * message: the same `UNION ALL` of direct (`communications.message_id`) and
 * thread-batch (`communications.thread_id`) links, the same `JOIN transactions`,
 * and the same `ROW_NUMBER() ... ORDER BY linked_at ASC, comm_id ASC` tie-break,
 * kept as a window function rather than an `ORDER BY ... LIMIT 1` so the ranking
 * is transcribed from the original rather than restated in a second dialect.
 *
 * `comm_id` breaks every tie because `communications.id` is a primary key and
 * the two UNION branches are disjoint (one takes `message_id IS NOT NULL`, the
 * other `message_id IS NULL`), so no `communications` row can appear twice for
 * one message.
 *
 * The SQL is INVARIANT — only the bound message id changes — so callers prepare
 * it once and step it per row.
 */
export function buildThreadNameAttributionQuery(
  messageId: string,
): ThreadNameBuiltQuery {
  return {
    sql: `${MARK.textThreadsAttribution}
    SELECT attrTxnId, attrAddress
    FROM (
      SELECT ml.transaction_id AS attrTxnId, t.property_address AS attrAddress,
             ROW_NUMBER() OVER (
               ORDER BY ml.linked_at ASC, ml.comm_id ASC
             ) AS rn
      FROM (
        SELECT comm.transaction_id AS transaction_id, comm.linked_at AS linked_at,
               comm.id AS comm_id
        FROM communications comm
        WHERE comm.message_id = ? AND comm.transaction_id IS NOT NULL
        UNION ALL
        SELECT comm3.transaction_id AS transaction_id, comm3.linked_at AS linked_at,
               comm3.id AS comm_id
        FROM messages m3
        JOIN communications comm3 ON comm3.thread_id = m3.thread_id
        WHERE m3.id = ?
          AND comm3.message_id IS NULL
          AND comm3.email_id IS NULL
          AND comm3.thread_id IS NOT NULL
          AND comm3.transaction_id IS NOT NULL
      ) ml
      JOIN transactions t ON t.id = ml.transaction_id
    )
    WHERE rn = 1`,
    params: [messageId, messageId],
  };
}

/**
 * Unattached analogue: named GROUP threads with NO communications row at all.
 *
 * BACKLOG-2858 gives this builder the same `GROUP_THREAD_PREDICATE` as the other
 * two — a named 1:1 must not surface as a thread row on ANY of the three
 * surfaces, or the category is a rule that holds in some places and not others.
 *
 * Its rows still land in the UNATTACHED bucket rather than Group chats; see
 * `GlobalContentSearchResults.unattached` for why.
 */
export function buildUnattachedTextThreadNameQuery(
  userId: string,
  rawQuery: string,
): ThreadNameBuiltQuery {
  const pat = containsPattern(rawQuery);
  const ranked = `
    SELECT m.id AS id, m.participants AS participants, m.sent_at AS sentAt,
           tn.display_name AS threadDisplayName,
           ROW_NUMBER() OVER (
             PARTITION BY m.thread_id
             ORDER BY m.sent_at DESC, m.id ASC
           ) AS rn
    FROM messages m
    JOIN message_thread_names tn
      ON tn.thread_id = m.thread_id AND tn.user_id = m.user_id
    WHERE m.user_id = ?
      AND m.channel IN ('sms', 'imessage')
      AND ${reactionExclusion("m")}
      AND NOT EXISTS (
        SELECT 1 FROM communications comm WHERE comm.message_id = m.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM communications comm3
        WHERE comm3.thread_id = m.thread_id
          AND comm3.message_id IS NULL
          AND comm3.email_id IS NULL
      )
      AND ${GROUP_THREAD_PREDICATE}
      AND tn.display_name LIKE ? ESCAPE '\\'`;

  return {
    sql: `${MARK.unattachedTextThreads}
    SELECT id, participants, sentAt, threadDisplayName
    FROM (${ranked})
    WHERE rn = 1
    ORDER BY sentAt DESC`,
    params: [userId, pat],
  };
}

// ---------------------------------------------------------------------------
// Row shaping
// ---------------------------------------------------------------------------

interface RawTextRow {
  id: string;
  body_text: string | null;
  participants_flat: string | null;
  sentAt: string | null;
  // BACKLOG-1870 Phase 1.5: group_concat blob of matched filenames. Present only
  // for the linked/global text queries (unattached does not project it).
  matchedAttachments?: string | null;
}

/**
 * BACKLOG-2816: how many group members a thread-level result row offers. The
 * founder asked for "a few of the members", not a roster — this row is a label
 * for a conversation, not a participant list.
 */
const MEMBER_PREVIEW_CAP = 3;

/** A raw row from any of the three `build*TextThreadNameQuery` builders. */
interface RawThreadNameRow {
  id: string;
  participants: string | null;
  sentAt: string | null;
  threadDisplayName: string | null;
}

/**
 * BACKLOG-2816: the group's member handles, from the representative message's
 * `chat_members` — Apple's authoritative membership list for the conversation.
 *
 * Deliberately NOT `from`/`to`: those describe one message's two ends, so a
 * five-person group would advertise two members and which two would depend on
 * whichever message happened to be newest.
 *
 * "me" and "unknown" are dropped — the founder is not a member he needs listed,
 * and "unknown" is a placeholder, not a person.
 */
function threadMemberHandles(participants: string | null): string[] {
  if (!participants) return [];
  try {
    const parsed = JSON.parse(participants) as { chat_members?: unknown };
    const members = parsed.chat_members;
    if (!Array.isArray(members)) return [];
    const out: string[] = [];
    for (const m of members) {
      if (typeof m !== "string") continue;
      const handle = m.trim();
      if (!handle || handle === "me" || handle === "unknown") continue;
      if (!out.includes(handle)) out.push(handle);
    }
    return out;
  } catch {
    // A malformed participants blob costs the member preview, nothing else.
    return [];
  }
}

/**
 * Shape a thread-level (group chat name) hit.
 *
 * `snippet` and `sender` are NULL BY CONSTRUCTION, not by omission: nothing in
 * any message's body caused this hit, so there is nothing to quote. The query
 * does not even project `body_text`, which is what stops a snippet creeping back
 * in later.
 */
function shapeThreadName(row: RawThreadNameRow): {
  id: string;
  sender: null;
  snippet: null;
  sentAt: string | null;
  threadDisplayName: string;
  memberHandles: string[];
} {
  return {
    id: row.id,
    sender: null,
    snippet: null,
    sentAt: row.sentAt,
    threadDisplayName: (row.threadDisplayName ?? "").trim(),
    memberHandles: threadMemberHandles(row.participants).slice(0, MEMBER_PREVIEW_CAP),
  };
}

// ---------------------------------------------------------------------------
// BACKLOG-2854: one conversation, several Apple chat rows
// ---------------------------------------------------------------------------
// The founder searched a group chat's name and got the SAME conversation twice,
// each row listing the same members in a different order.
//
// The three `build*TextThreadNameQuery` builders are NOT at fault. Each ranks a
// thread's messages and keeps `rn = 1`, so it emits exactly one row per
// `thread_id`. Two rows means two `thread_id` VALUES.
//
// They are real. The importer keys thread identity on the Apple `chat_id`
// (`macChatThreadId` -> `macos-chat-{id}`), and Apple keeps SEVERAL chat rows
// for one human conversation: an iMessage row and an SMS/MMS row, a fresh row
// after a member's handle changes, a row from a service migration. Each carries
// the same display name, and each contributes its own representative message —
// which is why the member ORDER differed between the two rows the founder saw.
//
// `thread_id` is a stable join key, so this is fixed HERE, at read time, and not
// by rewriting ids in the importer (a migration with a far larger blast radius).
//
// TWO CONDITIONS, NOT ONE. Threads merge only when the display name AND the
// normalized member set both match. Name alone would be a data-loss bug: two
// genuinely different groups can share a name ("Closing Team"), and merging
// those hides a conversation from search — the opposite of the defect, and worse.
// ---------------------------------------------------------------------------

/**
 * The thread's roster, reduced to sorted, deduped identity tokens.
 *
 * `chat_members` is Apple's authoritative membership list and is written only
 * when the chat has more than one member — so a 1:1 yields an EMPTY set, which
 * `threadCollapseKey` treats as "never mergeable". That is deliberate: a 1:1 has
 * no roster to agree on, so two 1:1 threads sharing a name must stay apart.
 *
 * The sort is only ever used to build a key compared for EQUALITY against
 * another key built by this same function, so JS's UTF-16 ordering is a
 * canonical form here, not a linguistic one.
 */
function threadIdentityTokens(participants: string | null): string[] {
  if (!participants) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(participants);
  } catch {
    return []; // a malformed blob must not merge anything
  }
  if (!parsed || typeof parsed !== "object") return [];
  const members = (parsed as { chat_members?: unknown }).chat_members;
  if (!Array.isArray(members)) return [];

  const tokens = new Set<string>();
  for (const m of members) {
    if (typeof m !== "string") continue;
    const token = handleToIdentityToken(m);
    if (token) tokens.add(token);
  }
  return [...tokens].sort();
}

/**
 * The key two sibling threads must share to be one conversation, or `null` for a
 * row that may never merge with anything.
 *
 * `JSON.stringify` rather than a joined string because an email handle may
 * contain almost any character, and a hand-picked delimiter is a collision
 * waiting to be found by a real address book.
 */
function threadCollapseKey(
  row: Pick<RawThreadNameRow, "participants" | "threadDisplayName">,
): string | null {
  const name = (row.threadDisplayName ?? "").trim();
  if (!name) return null;
  const tokens = threadIdentityTokens(row.participants);
  if (tokens.length === 0) return null;
  return JSON.stringify([name.toLowerCase(), ...tokens]);
}

/**
 * Newest first, then id ascending — the SAME order the builders' window function
 * uses to pick a thread's representative (`ORDER BY m.sent_at DESC, m.id ASC`).
 *
 * Stated explicitly because the builders' OUTER order is `sentAt DESC` with no
 * tiebreak, so two siblings sharing a timestamp arrive in an order SQLite does
 * not promise. Inheriting that order would make which conversation survives a
 * merge depend on it.
 */
function compareThreadRows(a: RawThreadNameRow, b: RawThreadNameRow): number {
  const aAt = a.sentAt ?? "";
  const bAt = b.sentAt ?? "";
  if (aAt !== bAt) return aAt > bAt ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/**
 * Collapse sibling threads to one row each.
 *
 * THE SURVIVING ROW IS THE NEWEST MESSAGE ACROSS THE MERGED THREADS. Two
 * consequences the caller depends on:
 *
 *   1. **The row's `id` is a MESSAGE id, and it is the id that travels
 *      downstream.** The result's click handler deep-navigates by message id and
 *      locates the containing conversation card (`msgs.some(m => m.id ===
 *      targetId)`), so carrying the newest message's id lands the user on the
 *      half of the conversation that is actually live. Carrying the other
 *      sibling's id would open a stale one.
 *   2. **Everything else on the row is that winner's** — its member list, and in
 *      global search its transaction attribution. A row must not advertise the
 *      newest activity beside a different thread's deal.
 */
function collapseThreadRows<TRaw extends RawThreadNameRow>(rows: TRaw[]): TRaw[] {
  const merged = new Map<string, TRaw>();
  const unmergeable: TRaw[] = [];

  for (const row of rows) {
    const key = threadCollapseKey(row);
    if (key === null) {
      unmergeable.push(row);
      continue;
    }
    const held = merged.get(key);
    if (!held || compareThreadRows(row, held) < 0) merged.set(key, row);
  }

  return [...merged.values(), ...unmergeable].sort(compareThreadRows);
}

/** First participant token ("from") from the denormalized participants_flat. */
function textSender(participantsFlat: string | null): string | null {
  if (!participantsFlat) return null;
  const first = participantsFlat.split(",")[0]?.trim();
  return first || null;
}

function shapeText(row: RawTextRow): LinkedTextHit {
  return {
    id: row.id,
    sender: textSender(row.participants_flat),
    snippet: row.body_text ? row.body_text.slice(0, SNIPPET_LEN) : null,
    sentAt: row.sentAt,
    matchedAttachmentFilenames: parseMatchedAttachments(row.matchedAttachments),
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run one group's row query and decide whether there is more behind it.
 *
 * BACKLOG-2863: THE CALLER BUILDS THE QUERY WITH `limit + 1` AND PASSES `limit`
 * HERE. Fetching one row past the end is the whole mechanism: if the extra row
 * came back there are more matches, and if it did not, the user is looking at all
 * of them. The row queries exit in ~0 ms under `LIMIT` and an index, so the probe
 * row is free — where the `SELECT COUNT(*)` it replaced had to visit every match
 * to report a number, six times per keystroke.
 */
function runGroup<TRaw, THit>(
  db: SearchableDb,
  built: BuiltQuery,
  limit: number,
  shape: (row: TRaw) => THit,
): LinkedGroup<THit> {
  const rows = db.prepare(built.sql).all(...built.params) as TRaw[];
  return {
    items: rows.slice(0, limit).map(shape),
    hasMore: rows.length > limit,
  };
}

/**
 * `runGroup` for the three thread-name builders, with the BACKLOG-2854 collapse
 * in between fetching and shaping.
 *
 * It collapses RAW rows, before `shapeThreadName`, for two reasons that both
 * come from the shaped row: `memberHandles` is truncated to
 * `MEMBER_PREVIEW_CAP`, so two siblings whose rosters differ only past the third
 * member would look identical; and the preview's ORDER follows each thread's own
 * representative message, so the same roster can shape into two different
 * previews. The raw `participants` blob has neither problem.
 *
 * BACKLOG-2858 established that this group's size can only be decided HERE, not
 * by a `COUNT(*)`: a conversation is a set of sibling threads, and which threads
 * are siblings is decided by `threadCollapseKey` in JS. SQL would count Apple's
 * chat rows and call one conversation 2 — the BACKLOG-2854 defect, relocated.
 * BACKLOG-2863 removed the count; `hasMore` is derived from the collapsed set for
 * exactly the same reason.
 *
 * `limit` is applied AFTER the collapse, so siblings cannot crowd a genuinely
 * distinct conversation out of the results (the reason the retired
 * `THREAD_SIBLING_FETCH_PAD` existed).
 */
function runThreadNameGroup<TRaw extends RawThreadNameRow, THit>(
  db: SearchableDb,
  built: ThreadNameBuiltQuery,
  limit: number,
  shape: (row: TRaw) => THit,
): LinkedGroup<THit> {
  const rows = db.prepare(built.sql).all(...built.params) as TRaw[];
  const conversations = collapseThreadRows(rows);
  return {
    items: conversations.slice(0, limit).map(shape),
    // BACKLOG-2863: derived from the COLLAPSED set, like the total it replaces.
    // These rows have no SQL `LIMIT` to probe past — the fetch is deliberately
    // uncapped so the collapse sees every sibling — so "is there more" is decided
    // here, after the merge, and never in the query.
    hasMore: conversations.length > limit,
  };
}

function emptyResults(): LinkedContentSearchResults {
  return {
    contacts: { items: [], hasMore: false },
    emails: { items: [], hasMore: false },
    texts: { items: [], hasMore: false },
    groupChats: { items: [], hasMore: false },
  };
}

/**
 * Search everything linked to a single transaction.
 *
 * @param db            injectable better-sqlite3 database (real or fake)
 * @param transactionId the ONLY transaction whose links are searched
 * @param rawQuery      user's raw query string (trimmed here; empty ⇒ no query)
 * @param options       { limit } max hits per group (default 20)
 */
export function searchLinkedContent(
  db: SearchableDb,
  transactionId: string,
  rawQuery: string,
  options: SearchLinkedContentOptions = {},
): LinkedContentSearchResults {
  const query = (rawQuery ?? "").trim();
  // Empty query ⇒ no panel; short-circuit before touching the database.
  if (query.length === 0) {
    return emptyResults();
  }

  const limit =
    options.limit && options.limit > 0 ? options.limit : DEFAULT_LIMIT;
  // BACKLOG-2863: every row query fetches ONE row past `limit`. That extra row is
  // the entire evidence for "Show more" — it came back, so there is more — and it
  // replaces six uncapped `SELECT COUNT(*)` queries that cost 190-210 ms each on
  // every keystroke. `runGroup` slices it back off before shaping.
  const probe = limit + 1;

  const contacts = runGroup<
    { contactId: string; displayName: string; role: string | null },
    LinkedContactHit
  >(db, buildContactQuery(transactionId, query, probe), limit, (row) => ({
    contactId: row.contactId,
    displayName: row.displayName,
    role: row.role ?? null,
  }));

  const emails = runGroup<
    {
      id: string;
      subject: string | null;
      sender: string | null;
      sentAt: string | null;
      snippet: string | null;
      matchedAttachments: string | null;
    },
    LinkedEmailHit
  >(db, buildEmailQuery(transactionId, query, probe), limit, (row) => ({
    id: row.id,
    subject: row.subject ?? null,
    sender: row.sender ?? null,
    sentAt: row.sentAt ?? null,
    snippet: row.snippet ?? null,
    matchedAttachmentFilenames: parseMatchedAttachments(row.matchedAttachments),
  }));

  // BACKLOG-2816 produced TWO row queries for texts and merged them into one
  // bucket. BACKLOG-2858 keeps the two queries and STOPS merging them.
  //
  //   - message rows -> `texts`: body / participants / attachment matched, so the
  //     row IS the thing that matched. One row per message.
  //   - thread rows -> `groupChats`: the group conversation's NAME matched. One
  //     row per conversation.
  //
  // Founder, verbatim: "group chat in the search should show up as a separate
  // category called Group chats. (not under texts where it shows now)". The two
  // shapes had shared a bucket only because nothing had asked otherwise; nothing
  // about them was ever alike.
  const texts = runGroup<RawTextRow, LinkedTextHit>(
    db,
    buildTextQuery(transactionId, query, probe),
    limit,
    shapeText,
  );
  const groupChats = runThreadNameGroup<RawThreadNameRow, LinkedTextHit>(
    db,
    buildTextThreadNameQuery(transactionId, query),
    limit,
    shapeThreadName,
  );

  return { contacts, emails, texts, groupChats };
}

// ===========================================================================
// BACKLOG-1876: GLOBAL (UNSCOPED) SEARCH
// ===========================================================================
// The global builders below drop the single-transaction gate and instead scope
// by the owner's user_id. They REUSE the scoped LIKE/escape helpers, the phone
// toLookupKey normalization, and the contact_phones.phone_normalized column
// VERBATIM — the only structural difference is the scope key and the added
// transaction attribution. Attribution for texts + contacts uses a
// ROW_NUMBER() window (PARTITION BY content id ORDER BY linked_at ASC, id ASC)
// so the primary/earliest link is chosen in a SINGLE pass without duplicating
// the thread-batch linkage predicate; emails use a correlated subquery (their
// link is a plain email_id row, so no thread-batch fan-out to worry about).

/** Raw attribution columns shared by attributable global rows. */
interface RawAttribution {
  attrTxnId: string | null;
  attrAddress: string | null;
}

function shapeAttribution(row: RawAttribution): TransactionAttribution | null {
  return row.attrTxnId
    ? { transactionId: row.attrTxnId, propertyAddress: row.attrAddress ?? "" }
    : null;
}

/**
 * BACKLOG-2863: a per-message attribution lookup that prepares its statement
 * ONCE and steps it per row.
 *
 * The statement is cached rather than re-prepared because `db.prepare` compiles
 * SQL and better-sqlite3 does not cache it for us; the SQL here is invariant
 * (only the bound id changes), so one compile serves the whole result set.
 *
 * A row that resolves to nothing yields `null`, the same shape the old LEFT-less
 * join produced for a message with no surviving link. In practice the row query's
 * linkage EXISTS has already guaranteed a link exists — the two use the same
 * `JOIN transactions` rule — so this is a guard, not a path the data takes.
 */
function threadAttributionResolver(
  db: SearchableDb,
): (messageId: string) => TransactionAttribution | null {
  let stmt: ReturnType<SearchableDb["prepare"]> | null = null;
  return (messageId: string) => {
    const built = buildThreadNameAttributionQuery(messageId);
    stmt ??= db.prepare(built.sql);
    const row = stmt.get(...built.params) as RawAttribution | undefined;
    return row ? shapeAttribution(row) : null;
  };
}

/**
 * Transactions whose property_address OR a linked contact's display_name
 * matches. Single pass; DISTINCT collapses the contact-join fan-out.
 */
export function buildTransactionsQuery(
  userId: string,
  rawQuery: string,
  limit: number,
): BuiltQuery {
  const pat = containsPattern(rawQuery);
  // BACKLOG-2366: the tombstone filter belongs in the JOIN condition, NOT the
  // WHERE. In the WHERE it would silently convert this LEFT JOIN to an inner
  // one for any transaction whose only party has been removed — that
  // transaction would then stop matching on `property_address` too, which has
  // nothing to do with its parties. In the ON clause the row is simply
  // NULL-extended, so address search still finds it.
  const from = `
    FROM transactions t
    LEFT JOIN transaction_contacts tc
      ON tc.transaction_id = t.id AND tc.removed_at IS NULL
    LEFT JOIN contacts c ON c.id = tc.contact_id`;
  const where = `
    WHERE t.user_id = ?
      AND (
        t.property_address LIKE ? ESCAPE '\\'
        OR c.display_name LIKE ? ESCAPE '\\'
      )`;
  const whereParams = [userId, pat, pat];

  return {
    sql: `${MARK.transactions}
    SELECT DISTINCT t.id AS id, t.property_address AS propertyAddress
    ${from}
    ${where}
    ORDER BY t.property_address COLLATE NOCASE ASC
    LIMIT ?`,
    params: [...whereParams, limit],
  };
}

/**
 * Any of the user's contacts matching name / email / phone (email + phone via
 * EXISTS to avoid join fan-out), attributed to their primary owning transaction
 * (is_primary first, then earliest assignment) via a ROW_NUMBER window. Contacts
 * with no assignment surface with a null attribution ("Not attached").
 */
export function buildGlobalContactQuery(
  userId: string,
  rawQuery: string,
  limit: number,
): BuiltQuery {
  const pat = containsPattern(rawQuery);
  const digitsOnly = (rawQuery.match(/\d/g) || []).join("");
  const phoneKey = digitsOnly.length >= 3 ? toLookupKey(rawQuery) : "";
  const phonePat = phoneKey ? containsPattern(phoneKey) : "";

  const match = `
      c.display_name LIKE ? ESCAPE '\\'
      OR EXISTS (
        SELECT 1 FROM contact_emails ce
        WHERE ce.contact_id = c.id AND ce.email LIKE ? ESCAPE '\\'
      )
      OR (
        ? <> '' AND EXISTS (
          SELECT 1 FROM contact_phones cp
          WHERE cp.contact_id = c.id AND cp.phone_normalized LIKE ? ESCAPE '\\'
        )
      )`;
  // Params for the match predicate, in bind order.
  const matchParams = [pat, pat, phoneKey, phonePat];

  const sql = `${MARK.contacts}
    SELECT ranked.contactId AS contactId,
           ranked.displayName AS displayName,
           ranked.role AS role,
           ranked.attrTxnId AS attrTxnId,
           ranked.attrAddress AS attrAddress
    FROM (
      SELECT
        c.id AS contactId,
        c.display_name AS displayName,
        tc.role AS role,
        t.id AS attrTxnId,
        t.property_address AS attrAddress,
        ROW_NUMBER() OVER (
          PARTITION BY c.id
          ORDER BY tc.is_primary DESC, tc.created_at ASC, t.id ASC
        ) AS rn
      FROM contacts c
      -- BACKLOG-2366: filtered in the ON clause so a contact whose only role was
      -- removed still appears in global search under their own name — just
      -- without being attributed to the deal they are no longer on. In the WHERE
      -- clause they would disappear from search entirely.
      LEFT JOIN transaction_contacts tc
        ON tc.contact_id = c.id AND tc.removed_at IS NULL
      LEFT JOIN transactions t ON t.id = tc.transaction_id
      WHERE c.user_id = ?${ACTIVE_CONTACTS_CLAUSE_C}
        AND (${match})
    ) ranked
    WHERE ranked.rn = 1
    ORDER BY ranked.displayName COLLATE NOCASE ASC
    LIMIT ?`;

  // BACKLOG-2365: this tombstone filter MUST stay identical to the rows query
  // above. The two are read together — the count labels that list — so any
  // divergence shows the user "12 contacts" above a list of 9.

  return {
    sql,
    params: [userId, ...matchParams, limit],
  };
}

/**
 * Emails linked to ANY transaction, matching subject/body/sender/recipients,
 * attributed to the primary (earliest-linked) transaction via a correlated
 * subquery that pins exactly one communications row per email.
 */
export function buildGlobalEmailQuery(
  userId: string,
  rawQuery: string,
  limit: number,
): BuiltQuery {
  const pat = containsPattern(rawQuery);
  const match = `
      e.subject LIKE ? ESCAPE '\\'
      OR e.body_plain LIKE ? ESCAPE '\\'
      OR e.sender LIKE ? ESCAPE '\\'
      OR e.recipients LIKE ? ESCAPE '\\'
      OR ${EMAIL_ATTACHMENT_MATCH}`;
  const matchParams = [pat, pat, pat, pat, pat];

  const sql = `${MARK.emails}
    SELECT e.id AS id, e.subject AS subject, e.sender AS sender, e.sent_at AS sentAt,
           substr(e.body_plain, 1, ${SNIPPET_LEN}) AS snippet,
           ${EMAIL_MATCHED_ATTACHMENTS_SELECT},
           t.id AS attrTxnId, t.property_address AS attrAddress
    FROM emails e
    JOIN communications comm ON comm.id = (
      SELECT c2.id FROM communications c2
      WHERE c2.email_id = e.id AND c2.transaction_id IS NOT NULL
      ORDER BY c2.linked_at ASC, c2.id ASC
      LIMIT 1
    )
    JOIN transactions t ON t.id = comm.transaction_id
    WHERE e.user_id = ?
      AND (${match})
    ORDER BY e.sent_at DESC
    LIMIT ?`;


  return {
    // Projection pattern binds first (SELECT precedes WHERE).
    sql,
    params: [pat, userId, ...matchParams, limit],
  };
}

/**
 * Texts (sms/imessage) linked to ANY transaction — directly (message_id) or by
 * thread batch (thread_id) — matching body/participants, attributed to the
 * primary (earliest-linked) transaction. The linkage rows are UNION-ed once and
 * a ROW_NUMBER window picks the primary per message, so the thread-batch
 * predicate is written exactly once (avoids the correlated-subquery duplication
 * bug the SR flagged).
 */
export function buildGlobalTextQuery(
  userId: string,
  rawQuery: string,
  limit: number,
): BuiltQuery {
  const pat = containsPattern(rawQuery);
  const match = `
      m.body_text LIKE ? ESCAPE '\\'
      OR m.participants_flat LIKE ? ESCAPE '\\'
      OR ${TEXT_ATTACHMENT_MATCH}`;
  const matchParams = [pat, pat, pat];

  // Membership set: messages linked to some transaction (direct or thread-batch).
  const memberSet = `
      SELECT comm.message_id AS mid
      FROM communications comm
      WHERE comm.message_id IS NOT NULL AND comm.transaction_id IS NOT NULL
      UNION
      SELECT m2.id AS mid
      FROM messages m2
      JOIN communications comm2 ON comm2.thread_id = m2.thread_id
      WHERE comm2.message_id IS NULL
        AND comm2.email_id IS NULL
        AND comm2.thread_id IS NOT NULL
        AND comm2.transaction_id IS NOT NULL`;

  const sql = `${MARK.texts}
    SELECT m.id AS id, m.body_text AS body_text, m.participants_flat AS participants_flat,
           m.sent_at AS sentAt,
           ${TEXT_MATCHED_ATTACHMENTS_SELECT},
           link.attrTxnId AS attrTxnId, link.attrAddress AS attrAddress
    FROM messages m
    JOIN (
      SELECT msg_id, transaction_id AS attrTxnId, property_address AS attrAddress
      FROM (
        SELECT ml.msg_id AS msg_id, ml.transaction_id AS transaction_id,
               t.property_address AS property_address,
               ROW_NUMBER() OVER (
                 PARTITION BY ml.msg_id
                 ORDER BY ml.linked_at ASC, ml.comm_id ASC
               ) AS rn
        FROM (
          SELECT comm.message_id AS msg_id, comm.transaction_id AS transaction_id,
                 comm.linked_at AS linked_at, comm.id AS comm_id
          FROM communications comm
          WHERE comm.message_id IS NOT NULL AND comm.transaction_id IS NOT NULL
          UNION ALL
          SELECT m3.id AS msg_id, comm3.transaction_id AS transaction_id,
                 comm3.linked_at AS linked_at, comm3.id AS comm_id
          FROM messages m3
          JOIN communications comm3 ON comm3.thread_id = m3.thread_id
          WHERE comm3.message_id IS NULL
            AND comm3.email_id IS NULL
            AND comm3.thread_id IS NOT NULL
            AND comm3.transaction_id IS NOT NULL
        ) ml
        JOIN transactions t ON t.id = ml.transaction_id
      ) ranked
      WHERE ranked.rn = 1
    ) link ON link.msg_id = m.id
    WHERE m.user_id = ?
      AND m.channel IN ('sms', 'imessage')
      AND ${reactionExclusion("m")}
      AND (${match})
    ORDER BY m.sent_at DESC
    LIMIT ?`;


  return {
    // Projection pattern binds first (SELECT precedes WHERE).
    sql,
    params: [pat, userId, ...matchParams, limit],
  };
}

/** Emails with NO communications row (not attached to any transaction). */
export function buildUnattachedEmailQuery(
  userId: string,
  rawQuery: string,
  limit: number,
): BuiltQuery {
  const pat = containsPattern(rawQuery);
  const from = `
    FROM emails e`;
  const where = `
    WHERE e.user_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM communications comm WHERE comm.email_id = e.id
      )
      AND (
        e.subject LIKE ? ESCAPE '\\'
        OR e.body_plain LIKE ? ESCAPE '\\'
        OR e.sender LIKE ? ESCAPE '\\'
        OR e.recipients LIKE ? ESCAPE '\\'
        OR ${EMAIL_ATTACHMENT_MATCH}
      )`;
  const whereParams = [userId, pat, pat, pat, pat, pat];

  return {
    sql: `${MARK.unattachedEmails}
    SELECT e.id AS id, e.subject AS subject, e.sender AS sender, e.sent_at AS sentAt,
           substr(e.body_plain, 1, ${SNIPPET_LEN}) AS snippet
    ${from}
    ${where}
    ORDER BY e.sent_at DESC
    LIMIT ?`,
    params: [...whereParams, limit],
  };
}

/**
 * Texts with NO communications row — neither a direct message_id link nor a
 * thread-batch link — matching body/participants.
 */
export function buildUnattachedTextQuery(
  userId: string,
  rawQuery: string,
  limit: number,
): BuiltQuery {
  const pat = containsPattern(rawQuery);
  const from = `
    FROM messages m`;
  const where = `
    WHERE m.user_id = ?
      AND m.channel IN ('sms', 'imessage')
      AND ${reactionExclusion("m")}
      AND NOT EXISTS (
        SELECT 1 FROM communications comm WHERE comm.message_id = m.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM communications comm3
        WHERE comm3.thread_id = m.thread_id
          AND comm3.message_id IS NULL
          AND comm3.email_id IS NULL
      )
      AND (
        m.body_text LIKE ? ESCAPE '\\'
        OR m.participants_flat LIKE ? ESCAPE '\\'
        OR ${TEXT_ATTACHMENT_MATCH}
      )`;
  const whereParams = [userId, pat, pat, pat];

  return {
    sql: `${MARK.unattachedTexts}
    SELECT m.id AS id, m.body_text AS body_text, m.participants_flat AS participants_flat,
           m.sent_at AS sentAt
    ${from}
    ${where}
    ORDER BY m.sent_at DESC
    LIMIT ?`,
    params: [...whereParams, limit],
  };
}

// ---------------------------------------------------------------------------
// Global row shaping
// ---------------------------------------------------------------------------

interface RawGlobalEmailRow extends RawAttribution {
  id: string;
  subject: string | null;
  sender: string | null;
  sentAt: string | null;
  snippet: string | null;
  matchedAttachments: string | null;
}

interface RawGlobalTextRow extends RawAttribution {
  id: string;
  body_text: string | null;
  participants_flat: string | null;
  sentAt: string | null;
  matchedAttachments: string | null;
}

function shapeGlobalEmail(row: RawGlobalEmailRow): GlobalEmailHit {
  return {
    id: row.id,
    subject: row.subject ?? null,
    sender: row.sender ?? null,
    sentAt: row.sentAt ?? null,
    snippet: row.snippet ?? null,
    attribution: shapeAttribution(row),
    matchedAttachmentFilenames: parseMatchedAttachments(row.matchedAttachments),
  };
}

function shapeGlobalText(row: RawGlobalTextRow): GlobalTextHit {
  return {
    id: row.id,
    sender: textSender(row.participants_flat),
    snippet: row.body_text ? row.body_text.slice(0, SNIPPET_LEN) : null,
    sentAt: row.sentAt,
    attribution: shapeAttribution(row),
    matchedAttachmentFilenames: parseMatchedAttachments(row.matchedAttachments),
  };
}

function shapeUnattachedEmail(row: {
  id: string;
  subject: string | null;
  sender: string | null;
  sentAt: string | null;
  snippet: string | null;
}): UnattachedHit {
  return {
    kind: "email",
    id: row.id,
    title: row.subject ?? null,
    sender: row.sender ?? null,
    snippet: row.snippet ?? null,
    sentAt: row.sentAt ?? null,
  };
}

function shapeUnattachedText(row: RawTextRow): UnattachedHit {
  const sender = textSender(row.participants_flat);
  return {
    kind: "text",
    id: row.id,
    title: sender,
    sender,
    snippet: row.body_text ? row.body_text.slice(0, SNIPPET_LEN) : null,
    sentAt: row.sentAt,
  };
}

function emptyGlobalResults(): GlobalContentSearchResults {
  return {
    transactions: { items: [], hasMore: false },
    contacts: { items: [], hasMore: false },
    emails: { items: [], hasMore: false },
    texts: { items: [], hasMore: false },
    groupChats: { items: [], hasMore: false },
    unattached: { items: [], hasMore: false },
  };
}

/**
 * Global (unscoped) search across all of a user's content. Mirrors
 * searchLinkedContent but keyed by user_id, returning five groups with
 * transaction attribution and an "unattached" bucket.
 *
 * @param db       injectable better-sqlite3 database (real or fake)
 * @param userId   owner whose content is searched
 * @param rawQuery user's raw query string (trimmed here; empty ⇒ no query)
 * @param options  { limit } max hits per group (default 20)
 */
export function searchGlobalContent(
  db: SearchableDb,
  userId: string,
  rawQuery: string,
  options: SearchLinkedContentOptions = {},
): GlobalContentSearchResults {
  const query = (rawQuery ?? "").trim();
  if (query.length === 0) {
    return emptyGlobalResults();
  }

  const limit =
    options.limit && options.limit > 0 ? options.limit : DEFAULT_LIMIT;

  // BACKLOG-2863: every row query fetches ONE row past `limit`. That extra row is
  // the entire evidence for "Show more" — it came back, so there is more — and it
  // replaces six uncapped `SELECT COUNT(*)` queries that cost 190-210 ms each on
  // every keystroke. `runGroup` slices it back off before shaping.
  const probe = limit + 1;

  const transactions = runGroup<
    { id: string; propertyAddress: string },
    GlobalTransactionHit
  >(db, buildTransactionsQuery(userId, query, probe), limit, (row) => ({
    id: row.id,
    propertyAddress: row.propertyAddress,
  }));

  const contacts = runGroup<
    {
      contactId: string;
      displayName: string;
      role: string | null;
      attrTxnId: string | null;
      attrAddress: string | null;
    },
    GlobalContactHit
  >(db, buildGlobalContactQuery(userId, query, probe), limit, (row) => ({
    contactId: row.contactId,
    displayName: row.displayName,
    role: row.role ?? null,
    attribution: shapeAttribution(row),
  }));

  const emails = runGroup<RawGlobalEmailRow, GlobalEmailHit>(
    db,
    buildGlobalEmailQuery(userId, query, probe),
    limit,
    shapeGlobalEmail,
  );

  // BACKLOG-2858: same split as the scoped search — message rows to `texts`,
  // group-conversation rows to `groupChats`. See `searchLinkedContent`.
  const texts = runGroup<RawGlobalTextRow, GlobalTextHit>(
    db,
    buildGlobalTextQuery(userId, query, probe),
    limit,
    shapeGlobalText,
  );
  // BACKLOG-2863: attribution is resolved ROW BY ROW, and only for the rows a
  // user will actually see. `runThreadNameGroup` applies `shape` AFTER the
  // sibling collapse and after `limit`, so this runs at most `limit` times (20 by
  // default) against a prepared statement — where the query it replaced ranked
  // every transaction-linked message in the database on every keystroke.
  //
  // Resolving it here rather than in the row query cannot change a result:
  // neither `threadCollapseKey` nor `compareThreadRows` reads attribution, so it
  // cannot decide which sibling survives, and the survivor carries the message id
  // its attribution is looked up by.
  const resolveThreadAttribution = threadAttributionResolver(db);
  const groupChats = runThreadNameGroup<RawThreadNameRow, GlobalTextHit>(
    db,
    buildGlobalTextThreadNameQuery(userId, query),
    limit,
    (row) => ({
      ...shapeThreadName(row),
      attribution: resolveThreadAttribution(row.id),
    }),
  );

  // Unattached bucket = emails + texts with no communications row. Two queries,
  // merged into one group.
  const unattachedEmails = runGroup<
    {
      id: string;
      subject: string | null;
      sender: string | null;
      sentAt: string | null;
      snippet: string | null;
    },
    UnattachedHit
  >(db, buildUnattachedEmailQuery(userId, query, probe), limit, shapeUnattachedEmail);

  const unattachedTexts = runGroup<RawTextRow, UnattachedHit>(
    db,
    buildUnattachedTextQuery(userId, query, probe),
    limit,
    shapeUnattachedText,
  );
  // BACKLOG-2816: named threads in the unattached bucket collapse the same way.
  // BACKLOG-2858: they STAY in this bucket rather than joining `groupChats` —
  // see `GlobalContentSearchResults.unattached`.
  const unattachedTextThreads = runThreadNameGroup<RawThreadNameRow, UnattachedHit>(
    db,
    buildUnattachedTextThreadNameQuery(userId, query),
    limit,
    (row) => ({ kind: "text" as const, title: null, ...shapeThreadName(row) }),
  );

  // Thread rows lead, then the date-sorted message/email rows — the same
  // precedence the linked and global groups use.
  const unattachedMerged = [
    ...unattachedTextThreads.items,
    ...[...unattachedEmails.items, ...unattachedTexts.items].sort((a, b) =>
      (b.sentAt ?? "").localeCompare(a.sentAt ?? ""),
    ),
  ];
  const unattachedItems = unattachedMerged.slice(0, limit);

  return {
    transactions,
    contacts,
    emails,
    texts,
    groupChats,
    unattached: {
      items: unattachedItems,
      // BACKLOG-2863: THREE sources feed this one bucket, and each is capped
      // before they meet. The merged length alone would under-report — three
      // groups of exactly `limit` rows merge to more than `limit`, but three
      // groups that each had more behind them can merge to fewer — so the
      // sub-groups' own `hasMore` counts too.
      hasMore:
        unattachedMerged.length > limit ||
        unattachedEmails.hasMore ||
        unattachedTexts.hasMore ||
        unattachedTextThreads.hasMore,
    },
  };
}
