/**
 * BACKLOG-3925: the address-only Needs Review candidate read AND its classification,
 * runnable on any connection — the dedicated contact query worker's read-only one, or
 * the main connection when no worker ran it.
 *
 * The classification runs where the rows are read so that only matched email ids
 * cross back to the main thread: returning every candidate body (60k x ~4 KB on a
 * large mailbox) made the structured-clone copy itself a ~100 ms main-thread block.
 * Worker-safe: imports only SQL text and the pure address matcher.
 *
 * The statement names the review store (it excludes emails already waiting in Needs
 * Review), so this module is one of the review-store OWNERS in
 * reviewStateService.singleReadPath-2791.test.ts, and that test pins its importers to
 * reviewStateService and the query worker.
 */
import { contentContainsAddressAdjacent, type NormalizedAddress } from "../../utils/addressNormalization";
import { sql } from "./core/sqlText";

/**
 * Address-only discovery candidates: the user's cached emails inside the deal's
 * window whose subject or plain body contains the street NUMBER, and whose subject or
 * plain body contains the FIRST street-name word of the address route
 * (`addressRoutePrefilterWord`; an empty string turns that check off, since
 * instr(x, '') is 1). A superset — the decision is `contentContainsAddressAdjacent`
 * in JS (street number and street name adjacent, either order, Ave/Avenue variants).
 * Neither instr can use an index, which is why the read runs on a dedicated query
 * worker (`readAddressMatchCandidatesOn`, BACKLOG-3868 pattern).
 *
 * Excluded here, all for THIS transaction:
 *   - already linked (`communications`)
 *   - already rejected (`ignored_communications`)
 *   - already waiting in Needs Review (`pending_review_communications`)
 *   - any participant is an email address of a contact on the deal. Those belong to
 *     the contact route, which links the ones naming the address and queues the rest.
 *
 * Newest first. Bound, in order (ADDRESS_MATCH_CANDIDATE_PARAM_COUNT): user id,
 * window start, window end, first street number (subject), first street number (body),
 * last street number (subject), last street number (body), name word (subject), name
 * word (body), then the transaction id four times. A street number is its DIGIT run
 * only ("12A" -> "12": digits have no case, the columns are raw, and the matcher
 * decides the suffix); a ranged deal ("12-14") binds both ends, so "14 Elm St" is found.
 */
export const ADDRESS_MATCH_CANDIDATE_EMAILS_SQL = sql`SELECT e.id, e.subject, e.body_plain
       FROM emails e
      WHERE e.user_id = ?
        AND e.sent_at >= ?
        AND e.sent_at <= ?
        AND (instr(e.subject, ?) > 0 OR instr(e.body_plain, ?) > 0
             OR instr(e.subject, ?) > 0 OR instr(e.body_plain, ?) > 0)
        AND (instr(lower(e.subject), ?) > 0 OR instr(lower(e.body_plain), ?) > 0)
        AND NOT EXISTS (
          SELECT 1 FROM communications c
           WHERE c.transaction_id = ? AND c.email_id = e.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM ignored_communications ic
           WHERE ic.transaction_id = ? AND ic.email_id = e.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM pending_review_communications p
           WHERE p.transaction_id = ? AND p.email_id = e.id
        )
        AND NOT EXISTS (
          SELECT 1
            FROM email_participants ep
            JOIN contact_emails ce ON lower(trim(ce.email)) = ep.email_address
            JOIN transaction_contacts tc
              ON tc.contact_id = ce.contact_id
             AND tc.transaction_id = ?
             AND tc.removed_at IS NULL
           WHERE ep.email_id = e.id
        )
      ORDER BY e.sent_at DESC`;

/** Bound values of ADDRESS_MATCH_CANDIDATE_EMAILS_SQL. */
export const ADDRESS_MATCH_CANDIDATE_PARAM_COUNT = 13;

/**
 * Run the address-match candidate read on a given connection — the dedicated query
 * worker's read-only one, or the main connection when no worker ran it. Same
 * statement, same parameters, same rows.
 */
export function readAddressMatchCandidatesOn(
  db: { prepare(sql: string): { all(...params: unknown[]): unknown[] } },
  params: unknown[],
): unknown[] {
  return db.prepare(ADDRESS_MATCH_CANDIDATE_EMAILS_SQL).all(...params);
}

export type AddressCandidateRow = { id: string; subject: string | null; body_plain: string | null };

export interface AddressMatchClassification {
  /** Rows the SQL prefilter returned. */
  candidates: number;
  /** Ids of the candidates the matcher accepted, in the statement's order (newest first). */
  matchedIds: string[];
}

/**
 * Subject and body are judged separately, so a number ending one cannot join a name
 * starting the other.
 */
export function isAddressMatchRow(row: AddressCandidateRow, address: NormalizedAddress): boolean {
  return contentContainsAddressAdjacent(row.subject, address) || contentContainsAddressAdjacent(row.body_plain, address);
}

/** Read the candidates on `db` and classify them there. */
export function classifyAddressMatchCandidatesOn(
  db: { prepare(sql: string): { all(...params: unknown[]): unknown[] } },
  params: unknown[],
  address: NormalizedAddress,
): AddressMatchClassification {
  const rows = readAddressMatchCandidatesOn(db, params) as AddressCandidateRow[];
  const matchedIds: string[] = [];
  for (const row of rows) if (isAddressMatchRow(row, address)) matchedIds.push(row.id);
  return { candidates: rows.length, matchedIds };
}
