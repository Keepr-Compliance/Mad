/**
 * BACKLOG-3925: the address-only Needs Review candidate read AND its classification,
 * runnable on any connection — the dedicated contact query worker's read-only one, or
 * the main connection when no worker ran it.
 *
 * The classification runs where the rows are read so that only matched email ids
 * cross back to the main thread: returning every candidate body (60k x ~4 KB on a
 * large mailbox) made the structured-clone copy itself a ~100 ms main-thread block.
 * Worker-safe: imports only SQL text and the pure address matcher.
 */
import { contentContainsAddressAdjacent, type NormalizedAddress } from "../../utils/addressNormalization";
import { readAddressMatchCandidatesOn } from "./reviewStateSql";

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
