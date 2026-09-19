/**
 * People found in the user's email — the read (BACKLOG-1717).
 *
 * ===========================================================================
 * WHAT THIS PRODUCES
 * ===========================================================================
 * One row per email ADDRESS the user has corresponded with, built at read time
 * from `email_participants` joined to `emails`. Nothing is stored: these are
 * unsaved records the user confirms, and confirming one runs `contacts:import`
 * like any other picker row. There is no migration behind this file and no
 * `source='inferred'` row is ever written.
 *
 * ===========================================================================
 * WHY THE SQL LIVES IN A CONSTANT RATHER THAN IN THE SERVICE
 * ===========================================================================
 * Two code paths run it: `contactQueryWorker` on its own read-only connection,
 * and the main thread when the worker pool is not ready. BACKLOG-2514 is the
 * rule — the worker and the main-thread producer run the SAME string, because
 * a hand-kept copy on either side is a copy that drifts.
 *
 * ===========================================================================
 * THE FOUR TERMS, AND WHAT EACH ONE COSTS IF IT IS DROPPED
 * ===========================================================================
 * Each was measured by running the query with the term removed, on the real
 * `schema.sql` with participants written by the real sync writer. The results
 * are in pm_comments `0dadcd2b` §7 and `ad0162a3`.
 *
 * 1. PROVIDER, and it must be applied BEFORE the GROUP BY and BEFORE the LIMIT.
 *    Applied after the GROUP BY, a person who writes from both mailboxes shows
 *    an Outlook-only list a count and a date that came from Gmail. Applied
 *    after the LIMIT, 250 recent Gmail correspondents push all five Outlook
 *    people off the end and the picker shows NOBODY — measured, 0 rows.
 *
 * 2. THE USER'S OWN ADDRESSES. Without it the user is offered as a person:
 *    both mailbox addresses, the login address, and every address they used to
 *    send from. Three terms, and all three earn their place —
 *      · the mailbox addresses from `oauth_tokens`, NULL and blank FILTERED.
 *        One NULL in a `NOT IN` list makes the whole predicate NULL, so a
 *        Google row with no stored address empties BOTH providers' lists, the
 *        Outlook-only one included. Measured: 200 rows -> 0.
 *      · `users_local.email`, which is the login and often differs.
 *      · every `from` address of the user's OUTBOUND mail, which is what
 *        catches a mailbox the user has since disconnected. Without it a
 *        former address is the top row of the list.
 *
 *    **The outbound union is deliberately NOT scoped to the providers being
 *    read, and must not be "optimised" to match them.** A former Gmail address
 *    appears on Outlook mail and the reverse; scoping the union reopens the
 *    hole silently, with every test still green. (SR review pm_comments
 *    `ad0162a3`, required change D2.)
 *
 *    Direction is NOT used to identify the user. `emails.direction` is NULL
 *    whenever the mailbox address was missing at sync time, so a
 *    direction-based rule leaks the owner's own address on exactly the rows
 *    that matter.
 *
 * 3. FAIL CLOSED PER MAILBOX. A provider contributes NOTHING while its stored
 *    mailbox address is empty — the `EXISTS` on `oauth_tokens` below. Without
 *    it the owner's own address is offered as a person, because with no stored
 *    address term 2's first clause cannot know it and the direction rule never
 *    marks their mail outbound.
 *
 *    **PER MAILBOX, not globally.** The rule fires for the affected mailbox
 *    only: an empty Outlook address must not blank a perfectly healthy Gmail
 *    list, and the reverse.
 *
 *    **KNOWN RESIDUAL, recorded rather than closed** (SR `ad0162a3` D2): while
 *    a mailbox has lost its stored address, the user's own address for THAT
 *    mailbox can still appear as a person in the OTHER mailbox's list — it
 *    arrives as a `cc` on the other provider's mail, so no term here can see
 *    it. Excluding the empty provider cannot remove an address sitting on the
 *    other provider's rows. The control asserts this as current behaviour so
 *    that a later fix reddens deliberately instead of passing in silence.
 *
 * 4. SUPPRESSION BY ADDRESS, never by name. A saved contact holding the
 *    address hides it (we already know this person); so does a REMOVED one
 *    (BACKLOG-2365 — the user acted on them, and both delete paths are soft,
 *    so `contact_emails` survives). A person sharing a NAME with a saved
 *    contact but using a different address is still shown: that is the second
 *    Michael Chen, and hiding him is the defect BACKLOG-2618 removed.
 *
 *    This is also what makes a confirmed person never re-offered — no state is
 *    needed, because `contacts:import` writes the address into `contact_emails`
 *    and the very next read suppresses it.
 *
 *    The `NOT IN (SELECT …)` form is load-bearing for COST, not just style.
 *    The correlated `NOT EXISTS` spelling scans `contact_emails` once per
 *    participant row: measured 11.2 s at 20K emails and 58.4 s at 100K,
 *    against 53 ms / 278 ms for this one. A control asserts the query plan
 *    contains no `CORRELATED SCALAR SUBQUERY`.
 *
 * ===========================================================================
 * ROLES, ORDER, LIMIT
 * ===========================================================================
 * Roles `from`, `to`, `cc`. **`bcc` is excluded** (founder, BACKLOG-2924: "we
 * can skip that for now"). It is a real term, not a no-op — the sync writers
 * do store bcc rows.
 *
 * Ordered by `COALESCE(sent_at, received_at)`, matching the recency query in
 * `schema.sql`. Gmail is the likelier of the two to carry one and not the
 * other: `sent_at` is the sender-asserted `Date:` header and `received_at` is
 * server delivery (BACKLOG-2571). Ordering on bare `sent_at` sinks those
 * people to the bottom of the list.
 *
 * LIMIT 200, as the text-derived producer does. Note it is SHARED across
 * providers: turning Gmail on can push Outlook people out of the list.
 */

