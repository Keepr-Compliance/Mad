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
}

export interface LinkedTextHit {
  id: string;
  sender: string | null;
  snippet: string | null;
  sentAt: string | null;
}

export interface LinkedGroup<T> {
  /** Up to `limit` hits. */
  items: T[];
  /** Total number of matches for this group (may exceed items.length). */
  total: number;
}

export interface LinkedContentSearchResults {
  contacts: LinkedGroup<LinkedContactHit>;
  emails: LinkedGroup<LinkedEmailHit>;
  texts: LinkedGroup<LinkedTextHit>;
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
}

/** A text linked to some transaction that matched, with attribution. */
export interface GlobalTextHit {
  id: string;
  sender: string | null;
  snippet: string | null;
  sentAt: string | null;
  attribution: TransactionAttribution | null;
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
}

/** Grouped results for a global search: five groups, all optional-empty. */
export interface GlobalContentSearchResults {
  transactions: LinkedGroup<GlobalTransactionHit>;
  contacts: LinkedGroup<GlobalContactHit>;
  emails: LinkedGroup<GlobalEmailHit>;
  texts: LinkedGroup<GlobalTextHit>;
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
  contactsCount: "/* mad:search:contacts:count */",
  emails: "/* mad:search:emails */",
  emailsCount: "/* mad:search:emails:count */",
  texts: "/* mad:search:texts */",
  textsCount: "/* mad:search:texts:count */",
  transactions: "/* mad:search:transactions */",
  transactionsCount: "/* mad:search:transactions:count */",
  unattachedEmails: "/* mad:search:unattached:emails */",
  unattachedEmailsCount: "/* mad:search:unattached:emails:count */",
  unattachedTexts: "/* mad:search:unattached:texts */",
  unattachedTextsCount: "/* mad:search:unattached:texts:count */",
} as const;

// ---------------------------------------------------------------------------
// Query builders (pure — exported for unit testing)
// ---------------------------------------------------------------------------

export interface BuiltQuery {
  sql: string;
  params: unknown[];
  countSql: string;
  countParams: unknown[];
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

  const where = `
    WHERE tc.transaction_id = ?
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
    countSql: `${MARK.contactsCount}
    SELECT COUNT(DISTINCT c.id) AS total
    ${from}
    ${where}`,
    countParams: whereParams,
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
      )`;
  const whereParams = [transactionId, pat, pat, pat, pat];

