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
const MARK = {
  contacts: "/* mad:search:contacts */",
  contactsCount: "/* mad:search:contacts:count */",
  emails: "/* mad:search:emails */",
  emailsCount: "/* mad:search:emails:count */",
  texts: "/* mad:search:texts */",
  textsCount: "/* mad:search:texts:count */",
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