import { sql, type SafeSql } from "./core/sqlText";
import { placeholderList, joinFragments } from "./core/sqlFragments";

/** The two mailboxes a person can be found in. */
export const EMAIL_DERIVED_PROVIDERS = ["outlook", "gmail"] as const;
export type EmailDerivedProvider = (typeof EMAIL_DERIVED_PROVIDERS)[number];

/**
 * `emails.source` value -> the `oauth_tokens.provider` that owns that mailbox.
 *
 * Transcribed from `emailSyncService.ts`, which resolves the mailbox token as
 * `provider === "outlook" ? "microsoft" : "google"` before deciding direction.
 * The two vocabularies genuinely differ; this is the one place they meet.
 */
export const MAILBOX_TOKEN_PROVIDER: Readonly<Record<EmailDerivedProvider, string>> =
  Object.freeze({
    outlook: "microsoft",
    gmail: "google",
  });

/** How many correspondents a single read offers. Shared across providers. */
export const EMAIL_DERIVED_LIMIT = 200;
/** The same number as SQL text, so the statement can splice it under the brand. */
const EMAIL_DERIVED_LIMIT_SQL = sql`200`;

/**
 * The address stored for one mailbox. Used for the handler's log line only —
 * the rule itself is the `EXISTS` inside the candidate query below.
 */
export const MAILBOX_ADDRESS_SQL = sql`
  SELECT connected_email_address
    FROM oauth_tokens
   WHERE user_id = ? AND provider = ? AND purpose = 'mailbox'
   LIMIT 1`;

export interface EmailDerivedCandidateRow {
  address: string;
  communication_count: number;
  last_communication_at: string | null;
}

export interface EmailDerivedNameRow {
  address: string;
  name: string;
  name_count: number;
  last_at: string | null;
}

/**
 * The synthetic source these records carry. ONE value for both mailboxes: a
 * person who writes from both has no single provider, and the record's
 * identity is the address alone.
 */
export const EMAIL_DERIVED_SOURCE = "email_derived";

/** The picker record shape. Structurally an `AvailableContact`. */
export interface EmailDerivedRecord {
  id: string;
  name: string | null;
  phone: null;
  email: string;
  company: null;
  source: string;
  allPhones: string[];
  allEmails: string[];
  isFromDatabase: false;
  last_communication_at: string | null;
}

export interface BuiltQuery {
  sql: SafeSql;
  params: unknown[];
}

/**
 * The per-provider clause: this provider's rows count only while that
 * mailbox's stored address is present.
 *
 * Emitted as one disjunct per requested provider, so the rule is applied to
 * each mailbox on its own — and so it is applied in the ONE place both the
 * worker and the sync fallback execute, rather than being re-implemented on
 * each side of that fork.
 */
function providerClause(
  userId: string,
  providers: readonly EmailDerivedProvider[],
  params: unknown[],
): SafeSql {
  const disjuncts = providers.map((provider) => {
    params.push(provider, userId, MAILBOX_TOKEN_PROVIDER[provider]);
    return sql`(e.source = ? AND EXISTS (
              SELECT 1 FROM oauth_tokens mb
               WHERE mb.user_id = ?
                 AND mb.provider = ?
                 AND mb.purpose = 'mailbox'
                 AND mb.connected_email_address IS NOT NULL
                 AND TRIM(mb.connected_email_address) <> ''))`;
  });
  return sql`(${joinFragments(disjuncts, sql`
           OR `)})`;
}

