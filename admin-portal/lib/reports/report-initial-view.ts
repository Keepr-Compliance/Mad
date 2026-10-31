/**
 * What a report's server page opens with (BACKLOG-4084)
 *
 * PURE. The shared half of each report's `resolve<Report>Initial`: the default
 * view (bare URL only) and the period input the page resolves from.
 *
 * `listViews` is the raw RPC read. It is NOT called when the URL names any key
 * the page reads, and a failure (throw or rejection) means "no default": the
 * page renders with its built-in period.
 */

import { hasExplicitState, resolveInitialView, type SearchParamsLike } from './default-view';
import { viewPeriodParams, type StoredViewPeriod } from './view-period';

/** The period params the page resolves from. */
export interface PeriodInput {
  period?: string;
  from?: string;
  to?: string;
}

export interface InitialViewLike {
  id: string;
  isDefault: boolean;
  period: StoredViewPeriod | null;
}

function paramString(params: SearchParamsLike, key: string): string | undefined {
  const value = params[key];
  return typeof value === 'string' ? value : undefined;
}

export async function resolveReportInitial<V extends InitialViewLike>(
  params: SearchParamsLike,
  listViews: () => Promise<unknown>,
  parse: (raw: unknown) => V[]
): Promise<{ initialView: V | null; periodInput: PeriodInput }> {
  const fromUrl: PeriodInput = {
    period: paramString(params, 'period'),
    from: paramString(params, 'from'),
    to: paramString(params, 'to'),
  };
  if (hasExplicitState(params)) return { initialView: null, periodInput: fromUrl };

  let views: V[] | null;
  try {
    views = parse(await listViews());
  } catch {
    views = null;
  }
  const initialView = resolveInitialView({ params, views });
  if (!initialView) return { initialView: null, periodInput: fromUrl };
  return {
    initialView,
    periodInput: initialView.period ? viewPeriodParams(initialView.period) : fromUrl,
  };
}
