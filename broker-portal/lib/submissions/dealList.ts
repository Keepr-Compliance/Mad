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

/** PostgREST caps an unranged read at max_rows (supabase/config.toml: 1000). */
export const READ_BLOCK = 1000;

/** Guard against a reader that never returns a short block. */
const MAX_BLOCKS = 100;

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
export function selectDealHeads(rows: ChainLink[]): ChainLink[] {
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

export async function loadDealPage<T extends { id: string }>(args: {
  /** Chain links of every visible row, scoped as the list is, WITHOUT the status filter. */
  readLinks: (from: number, to: number) => PromiseLike<ReadResult>;
  /** Full rows for these ids, scoped as the list is. Never called with []. */
  readRows: (ids: string[]) => PromiseLike<ReadResult>;
  /** A status to keep, matched on the head; null keeps every deal. */
  status: string | null;
  page: number;
  pageSize: number;
}): Promise<DealPage<T>> {
  const links: ChainLink[] = [];
  for (let block = 0; block < MAX_BLOCKS; block++) {
    const from = block * READ_BLOCK;
    const { data, error } = await args.readLinks(from, from + READ_BLOCK - 1);
    if (error) return { rows: [], total: 0, page: 1, totalPages: 1, error };
    const got = (data ?? []) as ChainLink[];
    links.push(...got);
    if (got.length < READ_BLOCK) break;
  }

  const heads = selectDealHeads(links)
    .filter((h) => args.status === null || h.status === args.status)
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
