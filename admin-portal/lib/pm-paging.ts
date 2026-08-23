/**
 * Paged fetch-all helper for the PM list RPCs (BACKLOG-2786).
 *
 * `pm_list_items` clamps its page size server-side:
 *
 *     v_effective_page_size := LEAST(COALESCE(p_page_size, 50), 200);
 *
 * A caller asking for `page_size: 500` therefore receives 200 rows and NO
 * error — the remainder is dropped silently. The response does carry enough
 * information to notice (`total_count` is the unpaged total, and `page_size`
 * echoes the size the server actually used), so this helper walks the pages
 * and reports whether it reached the whole set.
 *
 * Why the `complete` flag rather than a bare array: the RPC orders by
 * `sort_order ASC, created_at DESC`, which is NOT a total order — live data
 * has rows sharing both values. LIMIT/OFFSET over a non-total order can, in
 * principle, re-serve one row and drop another across a page boundary. This
 * helper de-duplicates by id and, if the distinct set still falls short of
 * `total_count`, says so, so the UI can state "N of M" instead of quietly
 * showing a short list. Nothing drops silently.
 */

/** One page of a `pm_list_items`-shaped RPC response. */
export interface PagedResponse<T> {
  items: T[];
  /** Total rows matching the filters, ignoring pagination. */
  total_count: number;
  /** The page size the SERVER used — may be clamped below what was requested. */
  page_size: number;
}

export interface FetchAllResult<T> {
  /** Every distinct row the server returned, in page order. */
  items: T[];
  /** The server's unpaged total for the same filters. */
  total_count: number;
  /** True when `items` holds the whole set (`items.length === total_count`). */
  complete: boolean;
}

/** The largest page `pm_list_items` will serve; asking for more is clamped. */
export const SERVER_MAX_PAGE_SIZE = 200;

/** Safety bound so a misbehaving server can never spin this loop forever. */
export const DEFAULT_MAX_PAGES = 50;

/**
 * Fetch every page of a paginated RPC and return the union of the rows.
 *
 * @param fetchPage 1-indexed page fetcher, e.g. `(page, size) => listItems({ ...p, page, page_size: size })`.
 */
export async function fetchAllPages<T extends { id: string }>(
  fetchPage: (page: number, pageSize: number) => Promise<PagedResponse<T>>,
  options?: { pageSize?: number; maxPages?: number }
): Promise<FetchAllResult<T>> {
  const requestedPageSize = options?.pageSize ?? SERVER_MAX_PAGE_SIZE;
  const maxPages = options?.maxPages ?? DEFAULT_MAX_PAGES;

  const items: T[] = [];
  const seen = new Set<string>();
  let totalCount = 0;
  let pageSize = requestedPageSize;

  for (let page = 1; page <= maxPages; page++) {
    const response = await fetchPage(page, pageSize);
    totalCount = response.total_count;

    // Adopt the size the server actually used so the next page's OFFSET
    // lines up with the rows it already served.
    if (typeof response.page_size === 'number' && response.page_size > 0) {
      pageSize = response.page_size;
    }

    if (response.items.length === 0) break;

    for (const item of response.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }

    if (seen.size >= totalCount) break;
    // A short page is the last page.
    if (response.items.length < pageSize) break;
  }

  return { items, total_count: totalCount, complete: seen.size >= totalCount };
}