/**
 * The user's own addresses. Three terms; see the header for what each costs.
 *
 * `userId` is bound three times here, and the outbound union carries NO
 * provider filter on purpose (D2).
 */
function ownAddressesCte(userId: string, params: unknown[]): SafeSql {
  params.push(userId, userId, userId);
  return sql`own_addresses AS (
      SELECT LOWER(TRIM(t.connected_email_address)) AS address
        FROM oauth_tokens t
       WHERE t.user_id = ?
         AND t.purpose = 'mailbox'
         AND t.connected_email_address IS NOT NULL
         AND TRIM(t.connected_email_address) <> ''
      UNION
      SELECT LOWER(TRIM(ul.email))
        FROM users_local ul
       WHERE ul.id = ?
         AND ul.email IS NOT NULL
         AND TRIM(ul.email) <> ''
      UNION
      -- Every address the user has SENT from, across BOTH providers. Do not
      -- scope this to the providers being read: a former Gmail address turns
      -- up on Outlook mail and the reverse. Measured, SR pm_comments ad0162a3.
      SELECT ep2.email_address
        FROM email_participants ep2
        JOIN emails e2 ON e2.id = ep2.email_id
       WHERE e2.user_id = ?
         AND e2.direction = 'outbound'
         AND ep2.role = 'from'
    )`;
}

/** Addresses already known: a saved contact, or one the user removed. */
function suppressedAddressesSql(userId: string, params: unknown[]): SafeSql {
  params.push(userId);
  return sql`SELECT LOWER(TRIM(ce.email))
            FROM contact_emails ce
            JOIN contacts c ON c.id = ce.contact_id
           WHERE c.user_id = ?
             AND (c.is_imported = 1 OR c.removed_at IS NOT NULL)`;
}

/**
 * The candidate query: one row per address, most recent first.
 *
 * Callers must not invoke this with an empty provider list — an empty `IN`
 * would be a syntax error, and more to the point a read with nothing enabled
 * should never reach the database at all.
 */
export function buildEmailDerivedCandidateQuery(
  userId: string,
  providers: readonly EmailDerivedProvider[],
): BuiltQuery {
  if (providers.length === 0) {
    throw new Error(
      "buildEmailDerivedCandidateQuery: no providers enabled — the caller must not read at all",
    );
  }
  const params: unknown[] = [];
  const own = ownAddressesCte(userId, params);
  params.push(userId);

  const statement = sql`
    WITH ${own}
    SELECT ep.email_address                                AS address,
           COUNT(DISTINCT e.id)                            AS communication_count,
           MAX(COALESCE(e.sent_at, e.received_at))         AS last_communication_at
      FROM emails e
      JOIN email_participants ep ON ep.email_id = e.id
     WHERE e.user_id = ?
       AND ${providerClause(userId, providers, params)}
       AND ep.role IN ('from', 'to', 'cc')
       AND ep.email_address NOT IN (SELECT address FROM own_addresses)
       AND ep.email_address NOT IN (${suppressedAddressesSql(userId, params)})
     GROUP BY ep.email_address
     ORDER BY last_communication_at DESC, address ASC
     LIMIT ${EMAIL_DERIVED_LIMIT_SQL}`;

  return { sql: statement, params };
}

/**
 * The names carried for a set of addresses, bounded to the addresses the
 * candidate query already returned.
 *
 * Rows whose `display_name` is empty, or is just the address again, are
 * dropped: Graph and Gmail both hand back the address as the "name" when the
 * sender set no display name, and labelling a row with its own address twice
 * tells the user nothing.
 *
 * Ordered so the caller can take the FIRST row per address: most frequent
 * name, then the most recent, then lexical. The recency tie-break uses the
 * same `COALESCE(sent_at, received_at)` as the list order (SR required change
 * D5) — on bare `sent_at`, a newer name arriving on a Gmail row with no
 * `Date:` header would lose every tie while sorting correctly in the list.
 */
export function buildEmailDerivedNameQuery(
  userId: string,
  providers: readonly EmailDerivedProvider[],
  addresses: readonly string[],
): BuiltQuery {
  if (providers.length === 0 || addresses.length === 0) {
    throw new Error("buildEmailDerivedNameQuery: nothing to name");
  }
  const params: unknown[] = [];
  params.push(userId);
  const providerSql = providerClause(userId, providers, params);
  const placeholders = placeholderList(addresses.length);
  addresses.forEach((a) => params.push(a));

  const statement = sql`
    SELECT ep.email_address                        AS address,
           TRIM(ep.display_name)                   AS name,
           COUNT(*)                                AS name_count,
           MAX(COALESCE(e.sent_at, e.received_at)) AS last_at
      FROM emails e
      JOIN email_participants ep ON ep.email_id = e.id
     WHERE e.user_id = ?
       AND ${providerSql}
       AND ep.role IN ('from', 'to', 'cc')
       AND ep.email_address IN (${placeholders})
       AND ep.display_name IS NOT NULL
       AND TRIM(ep.display_name) <> ''
       AND LOWER(TRIM(ep.display_name)) <> ep.email_address
     GROUP BY ep.email_address, TRIM(ep.display_name)
     ORDER BY address ASC, name_count DESC, last_at DESC, name ASC`;

  return { sql: statement, params };
}

