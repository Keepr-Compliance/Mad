'use client';

/**
 * Saved views for one report: load, write, default (BACKLOG-3514).
 *
 * COPIED from admin-portal/lib/reports/use-report-saved-views.ts (BACKLOG-4084)
 * with no behaviour change; the only edit is the import paths. Extract both
 * into packages/ui saved-views later, as its own pure-move PR (SR review on
 * BACKLOG-3514: not in this PR).
 *
 * The kit `SavedViews` component takes what this returns: `views`, `loading`,
 * `writeError`, `defaultViewId`, and the handlers.
 *
 * FAILS CLOSED. No api, a migration not yet applied, a network error: `views`
 * is null and the report keeps rendering.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReportViewsApi, SaveViewInput } from './views-api-types';
import { writeFailureMessage } from './write-failure';

export interface SavedViewLike {
  id: string;
  isDefault: boolean;
  /** BACKLOG-4087. Missing = the user's own view. */
  access?: 'owner' | 'editor' | 'viewer';
}

export interface UseReportSavedViews<V, F, M> {
  /** null = the list could not be read; [] = there are none. */
  views: V[] | null;
  loading: boolean;
  /** What the database said when it refused the last write; cleared by the next one. */
  writeError: string | null;
  /** The id of the view flagged as this report's default, or null. */
  defaultViewId: string | null;
  save(input: Omit<SaveViewInput<F, M>, 'reportKey'>): void;
  remove(view: V): void;
  /** Make `view` the default, or clear the default (null). */
  setDefault(view: V | null): void;
  /**
   * Run any other write the same way (BACKLOG-4087: an editor update, leaving a shared view): a
   * refusal sets `writeError`, and both outcomes re-read the list.
   */
  write(op: () => Promise<unknown>): void;
}

export function useReportSavedViews<V extends SavedViewLike, F, M>(
  api: ReportViewsApi<V, F, M> | undefined,
  reportKey: string
): UseReportSavedViews<V, F, M> {
  const [views, setViews] = useState<V[] | null>(null);
  const [loading, setLoading] = useState(Boolean(api));
  const [reloadToken, setReloadToken] = useState(0);
  const [writeError, setWriteError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) {
      setViews(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .list(reportKey)
      .then((rows) => {
        if (!cancelled) setViews(rows);
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('Saved views are unavailable:', err);
          setViews(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, reportKey, reloadToken]);

  /** A refused write says so, and both outcomes re-read what the database holds. */
  const run = useCallback((op: () => Promise<unknown>) => {
    setWriteError(null);
    void op()
      .then(() => setReloadToken((t) => t + 1))
      .catch((err) => {
        console.error('Saved view change failed:', err);
        setWriteError(writeFailureMessage(err));
        setReloadToken((t) => t + 1);
      });
  }, []);

  const save = useCallback(
    (input: Omit<SaveViewInput<F, M>, 'reportKey'>) => {
      if (!api) return;
      run(() => api.save({ ...input, reportKey }));
    },
    [api, reportKey, run]
  );

  const remove = useCallback(
    (view: V) => {
      if (!api) return;
      run(() => api.remove(view.id));
    },
    [api, run]
  );

  const setDefault = useCallback(
    (view: V | null) => {
      if (!api) return;
      run(() => api.setDefault(reportKey, view ? view.id : null));
    },
    [api, reportKey, run]
  );

  // Own views only (BACKLOG-4087): a shared view is never the user's default.
  const defaultViewId = useMemo(
    () => (views ?? []).find((v) => v.isDefault && (v.access === undefined || v.access === 'owner'))?.id ?? null,
    [views]
  );

  return { views, loading, writeError, defaultViewId, save, remove, setDefault, write: run };
}
