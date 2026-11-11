'use client';

/**
 * Sharing for one report's saved views (BACKLOG-4087)
 *
 * Returns the kit `SavedViews` `sharing` prop and the kit `SharingDialog` props. A report passes the
 * first to SavedViews and renders `<SharingDialog {...shareDialog} />` once.
 *
 * BACKLOG-3513 PR-4: the dialog is the kit SharingDialog. The owner row is the caller ("You": Share
 * is offered on own rows only); people only (no roles, no general access, no Make owner). A level
 * change is ONE `report_share_set` (an upsert), never remove + grant; Share loops the same upsert
 * once per person picked, then re-reads once.
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
 * - BACKLOG-4142: with `renderMetric`, Update opens the kit's inline form with that picker, seeded
 *   with the view's own metric. The picked metric is sent only when the kit marks it as picked
 *   (`metricPicked`); otherwise the view's own metric wins, as without a picker. `normalizeMetric`
 *   (the report's column/function allowlist) is applied to the seed and to the picked metric.
 * - Leave (shared rows): `report_share_remove` with the caller's own id.
 * Update and Leave go through the saved-views write runner, so a refusal shows and the list re-reads.
 *
 * - BACKLOG-4144: Share is offered only when the caller's access to the open report (from
 *   `ReportAccessProvider`) is editor or owner. A report viewer, or a page with no provider, gets
 *   Update and Leave but no Share.
 *
 * Hiding these is presentation only. The server functions are the access guard.
 */

import { useCallback, useRef, useState, type ReactNode } from 'react';
import type { SavedViewItem, SavedViewsSharing, SavedViewUpdate, SharingDialogProps, SharingEntry, SharingPrincipal } from '@keepr/ui';
import { useAuth } from '@/components/providers/AuthProvider';
import { canShareViews } from './report-access';
import { useOpenReport } from './report-access-context';
import { isMissingFunctionError, type ShareApi, type ShareCandidate, type ShareGrant } from './report-share-api';
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
  /** Spread onto one SharingDialog. */
  shareDialog: SharingDialogProps;
}

/** The saved-view copy under the title (unchanged from the v1 dialog). */
export const VIEW_SHARE_DESCRIPTION = 'People you add see this view under “Shared with you”.';

/** The saved-view level lines (unchanged from the v1 dialog). */
export const VIEW_SHARE_LEVELS: SharingDialogProps['levels'] = [
  { value: 'viewer', label: 'Can view', description: 'Opens the view' },
  { value: 'editor', label: 'Can edit', description: 'Also updates its filters and metric' },
];

/** The signed-in user, as `useAuth()` gives it: only the fields the owner row reads. */
interface SignedInUser {
  id: string;
  user_metadata?: { full_name?: unknown; name?: unknown } | null;
}

/**
 * The owner row (BACKLOG-3513 PR-6). Share is offered on the caller's own rows only (kit
 * SavedViews own-row gate; every report_share_* function checks the view's owner is the caller), so
 * the owner is always the signed-in user: `isYou` is always true. The name is the one the header
 * and sidebar show, without their email fallback: `full_name`, else `name`, else empty, which the
 * kit reads as "You". The id is the user's own; the kit uses it to keep the owner out of the picker.
 */
export function viewShareOwner(user: SignedInUser | null | undefined): NonNullable<SharingDialogProps['owner']> {
  const meta = user?.user_metadata ?? {};
  const pick = (v: unknown) => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : '');
  return { id: user?.id ?? '', name: pick(meta.full_name) || pick(meta.name), isYou: true };
}

/**
 * After `Promise.allSettled` over a batch of writes: throws the first refusal, so the caller shows it.
 * Runs only once every write has settled, so a re-read after it sees all of them.
 */
export function throwFirstRejection(results: readonly PromiseSettledResult<unknown>[]): void {
  const refused = results.find((r): r is PromiseRejectedResult => r?.status === 'rejected');
  if (refused) throw refused.reason;
}

/** Picker rows: people only. */
export function toPrincipals(rows: readonly ShareCandidate[] | null): SharingPrincipal[] | null {
  return rows ? rows.map((c) => ({ id: c.id, kind: 'person' as const, name: c.name })) : null;
}

/** Access rows: people only, the grant's role as the level. */
export function toEntries(rows: readonly ShareGrant[] | null): SharingEntry[] | null {
  return rows ? rows.map((g) => ({ id: g.userId, kind: 'person' as const, name: g.name, level: g.role })) : null;
}

/** True when the server's list function is the one that ships with the share functions. */
export function serverSupportsSharing(views: readonly SharedViewFields[] | null): boolean {
  return (views ?? []).some((v) => v.accessFromServer === true);
}