/**
 * Pick one display name per address from the ordered name rows.
 *
 * Pure, so both the worker and the main thread fold the same rows the same
 * way, and so the choice can be controlled without a database.
 */
export function chooseDisplayNames(
  rows: readonly EmailDerivedNameRow[],
): Map<string, string> {
  const chosen = new Map<string, string>();
  for (const row of rows) {
    if (!chosen.has(row.address)) chosen.set(row.address, row.name);
  }
  return chosen;
}

/**
 * Fold the two reads into picker records. PURE.
 *
 * Both the worker and the main-thread fallback call this, so the record a user
 * sees cannot depend on which of the two ran — the defect class BACKLOG-2457
 * records, where one of two paths got a fix and the other read as fixed.
 *
 * `source` is the synthetic `email_derived`, set DIRECTLY. It is never routed
 * through `toPersistedContactSource`, whose default is `contacts_app`: that
 * would file these people under the macOS address book, where Clients &
 * Contacts shows them by default, and stamp their addresses as imported.
 *
 * `externalRecordId` / `externalSourceType` are deliberately absent. There is
 * no address-book record behind an email person, so a confirm writes an origin
 * row and no source identity — the honest answer, and what keeps this item out
 * of `contact_link_proposals` entirely.
 *
 * `phone` is null, and NOT the text-derived producer's `phone = from`. That
 * projection puts a DISPLAY NAME in the phone column, which is how importing a
 * text person writes a junk "+" phone row. An email person has an address.
 */
export function foldEmailDerivedRecords(
  rows: readonly EmailDerivedCandidateRow[],
  nameRows: readonly EmailDerivedNameRow[],
): EmailDerivedRecord[] {
  const names = chooseDisplayNames(nameRows);
  return rows.map((row) => ({
    id: emailDerivedRecordId(row.address),
    name: names.get(row.address) ?? null,
    phone: null,
    email: row.address,
    company: null,
    source: EMAIL_DERIVED_SOURCE,
    allPhones: [],
    allEmails: [row.address],
    isFromDatabase: false,
    last_communication_at: row.last_communication_at ?? null,
  }));
}

/**
 * The minimum a caller must provide to run these statements.
 *
 * Structural rather than a driver type, so the worker's own connection and the
 * main thread's both satisfy it without this module importing a database.
 */
export interface StatementRunner {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

/**
 * Run both statements on a caller-supplied connection and fold the result.
 *
 * WHY THIS EXISTS RATHER THAN THE WORKER PREPARING THE TEXT ITSELF: the SQL
 * boundary gate requires statement text to live under `electron/services/db/`,
 * and it is right to. These statements are BUILT rather than constant — the
 * provider placeholders vary with how many mailboxes are enabled — so a worker
 * calling `prepare()` on a returned object is text the gate cannot trace to its
 * definition, which is exactly the shape the rule exists to prevent. Handing
 * the connection in keeps every `prepare` of this text inside the db layer, and
 * gives the worker and the main thread ONE implementation instead of two.
 */
export function runEmailDerivedQueryOn(
  db: StatementRunner,
  userId: string,
  providers: readonly EmailDerivedProvider[],
): EmailDerivedRecord[] {
  if (providers.length === 0) return [];

  const candidate = buildEmailDerivedCandidateQuery(userId, providers);
  const rows = db.prepare(candidate.sql).all(...candidate.params) as EmailDerivedCandidateRow[];
  if (rows.length === 0) return [];

  const nameQuery = buildEmailDerivedNameQuery(
    userId,
    providers,
    rows.map((r) => r.address),
  );
  const nameRows = db.prepare(nameQuery.sql).all(...nameQuery.params) as EmailDerivedNameRow[];

  return foldEmailDerivedRecords(rows, nameRows);
}

/**
 * The picker id for an email person.
 *
 * Derived from the address alone, so it is stable across syncs and identical
 * for a person seen in both mailboxes — which is what makes them ONE row. It
 * cannot collide with the text-derived `msg_` ids, whose values never contain
 * an `@`.
 */
export function emailDerivedRecordId(address: string): string {
  return `email_${address}`;
}
