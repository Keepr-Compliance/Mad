/**
 * The bounded, oldest-first read loop shared by every Android content-provider
 * reader (BACKLOG-3046 follow-up).
 *
 * ## Why this module exists
 *
 * `smsReader.ts` (`content://sms`) and `mmsReader.ts` (`content://mms`) read
 * different URIs with different row schemas, and MMS carries part/address
 * indirection SMS does not — so they are correctly two readers. But the
 * *mechanism* around those differences was written twice: the same paging loop,
 * the same four-reason failure union, the same budget handling, the same
 * exhaustion rule. Two copies of a loop drift, and this repo has already paid
 * for that shape once — a parity test justifying a duplicated module stayed
 * green because its hand-picked corpus had no input at the boundary (CLAUDE.md,
 * 2026-08-04).
 *
 * The duplication is removed by extracting the ALGORITHM, not by merging the
 * readers. A single reader branching on message type would be the same
 * duplication wearing a costume.
 *
 * ## The two invariants this loop exists to hold
 *
 * **1. A bounded read is a contiguous PREFIX of the backlog** (BACKLOG-2199).
 * Both providers default to `date DESC`. Each caller forces `date ASC` in its
 * own native query; this loop then pages forward by OFFSET over that sorted,
 * filtered set. Offset paging is gap-free here precisely because the set is
 * oldest-first: rows already passed keep their position when newer messages
 * arrive at the tail mid-loop, and it sidesteps the same-millisecond boundary
 * skip a timestamp-advance pager would risk.
 *
 * Beyond `budget` the remainder is RETAINED — left in the provider with the
 * cursor held upstream — never dropped. `budget` is a per-cycle ceiling derived
 * from remaining queue capacity (back-pressure), not a cap on what exists.
 *
 * **2. A failed read is never an empty read** (BACKLOG-1448 / 2206). Any page
 * that fails, fails the WHOLE read. A partial set would look like a complete one
 * and let the caller advance its cursor over history it never saw. Collapsing
 * failures to `[]` once hid a zero-message release for weeks.
 */

/**
 * Categorized reason a provider read FAILED.
 *
 * A read failure is fundamentally different from a genuine empty result: it
 * means the read could not be trusted at all (native module gone, permission
 * revoked mid-run, content-resolver / query error, unparseable native payload).
 * Historically every one of these collapsed to `[]`, so a failed read looked
 * identical to "0 new messages" — and a wrong native-module name once returned
 * zero for an entire release invisibly (BACKLOG-1448). Surfacing the reason lets
 * the sync cycle count the cycle as a FAILED reach rather than a healthy idle
 * one, and lets the UI show an actionable state.
 *
 * Adding a member here is deliberately breaking: each reader maps its copy with
 * an exhaustive `Record` (`SMS_READ_ERROR_COPY` / `MMS_READ_ERROR_COPY`), so a
 * new reason will not compile until every surface has decided what to say about
 * it.
 *
 * That is a claim with a control, not an aspiration: adding a fifth member here
 * fails `npx tsc --noEmit` with TS2741 in BOTH readers. It was false when first
 * written — the readers used a `switch` with a `default:`, which would have let
 * a new reason compile clean and silently inherit the generic copy. If either
 * `Record` is ever turned back into a defaulted `switch`, this paragraph becomes
 * a lie again and nothing will say so.
 */
export type ProviderReadErrorReason =
  | "module_unavailable"
  | "permission_denied"
  | "query_failed"
  | "parse_failed";

export interface ProviderReadError {
  reason: ProviderReadErrorReason;
  /** Diagnostic detail (native failure string / exception message). */
  message: string;
}

/**
 * Outcome of a provider read. A discriminated union so callers MUST distinguish
 * an explicit empty-but-successful read (`{ ok: true, messages: [] }`) from a
 * read FAILURE (`{ ok: false, error }`).
 */
export type ProviderReadResult<T> =
  | { ok: true; messages: T[] }
  | { ok: false; error: ProviderReadError };

