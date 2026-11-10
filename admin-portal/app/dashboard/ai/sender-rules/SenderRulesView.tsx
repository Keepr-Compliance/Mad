'use client';

/**
 * Sender rules — the page body (BACKLOG-4186).
 *
 * Renders from the server's read (props). Every write goes through the signed-in browser session
 * client, then router.refresh() re-reads the state: nothing is updated optimistically. Write controls
 * render only for the owner (canEditSenderRules) and only when the state AND the released content
 * were read (control A18). The server functions are the enforcement.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertBanner, AlertBannerDescription, AlertBannerTitle, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ConfirmationDialog, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input, Label } from '@keepr/ui';
import { createClient } from '@/lib/supabase/client';
import { formatDate } from '@/lib/format';
import type { ReportAccess } from '@/lib/reports/report-access';
import { canEditSenderRules } from '@/lib/sender-rules/access';
import { createSenderRulesApi, SenderRulesError, type SenderRulesApi } from '@/lib/sender-rules/api';
import { diffLineText, diffRuleSets } from '@/lib/sender-rules/diff';
import type { SenderRulesLoad } from '@/lib/sender-rules/load';
import { filterOrgs, type OrgListResult } from '@/lib/sender-rules/orgs';
import { THRESHOLD_KEYS, type RuleSetPinRow, type SenderRuleSet, type ThresholdKey } from '@/lib/sender-rules/types';
import { invalidReason, setThreshold } from '@/lib/sender-rules/validate';
import { RulesCard } from './RulesCard';

/** Founder ruling 2026-11-09 (Q3), verbatim. */
export const STOP_TEST_WARNING = 'The test stops. Its changes can still be published to everyone.';
export const UNDO_ALL_WARNING = 'Every org goes back to the default rules. Running tests stop. Apps pick this up within 6 hours.';
export const PICKUP_NOTE = 'Apps pick up changes within 6 hours, or on restart.';

type Notice = { tone: 'ok' | 'error'; message: string; blocks?: string[] } | null;
type DiffView = { status: 'loading' } | { status: 'ready'; lines: string[] } | { status: 'error'; message: string };
type Pending =
  | { type: 'promote'; version: number }
  | { type: 'stop'; pin: RuleSetPinRow }
  | { type: 'release' }
  | { type: 'revert' }
  | null;

export interface SenderRulesViewProps {
  access: ReportAccess;
  load: SenderRulesLoad;
  /** The owner's org list; null for everyone else. */
  orgs: OrgListResult | null;
  /** Injected in tests; the page uses the signed-in browser session client. */
  api?: SenderRulesApi;
}

const orgLabel = (name: string | null) => name ?? 'Deleted org';

function thresholdTexts(c: SenderRuleSet): Record<ThresholdKey, string> {
  return Object.fromEntries(THRESHOLD_KEYS.map((k) => [k, String(c.thresholds[k])])) as Record<ThresholdKey, string>;
}

export function SenderRulesView({ access, load, orgs, api: injected }: SenderRulesViewProps) {
  if (!load.ok) {
    return (
      <AlertBanner variant="destructive" data-testid="sender-rules-unreadable">
        <AlertBannerTitle>The sender rules could not be read.</AlertBannerTitle>
        <AlertBannerDescription>{load.message} Nothing can be changed until they can be read.</AlertBannerDescription>
      </AlertBanner>
    );
  }
  return <Loaded access={access} state={load.state} released={load.released} orgs={orgs} injected={injected} />;
}