  return {
    sql: `${MARK.emails}
    SELECT e.id AS id, e.subject AS subject, e.sender AS sender, e.sent_at AS sentAt,
           substr(e.body_plain, 1, ${SNIPPET_LEN}) AS snippet
    ${from}
    ${where}
    ORDER BY e.sent_at DESC
    LIMIT ?`,
    params: [...whereParams, limit],
    countSql: `${MARK.emailsCount}
    SELECT COUNT(DISTINCT e.id) AS total
    ${from}
    ${where}`,
    countParams: whereParams,
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
      )`;
  const whereParams = [transactionId, transactionId, pat, pat];

  return {
    sql: `${MARK.texts}
    SELECT m.id AS id, m.body_text AS body_text, m.participants_flat AS participants_flat,
           m.sent_at AS sentAt
    ${from}
    ${where}
    ORDER BY m.sent_at DESC
    LIMIT ?`,
    params: [...whereParams, limit],
    countSql: `${MARK.textsCount}
    SELECT COUNT(*) AS total
    ${from}
    ${where}`,
    countParams: whereParams,
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
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

function runGroup<TRaw, THit>(
  db: SearchableDb,
  built: BuiltQuery,
  shape: (row: TRaw) => THit,
): LinkedGroup<THit> {
  const rows = db.prepare(built.sql).all(...built.params) as TRaw[];
  const countRow = db
    .prepare(built.countSql)
    .get(...built.countParams) as { total?: number } | undefined;
  const total =
    typeof countRow?.total === "number" ? countRow.total : rows.length;
  return { items: rows.map(shape), total };
}

function emptyResults(): LinkedContentSearchResults {
  return {
    contacts: { items: [], total: 0 },
    emails: { items: [], total: 0 },
    texts: { items: [], total: 0 },
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

  const contacts = runGroup<
    { contactId: string; displayName: string; role: string | null },
    LinkedContactHit
  >(db, buildContactQuery(transactionId, query, limit), (row) => ({
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
    },
    LinkedEmailHit
  >(db, buildEmailQuery(transactionId, query, limit), (row) => ({
    id: row.id,
    subject: row.subject ?? null,
    sender: row.sender ?? null,
    sentAt: row.sentAt ?? null,
    snippet: row.snippet ?? null,
  }));

  const texts = runGroup<RawTextRow, LinkedTextHit>(
    db,
    buildTextQuery(transactionId, query, limit),
    shapeText,
  );

  return { contacts, emails, texts };
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
 * Transactions whose property_address OR a linked contact's display_name
 * matches. Single pass; DISTINCT collapses the contact-join fan-out.
 */
export function buildTransactionsQuery(
  userId: string,
  rawQuery: string,
  limit: number,
): BuiltQuery {
  const pat = containsPattern(rawQuery);
  const from = `
    FROM transactions t
    LEFT JOIN transaction_contacts tc ON tc.transaction_id = t.id
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
    countSql: `${MARK.transactionsCount}
    SELECT COUNT(DISTINCT t.id) AS total
    ${from}
    ${where}`,
    countParams: whereParams,
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
      LEFT JOIN transaction_contacts tc ON tc.contact_id = c.id
      LEFT JOIN transactions t ON t.id = tc.transaction_id
      WHERE c.user_id = ?
        AND (${match})
    ) ranked
    WHERE ranked.rn = 1
    ORDER BY ranked.displayName COLLATE NOCASE ASC
    LIMIT ?`;

  const countSql = `${MARK.contactsCount}
    SELECT COUNT(*) AS total FROM (
      SELECT c.id
      FROM contacts c
      WHERE c.user_id = ?
        AND (${match})
      GROUP BY c.id
    ) x`;

  return {
    sql,
    params: [userId, ...matchParams, limit],
    countSql,
    countParams: [userId, ...matchParams],
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
      OR e.recipients LIKE ? ESCAPE '\\'`;
  const matchParams = [pat, pat, pat, pat];

  const sql = `${MARK.emails}
    SELECT e.id AS id, e.subject AS subject, e.sender AS sender, e.sent_at AS sentAt,
           substr(e.body_plain, 1, ${SNIPPET_LEN}) AS snippet,
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

  const countSql = `${MARK.emailsCount}
    SELECT COUNT(DISTINCT e.id) AS total
    FROM emails e
    JOIN communications comm ON comm.email_id = e.id AND comm.transaction_id IS NOT NULL
    WHERE e.user_id = ?
      AND (${match})`;

  return {
    sql,
    params: [userId, ...matchParams, limit],
    countSql,
    countParams: [userId, ...matchParams],
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
      OR m.participants_flat LIKE ? ESCAPE '\\'`;
  const matchParams = [pat, pat];

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
      AND (${match})
    ORDER BY m.sent_at DESC
    LIMIT ?`;

  const countSql = `${MARK.textsCount}
    SELECT COUNT(*) AS total FROM (
      SELECT m.id
      FROM messages m
      WHERE m.user_id = ?
        AND m.channel IN ('sms', 'imessage')
        AND m.id IN (${memberSet})
        AND (${match})
    ) x`;

  return {
    sql,
    params: [userId, ...matchParams, limit],
    countSql,
    countParams: [userId, ...matchParams],
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
      )`;
  const whereParams = [userId, pat, pat, pat, pat];

  return {
    sql: `${MARK.unattachedEmails}
    SELECT e.id AS id, e.subject AS subject, e.sender AS sender, e.sent_at AS sentAt,
           substr(e.body_plain, 1, ${SNIPPET_LEN}) AS snippet
    ${from}
    ${where}
    ORDER BY e.sent_at DESC
    LIMIT ?`,
    params: [...whereParams, limit],
    countSql: `${MARK.unattachedEmailsCount}
    SELECT COUNT(*) AS total
    ${from}
    ${where}`,
    countParams: whereParams,
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
      )`;
  const whereParams = [userId, pat, pat];

  return {
    sql: `${MARK.unattachedTexts}
    SELECT m.id AS id, m.body_text AS body_text, m.participants_flat AS participants_flat,
           m.sent_at AS sentAt
    ${from}
    ${where}
    ORDER BY m.sent_at DESC
    LIMIT ?`,
    params: [...whereParams, limit],
    countSql: `${MARK.unattachedTextsCount}
    SELECT COUNT(*) AS total
    ${from}
    ${where}`,
    countParams: whereParams,
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
}

interface RawGlobalTextRow extends RawAttribution {
  id: string;
  body_text: string | null;
  participants_flat: string | null;
  sentAt: string | null;
}

function shapeGlobalEmail(row: RawGlobalEmailRow): GlobalEmailHit {
  return {
    id: row.id,
    subject: row.subject ?? null,
    sender: row.sender ?? null,
    sentAt: row.sentAt ?? null,
    snippet: row.snippet ?? null,
    attribution: shapeAttribution(row),
  };
}

function shapeGlobalText(row: RawGlobalTextRow): GlobalTextHit {
  return {
    id: row.id,
    sender: textSender(row.participants_flat),
    snippet: row.body_text ? row.body_text.slice(0, SNIPPET_LEN) : null,
    sentAt: row.sentAt,
    attribution: shapeAttribution(row),
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
    transactions: { items: [], total: 0 },
    contacts: { items: [], total: 0 },
    emails: { items: [], total: 0 },
    texts: { items: [], total: 0 },
    unattached: { items: [], total: 0 },
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

  const transactions = runGroup<
    { id: string; propertyAddress: string },
    GlobalTransactionHit
  >(db, buildTransactionsQuery(userId, query, limit), (row) => ({
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
  >(db, buildGlobalContactQuery(userId, query, limit), (row) => ({
    contactId: row.contactId,
    displayName: row.displayName,
    role: row.role ?? null,
    attribution: shapeAttribution(row),
  }));

  const emails = runGroup<RawGlobalEmailRow, GlobalEmailHit>(
    db,
    buildGlobalEmailQuery(userId, query, limit),
    shapeGlobalEmail,
  );

  const texts = runGroup<RawGlobalTextRow, GlobalTextHit>(
    db,
    buildGlobalTextQuery(userId, query, limit),
    shapeGlobalText,
  );

  // Unattached bucket = emails + texts with no communications row. Two queries,
  // merged into one group with the two true totals summed.
  const unattachedEmails = runGroup<
    {
      id: string;
      subject: string | null;
      sender: string | null;
      sentAt: string | null;
      snippet: string | null;
    },
    UnattachedHit
  >(db, buildUnattachedEmailQuery(userId, query, limit), shapeUnattachedEmail);

  const unattachedTexts = runGroup<RawTextRow, UnattachedHit>(
    db,
    buildUnattachedTextQuery(userId, query, limit),
    shapeUnattachedText,
  );

  const unattachedItems = [
    ...unattachedEmails.items,
    ...unattachedTexts.items,
  ]
    .sort((a, b) => (b.sentAt ?? "").localeCompare(a.sentAt ?? ""))
    .slice(0, limit);

  return {
    transactions,
    contacts,
    emails,
    texts,
    unattached: {
      items: unattachedItems,
      total: unattachedEmails.total + unattachedTexts.total,
    },
  };
}
