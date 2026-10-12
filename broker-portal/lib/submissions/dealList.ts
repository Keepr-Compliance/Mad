/**
 * One row per deal — BACKLOG-3597.
 *
 * Every resubmission is its own transaction_submissions row whose
 * parent_submission_id names the version before it. A list shows one row per
 * deal: the HEAD of the chain, the visible row that no other visible row names
 * as its parent.
 *
 * A version still uploading (the desktop inserts every version as `uploading`
 * and flips it once its data is in) does not count: until it lands, its parent
 * stays the head. A newer version the viewer cannot read (RLS) does not count
 * either, so the viewer's own newest version is their head.
 *
 * Two reads per render, whatever the page size (no per-row reads):
 *   1. the chain links (id, parent, status, created_at) of every visible row,
 *      scoped exactly as the list is, in blocks of READ_BLOCK;
 *   2. the full rows of the one page of heads, by id.
 * The status filter, the count and the pagination all apply to the HEADS, so a
 * deal is counted once and filtered on its latest version's status.
 */

export const LINK_COLUMNS = 'id, parent_submission_id, status, created_at';

/**
 * The broker Submissions list's link read — BACKLOG-3904. Adds what search and
 * the agent filter match on. Broker list only: My Transactions keeps
 * LINK_COLUMNS. Matched on the HEAD (the producer re-reads the address on
 * every version, so an older version's address can differ).
 */
export const BROKER_LINK_COLUMNS = `${LINK_COLUMNS}, submitted_by, property_address, property_city`;

export interface BrokerChainLink extends ChainLink {
  submitted_by: string | null;
  property_address: string | null;
  property_city: string | null;
}

/** Longest search text acted on; the rest is ignored. */
export const MAX_SEARCH_LENGTH = 100;

/** A submitter's name and email, as resolveUserIdentities returns them. */
export interface Identity {
  name: string;
  email: string | null;
}

/**
 * Whether a deal head matches a search: the search is split on whitespace and
 * EVERY word must match the address, the city, or (when identities were looked
 * up) the submitter's name or email, case-insensitively. Any other word is a
 * substring. A word of digits is a house number: in the address it must start
 * the address ("33" finds "33 Oak Lane, ..." and "330 Cedar Ln, ...", not
 * "133 Elm Street" and not a zip code - property_address holds the whole
 * formatted address, "<n> <street>, <city>, <ST> <zip>, USA"); in the city,
 * name and email it matches where a word starts. An empty search matches every
 * deal.
 */
export function headMatchesSearch(
  head: BrokerChainLink,
  search: string,
  identities: ReadonlyMap<string, Identity> | null
): boolean {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const who = head.submitted_by && identities ? identities.get(head.submitted_by) : undefined;
  const address = (head.property_address ?? '').trim().toLowerCase();
  const others = [head.property_city, who?.name, who?.email]
    .filter((f): f is string => typeof f === 'string')
    .map((f) => f.toLowerCase());
  return words.every((w) => {
    if (!/^\d+$/.test(w)) return address.includes(w) || others.some((f) => f.includes(w));
    return address.startsWith(w) || others.some((f) => new RegExp(`(^|[^a-z0-9])${w}`).test(f));
  });
}

/** PostgREST caps an unranged read at max_rows (supabase/config.toml: 1000). */
export const READ_BLOCK = 1000;

/**
 * Guard against a reader that never returns a short block. NOTE: this silently
 * caps the read at MAX_BLOCKS × READ_BLOCK = 100,000 visible rows per list
 * (broker and agent lists alike); rows past that are never seen, with no error.
 */
const MAX_BLOCKS = 100;

/**
 * The "Pending" tab (value `submitted`) means "waiting for the broker", which a
 * resubmitted deal is too. Every other filter value matches its status exactly.
 */
export const PENDING_FILTER = 'submitted';
export const PENDING_STATUSES: readonly string[] = ['submitted', 'resubmitted'];

/**
 * The list's `status=pending` value (BACKLOG-3904): deals whose head is
 * submitted, resubmitted or under_review. No dashboard card links to it now; it
 * stays a working list filter.
 */
export const PENDING_REVIEW_FILTER = 'pending';
export const PENDING_REVIEW_STATUSES: readonly string[] = ['submitted', 'resubmitted', 'under_review'];

/**
 * The dashboard's "New" card (BACKLOG-3904): deals whose head is `submitted`
 * and nothing else. `submitted` on the list keeps its combined meaning
 * (submitted + resubmitted), which the Pending tabs depend on, so this has its
 * own value, `new`.
 */
export const NEW_FILTER = 'new';

