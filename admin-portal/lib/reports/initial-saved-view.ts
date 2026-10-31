/**
 * The saved view a report's server page opens with (BACKLOG-4084)
 *
 * PURE apart from the injected read. Used by the iPhone sync and Exports
 * `page.tsx` before the period is resolved, so the default view's time range
 * drives the first render. Never called from a client effect.
 *
 * - Explicit URL (any period key, or one of the report's own URL keys, even
 *   empty): the views are NOT read, and the URL's period is used.
 * - Bare URL: the views are read once; a failed read means "no default" and
 *   the page opens with its built-in period.
 * - A default view with no stored period keeps the built-in period.
 */

import { hasExplicitState, resolveInitialView, type SearchParamsLike } from './default-view';
import { viewPeriodParams, type StoredViewPeriod } from './view-period';

/** The period params a report's `resolvePeriod` reads. */
export interface PeriodInput {
  period?: string;
  from?: string;
  to?: string;
}

export interface InitialViewCandidate {
  id: string;
  isDefault: boolean;
  period: StoredViewPeriod | null;
}

function paramString(params: SearchParamsLike, key: string): string | undefined {
  const value = params[key];
  return typeof value === 'string' ? value : undefined;
}

export async function resolveInitialSavedView<V extends InitialViewCandidate>({
  params,
  reportKeys = [],
  listViews,
  parse,
}: {
  params: SearchParamsLike;
  /** The report's own URL keys (iPhone: type, outcome, …). Exports has none. */
  reportKeys?: readonly string[];
  /** The raw `report_list_saved_views` read. Throws on failure. */
  listViews: () => Promise<unknown>;
  parse: (raw: unknown) => V[];
}): Promise<{ initialView: V | null; periodInput: PeriodInput }> {
  const fromUrl: PeriodInput = {
    period: paramString(params, 'period'),
    from: paramString(params, 'from'),
    to: paramString(params, 'to'),
  };
  if (hasExplicitState(params, reportKeys)) return { initialView: null, periodInput: fromUrl };

  let views: V[] | null;
  try {
    views = parse(await listViews());
  } catch {
    views = null;
  }
  const initialView = resolveInitialView({ params, reportKeys, views });
  if (!initialView) return { initialView: null, periodInput: fromUrl };
  return {
    initialView,
    periodInput: initialView.period ? viewPeriodParams(initialView.period) : fromUrl,
  };
}
