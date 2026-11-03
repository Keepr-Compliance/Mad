/**
 * Which saved view a report opens with (BACKLOG-4084)
 *
 * PURE. Called by a report's server `page.tsx` with its search params and the
 * caller's saved views, BEFORE the period is resolved, so the default view's
 * period drives the first render. Never in a client effect: a client effect
 * re-applies the default on every navigation.
 *
 * The default applies only to a URL that names nothing the page reads. Any
 * explicit key wins (a shared link, a back button, a period the user just
 * picked), so the default can never override what a URL says. Unrelated params
 * (`error=`, tracking) do not count.
 *
 * The period builders always write `period` (report-url.ts, funnel-period.ts),
 * so once the user changes anything on a page the URL is explicit and the
 * default stops applying.
 */

/** Every report reads these three. */
export const PERIOD_URL_KEYS: readonly string[] = ['period', 'from', 'to'];

/** The client-state keys the iPhone sync report mirrors into its URL (report-url.ts applyClientState). */
export const IPHONE_SYNC_URL_KEYS: readonly string[] = ['type', 'outcome', 'platform', 'q', 'sort', 'dir', 'stalled'];

export type SearchParamsLike = Record<string, string | string[] | undefined>;

/** True when the URL names any key the page reads. Present counts, even when empty. */
export function hasExplicitState(params: SearchParamsLike, reportKeys: readonly string[] = []): boolean {
  return [...PERIOD_URL_KEYS, ...reportKeys].some((key) => params[key] !== undefined);
}

export interface DefaultableView {
  id: string;
  isDefault: boolean;
}

/**
 * The view to open with, or null.
 *
 * Null when the URL is explicit, when the views could not be read (pass null;
 * the page renders with its built-in period), or when no view is the default.
 * More than one flagged row cannot happen (a unique index), but if it ever
 * did, the first in list order wins rather than throwing.
 */
export function resolveInitialView<V extends DefaultableView>({
  params,
  reportKeys = [],
  views,
}: {
  params: SearchParamsLike;
  reportKeys?: readonly string[];
  views: V[] | null;
}): V | null {
  if (views === null) return null;
  if (hasExplicitState(params, reportKeys)) return null;
  return views.find((v) => v.isDefault) ?? null;
}