/** Whether a head's status matches a list's status filter (null = every deal). */
export function headMatchesFilter(headStatus: string | null, filter: string | null): boolean {
  if (filter === null) return true;
  if (filter === NEW_FILTER) return headStatus === 'submitted';
  if (filter === PENDING_REVIEW_FILTER) return headStatus !== null && PENDING_REVIEW_STATUSES.includes(headStatus);
  if (filter === PENDING_FILTER) return headStatus !== null && PENDING_STATUSES.includes(headStatus);
  return headStatus === filter;
}

export interface ChainLink {
  id: string;
  parent_submission_id: string | null;
  status: string | null;
  created_at: string | null;
}

interface ReadResult {
  data: unknown[] | null;
  error: unknown;
}

/** The head of every chain among the given rows, in the order given. */
export function selectDealHeads<L extends ChainLink>(rows: L[]): L[] {
  const landed = rows.filter((r) => r.status !== 'uploading');
  const superseded = new Set<string>();
  for (const r of landed) {
    if (r.parent_submission_id) superseded.add(r.parent_submission_id);
  }
  return landed.filter((r) => !superseded.has(r.id));
}

/** Newest first; id breaks ties so the order is stable across pages. */
export function compareNewestFirst(a: ChainLink, b: ChainLink): number {
  const ta = a.created_at ?? '';
  const tb = b.created_at ?? '';
  if (ta !== tb) return ta < tb ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export interface DealPage<T> {
  rows: T[];
  /** Deals matching the status filter. */
  total: number;
  /** The page actually shown: a page past the end shows the last page. */
  page: number;
  totalPages: number;
  error: unknown | null;
}

/**
 * Read 1: the head of every deal visible to `readLinks` (unfiltered, unsorted).
 * `error` is set when a block read failed.
 */
export async function readDealHeads<L extends ChainLink = ChainLink>(
  readLinks: (_from: number, _to: number) => PromiseLike<ReadResult>
): Promise<{ heads: L[]; error: unknown | null }> {
  const links: L[] = [];
  for (let block = 0; block < MAX_BLOCKS; block++) {
    const from = block * READ_BLOCK;
    const { data, error } = await readLinks(from, from + READ_BLOCK - 1);
    if (error) return { heads: [], error };
    const got = (data ?? []) as L[];
    links.push(...got);
    if (got.length < READ_BLOCK) break;
  }
  return { heads: selectDealHeads(links), error: null };
}

/**
 * Read 2: filter the heads (status on the head, plus any `match`), sort newest
 * first, count, clamp the page, and read that page's full rows. Every filter
 * applies BEFORE the count and the slice.
 */
export async function pageOfHeads<T extends { id: string }, L extends ChainLink = ChainLink>(args: {
  heads: L[];
  /** Full rows for these ids, scoped as the list is. Never called with []. */
  readRows: (_ids: string[]) => PromiseLike<ReadResult>;
  /** A status filter, matched on the head (see headMatchesFilter); null keeps every deal. */
  status: string | null;
  /** Any further per-head filter (search, agent). */
  match?: (_head: L) => boolean;
  page: number;
  pageSize: number;
}): Promise<DealPage<T>> {
  const match = args.match ?? (() => true);
  const heads = args.heads
    .filter((h) => headMatchesFilter(h.status, args.status) && match(h))
    .sort(compareNewestFirst);

  const total = heads.length;
  const totalPages = Math.max(1, Math.ceil(total / args.pageSize));
  const page = Math.min(Math.max(1, args.page), totalPages);
  const pageIds = heads.slice((page - 1) * args.pageSize, page * args.pageSize).map((h) => h.id);

  if (pageIds.length === 0) return { rows: [], total, page, totalPages, error: null };

  const { data, error } = await args.readRows(pageIds);
  if (error) return { rows: [], total, page, totalPages, error };

  // .in() returns rows in no particular order: put them back in head order.
  const byId = new Map(((data ?? []) as T[]).map((r) => [r.id, r]));
  const rows = pageIds.map((id) => byId.get(id)).filter((r): r is T => r !== undefined);
  return { rows, total, page, totalPages, error: null };
}

export async function loadDealPage<T extends { id: string }>(args: {
  /** Chain links of every visible row, scoped as the list is, WITHOUT the status filter. */
  readLinks: (_from: number, _to: number) => PromiseLike<ReadResult>;
  /** Full rows for these ids, scoped as the list is. Never called with []. */
  readRows: (_ids: string[]) => PromiseLike<ReadResult>;
  /** A status filter, matched on the head (see headMatchesFilter); null keeps every deal. */
  status: string | null;
  page: number;
  pageSize: number;
}): Promise<DealPage<T>> {
  const { heads, error } = await readDealHeads(args.readLinks);
  if (error) return { rows: [], total: 0, page: 1, totalPages: 1, error };
  return pageOfHeads<T>({ ...args, heads });
}