function Loaded({
  access,
  state,
  released,
  orgs,
  injected,
}: {
  access: ReportAccess;
  state: Extract<SenderRulesLoad, { ok: true }>['state'];
  released: SenderRuleSet;
  orgs: OrgListResult | null;
  injected?: SenderRulesApi;
}) {
  const router = useRouter();
  const canEdit = canEditSenderRules(access);
  const releasedVersion = state.released_version as number;
  const releasedRow = state.versions.find((v) => v.version === releasedVersion);

  const [draft, setDraft] = useState<SenderRuleSet>(released);
  const [baseVersion, setBaseVersion] = useState<number>(releasedVersion);
  const [thresholdText, setThresholdText] = useState<Record<ThresholdKey, string>>(() => thresholdTexts(released));
  const [thresholdErrors, setThresholdErrors] = useState<Partial<Record<ThresholdKey, string>>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [pendingDiff, setPendingDiff] = useState<DiffView | null>(null);
  const [viewing, setViewing] = useState<{ version: number; diff: DiffView } | null>(null);
  const [orgQuery, setOrgQuery] = useState('');
  const [orgId, setOrgId] = useState('');

  const api = (): SenderRulesApi => injected ?? createSenderRulesApi(createClient());

  /** Diff of a stored version against everyone's rules, in words. */
  const diffOf = async (version: number): Promise<DiffView> => {
    try {
      const c = await api().content(version);
      if (c === null) return { status: 'error', message: 'Version not found' };
      return { status: 'ready', lines: diffRuleSets(released, c).map(diffLineText) };
    } catch (e) {
      return { status: 'error', message: e instanceof SenderRulesError ? e.message : 'Version ' + version + ' could not be read.' };
    }
  };

  /** Run one write; then always re-read the state (no optimistic update). */
  const run = async (op: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await op();
      setNotice({ tone: 'ok', message: done });
    } catch (e) {
      if (e instanceof SenderRulesError) setNotice({ tone: 'error', message: e.message, blocks: e.blocks });
      else setNotice({ tone: 'error', message: 'The change could not be saved.' });
    } finally {
      setBusy(false);
      setPending(null);
      setPendingDiff(null);
      router.refresh();
    }
  };

  const changes = diffRuleSets(released, draft).map(diffLineText);
  const thresholdPending = Object.values(thresholdErrors).some(Boolean);
  const draftInvalid = invalidReason(draft);
  const canPublish = changes.length > 0 && !thresholdPending && draftInvalid === null && !busy;
  const pickable = orgs && orgs.ok ? filterOrgs(orgs.orgs, orgQuery) : [];
  const pickedOrg = orgs && orgs.ok ? orgs.orgs.find((o) => o.id === orgId) : undefined;

  const onThresholdText = (key: ThresholdKey, text: string) => {
    setThresholdText((t) => ({ ...t, [key]: text }));
    const r = setThreshold(draft, key, text);
    if (r.ok) {
      setDraft(r.content);
      setThresholdErrors((e) => ({ ...e, [key]: undefined }));
    } else {
      setThresholdErrors((e) => ({ ...e, [key]: r.reason }));
    }
  };

  const editFrom = async (version: number) => {
    setBusy(true);
    setNotice(null);
    try {
      const c = await api().content(version);
      if (c === null) throw new SenderRulesError('version_not_found', 'Version not found');
      setDraft(c);
      setBaseVersion(version);
      setThresholdText(thresholdTexts(c));
      setThresholdErrors({});
    } catch (e) {
      setNotice({ tone: 'error', message: e instanceof SenderRulesError ? e.message : 'Version ' + version + ' could not be read.' });
    } finally {
      setBusy(false);
    }
  };

  const openPromote = async (version: number) => {
    setPending({ type: 'promote', version });
    setPendingDiff({ status: 'loading' });
    setPendingDiff(await diffOf(version));
  };

  const openView = async (version: number) => {
    setViewing({ version, diff: { status: 'loading' } });
    const diff = await diffOf(version);
    setViewing((v) => (v && v.version === version ? { version, diff } : v));
  };

  const diffBlock = (d: DiffView | null) =>
    d === null || d.status === 'loading' ? (
      <span className="block">Loading the changes...</span>
    ) : d.status === 'error' ? (
      <span className="block text-red-600">{d.message}</span>
    ) : d.lines.length === 0 ? (
      <span className="block">No changes from everyone&apos;s rules.</span>
    ) : (
      d.lines.map((l, i) => (
        <span key={i} className="block">
          {l}
        </span>
      ))
    );

  const versionWhere = (v: (typeof state.versions)[number]) =>
    v.released ? 'Everyone' : v.canary_org ? 'Test: ' + (v.canary_org_name ?? 'deleted org') : 'Test';

  return (
    <div className="space-y-6">
      {notice && (
        <AlertBanner variant={notice.tone === 'ok' ? 'success' : 'destructive'} data-testid="sender-rules-notice" role="status">
          <AlertBannerTitle>{notice.message}</AlertBannerTitle>
          {notice.blocks && notice.blocks.length > 0 && (
            <AlertBannerDescription>
              <ul className="list-disc pl-5">
                {notice.blocks.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
              {canEdit && orgs?.ok && <p className="mt-2">Publish them to a test org first, then to everyone.</p>}
            </AlertBannerDescription>
          )}
        </AlertBanner>
      )}

      {/* 1. Running now */}
      <Card data-testid="running-now">
        <CardHeader>
          <CardTitle className="text-base">Running now</CardTitle>
          <CardDescription>{PICKUP_NOTE}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-gray-900" data-testid="running-everyone">
            Everyone: v{releasedVersion}
            {releasedRow ? `, published ${formatDate(releasedRow.published_at)}` : ''}.
          </p>
          {state.pins.length === 0 ? (
            <p className="text-gray-500">No org is testing a version.</p>
          ) : (
            <ul className="space-y-2">
              {state.pins.map((pin) => {
                const row = state.versions.find((v) => v.version === pin.version);
                const promotable = pin.version > releasedVersion && row !== undefined && !row.released;
                return (
                  <li key={pin.org_id} className="flex flex-wrap items-center justify-between gap-2" data-testid={`pin-${pin.org_id}`}>
                    <span className="text-gray-900">
                      {orgLabel(pin.org_name)} is testing v{pin.version} since {formatDate(pin.pinned_at)}.
                    </span>
                    {canEdit && (
                      <span className="flex gap-2">
                        {promotable && (
                          <Button size="sm" disabled={busy} onClick={() => openPromote(pin.version)}>
                            Make this everyone&apos;s
                          </Button>
                        )}
                        <Button size="sm" variant="secondary" disabled={busy} onClick={() => setPending({ type: 'stop', pin })}>
                          Stop test
                        </Button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* 2. Rules (owner: Edit) */}
      <RulesCard
        content={canEdit ? draft : released}
        readOnly={!canEdit}
        baseVersion={baseVersion}
        releasedVersion={releasedVersion}
        onChange={canEdit ? setDraft : undefined}
        thresholdText={canEdit ? thresholdText : undefined}
        thresholdErrors={canEdit ? thresholdErrors : undefined}
        onThresholdText={canEdit ? onThresholdText : undefined}
      />

      {/* 3. Review and publish (owner) */}
      {canEdit && (
        <Card data-testid="review-publish">
          <CardHeader>
            <CardTitle className="text-base">Review and publish</CardTitle>
            <CardDescription>Changes compared with everyone&apos;s rules (v{releasedVersion}).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {changes.length === 0 ? (
              <p className="text-gray-500" data-testid="no-changes">
                No changes.
              </p>
            ) : (
              <ul className="list-disc space-y-1 pl-5 text-gray-900" data-testid="draft-changes">
                {changes.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            )}
            {draftInvalid !== null && changes.length > 0 && (
              <p className="text-red-600" role="alert">
                Invalid rule set: {draftInvalid}
              </p>
            )}

            <div className="space-y-2">
              <h4 className="font-medium text-gray-900">Publish to a test org</h4>
              {orgs && orgs.ok ? (
                <div className="flex flex-wrap items-end gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="org-search">Find an org</Label>
                    <Input id="org-search" value={orgQuery} onChange={(e) => setOrgQuery(e.target.value)} className="h-8 w-56" />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="org-pick">Test org</Label>
                    <select
                      id="org-pick"
                      value={orgId}
                      onChange={(e) => setOrgId(e.target.value)}
                      className="h-8 w-64 rounded-md border border-gray-300 bg-white px-2 text-sm"
                    >
                      <option value="">Pick an org</option>
                      {pickable.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.isTest ? 'Test · ' : ''}
                          {o.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!canPublish || !pickedOrg}
                    onClick={() =>
                      pickedOrg && run(() => api().publishCanary(draft, pickedOrg.id), `Published to ${pickedOrg.name} for testing.`)
                    }
                  >
                    Publish to test org
                  </Button>
                </div>
              ) : (
                <p className="text-red-600" data-testid="orgs-unreadable">
                  The org list could not be read. Publishing to a test org is not available.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <h4 className="font-medium text-gray-900">Publish to everyone</h4>
              <Button size="sm" disabled={!canPublish} onClick={() => setPending({ type: 'release' })}>
                Publish to everyone
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 4. History */}
      <Card data-testid="history">
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="text-base">History</CardTitle>
            {state.truncated && <CardDescription>Showing the newest 200.</CardDescription>}
          </div>
          {canEdit && (
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => setPending({ type: 'revert' })}>
              Undo everything
            </Button>
          )}
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-gray-100 text-sm">
            {state.versions.map((v) => (
              <li key={v.version} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid={`version-${v.version}`}>
                <span className="text-gray-900">
                  v{v.version} · {versionWhere(v)}
                  {v.bundled ? ' · Default (bundled)' : ''} · {formatDate(v.published_at)}
                </span>
                <span className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => openView(v.version)}>
                    View
                  </Button>
                  {canEdit && (
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => editFrom(v.version)}>
                      Edit from this version
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* Dialogs */}
      {viewing && (
        <Dialog open onOpenChange={(o) => !o && setViewing(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>v{viewing.version} compared with everyone&apos;s rules</DialogTitle>
              <DialogDescription asChild>
                <div className="space-y-1 text-sm" data-testid="view-diff">
                  {diffBlock(viewing.diff)}
                </div>
              </DialogDescription>
            </DialogHeader>
          </DialogContent>
        </Dialog>
      )}

      {canEdit && pending?.type === 'promote' && (
        <ConfirmationDialog
          open
          title={`Make v${pending.version} everyone's`}
          description={
            <>
              <span className="block">Every org gets v{pending.version}. Tests running on other orgs stop.</span>
              {diffBlock(pendingDiff)}
            </>
          }
          confirmLabel="Make this everyone's"
          loading={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => run(() => api().promote(pending.version), `v${pending.version} is now everyone's.`)}
        />
      )}

      {canEdit && pending?.type === 'stop' && (
        <ConfirmationDialog
          open
          title={`Stop the test on ${orgLabel(pending.pin.org_name)}`}
          description={STOP_TEST_WARNING}
          confirmLabel="Stop test"
          loading={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => run(() => api().unpin(pending.pin.org_id), `The test on ${orgLabel(pending.pin.org_name)} stopped.`)}
        />
      )}

      {canEdit && pending?.type === 'release' && (
        <ConfirmationDialog
          open
          title="Publish to everyone"
          description={
            <>
              <span className="block">Every org gets these changes:</span>
              {changes.map((l, i) => (
                <span key={i} className="block">
                  {l}
                </span>
              ))}
              {state.pins.length > 0 && (
                <span className="block" data-testid="release-stops-tests">
                  Tests running on {state.pins.length} org(s) stop.
                </span>
              )}
            </>
          }
          confirmLabel="Publish to everyone"
          loading={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => run(() => api().publishRelease(draft), 'Published to everyone.')}
        />
      )}

      {canEdit && pending?.type === 'revert' && (
        <ConfirmationDialog
          open
          title="Undo everything"
          description={UNDO_ALL_WARNING}
          confirmLabel="Undo everything"
          isDestructive
          loading={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => run(() => api().revertAll(), 'Every org is back on the default rules.')}
        />
      )}
    </div>
  );
}
