/**
 * QA Harness — SEARCH + ATTACH driver contract + gated cells (BACKLOG-1853 / QA-H6, Tier 3).
 *
 * The UI-level search→attach determinism cells require driving the packaged app:
 * type a query into the search box, attach the found email / whole thread, and
 * read back the transaction's linked-email count to assert the delta is EXACT.
 *
 * These steps EXTEND the H2 driver contract (e2e/driver — AppDriver, BACKLOG-1849),
 * which today exposes boot / onboarding / navigate / filter-toggle / export but
 * NOT search or attach. Until the H2 driver implements `SearchAttachDriver` AND
 * the harness registry unwires the driver stub (a parallel wave-2 task), these
 * cells are reported as `driver-gated` (skipped) — never `fail`. Wiring is a
 * one-line swap once KeeprAppDriver implements the interface below.
 */

/**
 * The search→attach steps the H2 KeeprAppDriver must implement for the Tier-3
 * cells to activate. Selectors live in e2e/driver/selectors.ts (`SearchAttach`).
 */
export interface SearchAttachDriver {
  /** Type a query into the global search box and return the visible result subjects. */
  search(query: string): Promise<string[]>;
  /** Attach a single found email (by subject) to the current transaction. */
  attachEmail(subject: string): Promise<void>;
  /** Attach a whole thread (by any member subject) to the current transaction. */
  attachThread(subject: string): Promise<void>;
  /** The current transaction's linked-email count (post-expansion). */
  getLinkedEmailCount(): Promise<number>;
}

/**
 * Best-effort renderer selectors for the search→attach flow. No data-testid
 * exists today; the H2 driver impl should prefer role/text and add data-testids
 * in the renderer when wiring (tracked with H9's UI-regression testid sweep).
 * Kept here (not in e2e/driver/selectors.ts) so this Tier-3 scaffolding does not
 * touch H2-owned files ahead of the driver-wiring wave-2 task.
 */
export const SearchAttachSelectors = {
  searchInput: { role: 'searchbox', name: /search/i },
  searchInputFallback: 'input[type="search"], input[placeholder*="Search" i]',
  attachEmailButton: { role: 'button', name: /Attach|Link to transaction/i },
  attachThreadButton: { role: 'button', name: /Attach thread|Link thread|Whole thread/i },
  linkedCountTestId: 'linked-email-count',
} as const;

export interface DriverGatedCell {
  id: string;
  detail: string;
}

/**
 * The Tier-3 cells that will run once `SearchAttachDriver` is wired. Each maps to
 * an acceptance-criterion of BACKLOG-1853 that requires the live UI flow.
 */
export function driverGatedCells(): DriverGatedCell[] {
  return [
    {
      id: 'ui-search-determinism',
      detail: 'type each fixed query in the app search box; assert the visible result set matches the exact corpus-derived expectation (incl. whitespace-prefixed variant).',
    },
    {
      id: 'ui-single-attach-delta',
      detail: 'attach one searched email; assert the transaction linked-count delta is EXACTLY +1.',
    },
    {
      id: 'ui-whole-thread-attach-delta',
      detail: 'attach a multi-email thread; assert the linked-count delta equals EXACTLY the thread member count (no more, no fewer).',
    },
    {
      id: 'ui-stale-search-no-ghost',
      detail: 'after a server-side delete + re-search, assert the tombstoned message is NOT resurrected in results (BACKLOG-1764).',
    },
  ];
}

/**
 * Whether a real search/attach driver is available. Always false today (the H2
 * driver does not yet implement SearchAttachDriver and the registry stubs the
 * driver). Flip the wiring here when KeeprAppDriver implements the interface.
 */
export function isSearchAttachDriverWired(): boolean {
  return false;
}
