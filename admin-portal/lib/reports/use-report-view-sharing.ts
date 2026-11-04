'use client';

/**
 * Sharing for one report's saved views (BACKLOG-4087)
 *
 * Returns the kit `SavedViews` `sharing` prop and the kit `ShareDialog` props. A report passes the
 * first to SavedViews and renders `<ShareDialog {...shareDialog} />` once.
 *
 * OFFERED ONLY WHEN THE DATABASE HAS THE SHARE FUNCTIONS. The list function that ships with them
 * always sends `access` on every row; an older one never does. So `sharing` is undefined (no Share,
 * Update or Leave) until a listed row carries `access` from the server, and it goes away again if
 * any share function answers "no such function". No api, no rows, a list that could not be read:
 * undefined too.
 *
 * - Share (own rows): opens the dialog for that view and reads its candidates and grants. The
 *   picker options are `report_share_candidates` output and nothing else.
 * - Update (editor rows): the page's filters, read from `current()` at click time, and the view's
 *   own metric when it has one (else the payload's fixed metric).
 * - Leave (shared rows): `report_share_remove` with the caller's own id.
 * Update and Leave go through the saved-views write runner, so a refusal shows and the list re-reads.
 *
 * Hiding these is presentation only. The server functions are the access guard.
 */

import { useCallback, useState } from 'react';
import type { SavedViewItem, SavedViewsSharing, SavedViewUpdate, ShareDialogProps } from '@keepr/ui';
import { isMissingFunctionError, type ShareApi } from './report-share-api';
import { writeFailureMessage } from './report-views';
import type { SharedViewFields } from './saved-view-access';
import type { UseReportSavedViews } from './use-report-saved-views';

export interface UseReportViewSharing<V extends SavedViewItem> {
  /**
   * Pass to SavedViews. Undefined = sharing is not offered. Typed with the kit's default payload
   * generics so a report's `<SavedViews<V>>` accepts it; the payload is still the closed
   * `SavedViewUpdate` (filters + metric), and it is whatever `current()` returned.
   */
  sharing: SavedViewsSharing<V> | undefined;
  /** Spread onto one ShareDialog. */
  shareDialog: ShareDialogProps;
}

/** True when the server's list function is the one that ships with the share functions. */
export function serverSupportsSharing(views: readonly SharedViewFields[] | null): boolean {
  return (views ?? []).some((v) => v.accessFromServer === true);
}

export function useReportViewSharing<V extends SavedViewItem & SharedViewFields, F, M>(
  shareApi: ShareApi | undefined,
  saved: Pick<UseReportSavedViews<V, F, M>, 'views' | 'write'>,
  reportKey: string,
  current: () => SavedViewUpdate<F, M>
): UseReportViewSharing<V> {
  const [missing, setMissing] = useState(false);
  const [target, setTarget] = useState<V | null>(null);
  const [candidates, setCandidates] = useState<ShareDialogProps['candidates']>(null);
  const [grants, setGrants] = useState<ShareDialogProps['grants']>(null);
  const [error, setError] = useState<string | null>(null);

  const noteFailure = useCallback((err: unknown) => {
    if (isMissingFunctionError(err)) setMissing(true);
    console.error('Saved view sharing failed:', err);
    setError(writeFailureMessage(err));
  }, []);

  const readDialog = useCallback(
    (api: ShareApi, viewId: string) => {
      api.candidates(viewId).then(setCandidates, (err) => {
        setCandidates(null);
        noteFailure(err);
      });
      api.grants(viewId).then(setGrants, (err) => {
        setGrants(null);
        noteFailure(err);
      });
    },
    [noteFailure]
  );

  const available = Boolean(shareApi) && !missing && serverSupportsSharing(saved.views);

  const sharing: SavedViewsSharing<V> | undefined =
    available && shareApi
      ? {
          onShare: (view) => {
            setTarget(view);
            setCandidates(null);
            setGrants(null);
            setError(null);
            readDialog(shareApi, view.id);
          },
          onLeave: (view) => {
            saved.write(() =>
              shareApi.leave(view.id).catch((err) => {
                if (isMissingFunctionError(err)) setMissing(true);
                throw err;
              })
            );
          },
          onUpdate: (view, payload) => {
            // The page's filters; the VIEW's own metric when it has one (a pinned card's column and
            // function). `current()` cannot know which view is being updated, and on the pinning
            // reports its metric is the save form's, which an editor never touched: sending it would
            // reset the owner's card. Reports with no per-view metric send the payload's fixed one.
            const own = (view as { metric?: unknown }).metric;
            saved.write(() =>
              shareApi.update({
                reportKey,
                id: view.id,
                filters: payload.filters,
                metric: own !== undefined ? own : payload.metric,
              })
            );
          },
          current,
        }
      : undefined;

  function afterWrite(op: Promise<unknown>, viewId: string) {
    if (!shareApi) return;
    setError(null);
    op.then(
      () => readDialog(shareApi, viewId),
      (err) => {
        noteFailure(err);
        readDialog(shareApi, viewId);
      }
    );
  }

  const shareDialog: ShareDialogProps = {
    open: target !== null,
    onOpenChange: (open) => {
      if (!open) setTarget(null);
    },
    viewName: target?.name ?? '',
    candidates,
    grants,
    error,
    onGrant: (userId, role) => {
      if (!shareApi || !target) return;
      afterWrite(shareApi.share(target.id, userId, role), target.id);
    },
    onRemove: (grant) => {
      if (!shareApi || !target) return;
      afterWrite(shareApi.removeGrant(target.id, grant.userId), target.id);
    },
  };

  return { sharing, shareDialog };
}
