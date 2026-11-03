/**
 * Shared paging for report reads (BACKLOG-3720, moved here for BACKLOG-3722)
 *
 * The API returns at most 1000 rows per request (supabase/config.toml
 * max_rows), so a single read silently drops every row past that.
 * `fetchAllPages` reads `.range(from, to)` pages until a short page and drops
 * any id it has already seen. The caller's query MUST order on a total order
 * — a timestamp ASCENDING with `id` as the tiebreak — or pages shift and rows
 * are skipped or repeated. It MUST select `id`, or the dedupe has nothing to
 * key on.
 */

export const PAGE_SIZE = 1000;
/** 20 pages = 20,000 rows. Only reaching it sets `truncated`. */
export const MAX_PAGES = 20;

export interface PagedResult<T> {
  rows: T[];
  /** A page failed — not the same as "no rows". `rows` is empty. */
  failed: boolean;
  /** The page ceiling was reached with a full page, so there may be more. */
  truncated: boolean;
}

export interface PageResponse {
  data: unknown[] | null;
  error: { message: string } | null;
}

/**
 * Read every page `makePage(from, to)` returns. `to` is inclusive, as in
 * PostgREST `.range()`. Rows are deduplicated by `id`. `label` names the read
 * in the error log.
 */
export async function fetchAllPages<T extends { id: string }>(
  makePage: (from: number, to: number) => PromiseLike<PageResponse>,
  label: string,
  pageSize = PAGE_SIZE,
  maxPages = MAX_PAGES
): Promise<PagedResult<T>> {
  const seen = new Set<string>();
  const rows: T[] = [];
  for (let page = 0; page < maxPages; page += 1) {
    const from = page * pageSize;
    const { data, error } = await makePage(from, from + pageSize - 1);
    if (error || !data) {
      console.error(`${label} error:`, error?.message);
      return { rows: [], failed: true, truncated: false };
    }
    for (const row of data as T[]) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
    if (data.length < pageSize) return { rows, failed: false, truncated: false };
  }
  return { rows, failed: false, truncated: true };
}