export function useReportViewSharing<V extends SavedViewItem & SharedViewFields, F, M>(
  shareApi: ShareApi | undefined,
  saved: Pick<UseReportSavedViews<V, F, M>, 'views' | 'write'>,
  reportKey: string,
  current: () => SavedViewUpdate<F, M>,
  /**
   * The card metric picker (BACKLOG-4142). Given: an editor picks the metric in the Update form
   * and that metric is sent. Absent: the view's own metric overrides the payload, as before.
   */
  renderMetric?: (value: M, onChange: (next: M) => void) => ReactNode,
  /**
   * The report's metric allowlist (BACKLOG-4142): returns a metric made only of that report's
   * columns and functions, falling back to its default. Applied to the picker's seed and to the
   * picked metric before it is written into someone else's view.
   */
  normalizeMetric?: (raw: unknown) => M
): UseReportViewSharing<V> {
  const normalize = (raw: unknown): unknown => (normalizeMetric ? normalizeMetric(raw) : raw);
  const mayShare = canShareViews(useOpenReport()?.access ?? null);
  const { user } = useAuth();
  const [missing, setMissing] = useState(false);
  const [target, setTarget] = useState<V | null>(null);
  const [candidates, setCandidates] = useState<ShareCandidate[] | null>(null);
  const [grants, setGrants] = useState<ShareGrant[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const noteFailure = useCallback((err: unknown) => {
    if (isMissingFunctionError(err)) setMissing(true);
    console.error('Saved view sharing failed:', err);
    setError(writeFailureMessage(err));
  }, []);

  // The view the dialog is open for. A reply for any other view (the owner moved from A to B before
  // A's read returned, or closed the dialog) is discarded, so B never shows A's people.
  const openViewId = useRef<string | null>(null);
  const isOpenFor = (viewId: string) => openViewId.current === viewId;

  const readDialog = useCallback(
    (api: ShareApi, viewId: string) => {
      api.candidates(viewId).then(
        (rows) => {
          if (isOpenFor(viewId)) setCandidates(rows);
        },
        (err) => {
          if (!isOpenFor(viewId)) return;
          setCandidates(null);
          noteFailure(err);
        }
      );
      api.grants(viewId).then(
        (rows) => {
          if (isOpenFor(viewId)) setGrants(rows);
        },
        (err) => {
          if (!isOpenFor(viewId)) return;
          setGrants(null);
          noteFailure(err);
        }
      );
    },
    [noteFailure]
  );

  const available = Boolean(shareApi) && !missing && serverSupportsSharing(saved.views);

  const sharing: SavedViewsSharing<V> | undefined =
    available && shareApi
      ? {
          ...(mayShare
            ? {
                onShare: (view: V) => {
                  openViewId.current = view.id;
                  setTarget(view);
                  setCandidates(null);
                  setGrants(null);
                  setError(null);
                  readDialog(shareApi, view.id);
                },
              }
            : {}),
          onLeave: (view) => {
            saved.write(() =>
              shareApi.leave(view.id).catch((err) => {
                if (isMissingFunctionError(err)) setMissing(true);
                throw err;
              })
            );
          },
          onUpdate: (view, payload, options) => {
            // With a picker AND the kit's marker, the payload's metric is the one the editor chose
            // in the form (seeded with the view's own, initial below): sent after the allowlist.
            // A payload without the marker came from a one-click Update (a kit that never ran the
            // picker), so it falls through to the view's own metric below.
            // Without one: the page's filters and the VIEW's own metric when it has one (a pinned
            // card's column and function). `current()` cannot know which view is being updated, and
            // on the pinning reports its metric is the save form's, which an editor never touched:
            // sending it would reset the owner's card. Reports with no per-view metric send the
            // payload's fixed one.
            const own = (view as { metric?: unknown }).metric;
            const picked = renderMetric !== undefined && options?.metricPicked === true;
            const metric = picked ? normalize(payload.metric) : own !== undefined ? own : payload.metric;
            saved.write(() =>
              shareApi.update({
                reportKey,
                id: view.id,
                filters: payload.filters,
                metric,
              })
            );
          },
          current,
          ...(renderMetric
            ? {
                updateMetric: {
                  // The view's own metric; a view saved without one starts from the page's.
                  initial: (view: V) => {
                    const own = (view as { metric?: M }).metric;
                    return normalize(own !== undefined ? own : current().metric) as M;
                  },
                  // The kit slot is typed with the default (unknown) metric, like `sharing` itself;
                  // the values it hands back are the ones `initial` and this picker made.
                  render: (value: unknown, onChange: (next: unknown) => void) => renderMetric(value as M, onChange),
                },
              }
            : {}),
        }
      : undefined;

  function afterWrite(op: Promise<unknown>, viewId: string) {
    if (!shareApi) return;
    setError(null);
    op.then(
      () => readDialog(shareApi, viewId),
      (err) => {
        if (isOpenFor(viewId)) noteFailure(err);
        readDialog(shareApi, viewId);
      }
    );
  }

  const shareDialog: SharingDialogProps = {
    open: target !== null,
    onOpenChange: (open) => {
      if (!open) {
        openViewId.current = null;
        setTarget(null);
      }
    },
    name: target?.name ?? '',
    description: VIEW_SHARE_DESCRIPTION,
    levels: VIEW_SHARE_LEVELS,
    owner: viewShareOwner(user),
    candidates: toPrincipals(candidates),
    entries: toEntries(grants),
    error,
    onGrant: (principals, level) => {
      if (!shareApi || !target) return;
      const viewId = target.id;
      // One upsert per person picked (people only), all started now. The re-read waits for every
      // one to settle (allSettled, not all: all would reject on the first refusal while others are
      // still being written); then the first refusal, if any, is shown.
      const people = principals.filter((p) => p.kind === 'person');
      afterWrite(Promise.allSettled(people.map((p) => shareApi.share(viewId, p.id, level))).then(throwFirstRejection), viewId);
    },
    onChangeLevel: (entry, level) => {
      if (!shareApi || !target) return;
      // In place: report_share_set upserts, so one call changes the level.
      afterWrite(shareApi.share(target.id, entry.id, level), target.id);
    },
    onRemove: (entry) => {
      if (!shareApi || !target) return;
      afterWrite(shareApi.removeGrant(target.id, entry.id), target.id);
    },
  };

  return { sharing, shareDialog };
}