/**
 * Outcome of reading ONE page.
 *
 * `rawCount` is the number of RAW provider rows returned, BEFORE any validity
 * filter the caller applies. The loop uses it to (a) detect exhaustion — a page
 * shorter than requested means no more rows match — and (b) advance the offset.
 * It is deliberately distinct from `messages.length`, which may be smaller when
 * a page contains rows the caller drops (address/body-less carrier alerts).
 * Conflating the two makes the walk skip rows.
 */
export type ProviderPageResult<T> =
  | { ok: true; messages: T[]; rawCount: number }
  | { ok: false; error: ProviderReadError };

/**
 * Rows to request from the provider in a SINGLE native call.
 *
 * BACKLOG-2207: the read PAGES instead of issuing one query capped at the whole
 * budget. This bounds the size of any single JSON payload materialized across
 * the bridge, while the loop keeps pulling until the backlog is exhausted or the
 * budget is reached.
 */
export const PROVIDER_READ_PAGE_SIZE = 200;

/**
 * Absolute safety cap on page reads per loop (anti-loop).
 *
 * The loop normally terminates by exhausting the backlog (a short page) or by
 * reaching the budget. This guard only matters in the pathological case where a
 * long run of rows is filtered out before any valid message — it guarantees the
 * loop is always bounded. Sized far above any realistic device backlog.
 */
export const MAX_PROVIDER_READ_PAGES = 500;

/** Default per-read budget when a caller does not supply one. */
export const DEFAULT_PROVIDER_READ_BUDGET = 100;

export interface PagedReadOptions<T> {
  /**
   * Per-cycle CEILING on valid rows collected. The un-read remainder stays in
   * the provider and the caller holds its cursor.
   */
  budget: number;
  /**
   * Read one page: `[indexFrom, indexFrom + pageSize)` of the caller's own
   * oldest-first, filtered set. MUST resolve to `{ ok: false, error }` on any
   * failure — never to an empty page.
   */
  readPage: (indexFrom: number, pageSize: number) => Promise<ProviderPageResult<T>>;
  /** Log prefix, e.g. `SmsReader inbox` / `MmsReader`. */
  label: string;
  pageSize?: number;
  maxPages?: number;
}

/**
 * Page forward through a provider until the backlog since the cursor is
 * exhausted or the budget is reached.
 *
 * Terminates on exactly one of: budget reached, a page shorter than requested
 * (exhaustion), a page failure (the whole read fails), or the anti-loop page cap.
 */
export async function readPaged<T>(
  options: PagedReadOptions<T>
): Promise<ProviderReadResult<T>> {
  const {
    budget,
    readPage,
    label,
    pageSize: maxPageSize = PROVIDER_READ_PAGE_SIZE,
    maxPages = MAX_PROVIDER_READ_PAGES,
  } = options;

  const collected: T[] = [];
  let indexFrom = 0;
  let page = 0;

  for (; page < maxPages; page++) {
    const remaining = budget - collected.length;
    // Reached the per-cycle back-pressure ceiling — stop; the remainder stays in
    // the provider and the caller holds the cursor for next cycle.
    if (remaining <= 0) break;

    const pageSize = Math.min(maxPageSize, remaining);
    const pageResult = await readPage(indexFrom, pageSize);

    // BACKLOG-2206: a failed page fails the whole read (cursor held upstream).
    if (!pageResult.ok) return pageResult;

    for (const item of pageResult.messages) {
      if (collected.length >= budget) break; // never exceed the budget
      collected.push(item);
    }

    // A page shorter than we asked for means the since-cursor backlog is
    // exhausted — stop (the caller can safely advance the cursor past it).
    if (pageResult.rawCount < pageSize) break;

    // Advance the offset over the RAW rows just consumed and page again.
    indexFrom += pageResult.rawCount;
  }

  if (page >= maxPages) {
    // Pathological safety-valve hit. Return what we have; the caller's
    // truncation logic re-reads the remainder next cycle.
    console.warn(
      `[${label}] reached MAX_PROVIDER_READ_PAGES (${maxPages}); ` +
        "remainder deferred to next cycle."
    );
  }

  return { ok: true, messages: collected };
}
