/**
 * Read every row of a query, one range at a time (BACKLOG-3607 N-3).
 *
 * PostgREST caps a single response at the project's max-rows setting (Supabase
 * default 1000). A plain `select` over more rows than that returns the first
 * block and no error, so anything counted from it is silently short.
 *
 * `readRange(from, to)` must issue the SAME query each call, with a stable
 * order and `{ count: 'exact' }`, ending in `.range(from, to)`. The loop stops
 * when the rows read reach the exact count; without a count it stops on a
 * short block. It advances by the rows actually returned, so a server cap
 * smaller than BLOCK still reads everything.
 */

export const READ_ALL_BLOCK = 1000;
/** Upper bound on round trips: 200 blocks = 200,000 rows. */
export const READ_ALL_MAX_BLOCKS = 200;

interface RangeResult {
  data: unknown;
  error: unknown;
  count?: number | null;
}

export async function readAllRows<T>(
  readRange: (_from: number, _to: number) => PromiseLike<RangeResult>
): Promise<{ data: T[]; error: unknown | null }> {
  const rows: T[] = [];
  let total: number | null = null;
  for (let block = 0; block < READ_ALL_MAX_BLOCKS; block++) {
    const from = rows.length;
    const { data, error, count } = await readRange(from, from + READ_ALL_BLOCK - 1);
    if (error) return { data: [], error };
    const got = Array.isArray(data) ? (data as T[]) : [];
    if (typeof count === 'number') total = count;
    rows.push(...got);
    if (got.length === 0) break;
    if (total !== null ? rows.length >= total : got.length < READ_ALL_BLOCK) break;
  }
  return { data: rows, error: null };
}
