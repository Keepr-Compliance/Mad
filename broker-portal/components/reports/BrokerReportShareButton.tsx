'use client';

/**
 * Share a shared broker report — BACKLOG-3513 PR-3b.
 *
 * The kit SharingDialog, used as is. Rulings (pm_comments on BACKLOG-3513):
 * - Shown to the owner and to editors (Q5), agents included (Q2b, V5). A viewer
 *   never sees it.
 * - Editors may add people and roles, change levels and general access, and
 *   change the row scope (V7a). "Make owner…" only for the owner (Q5); delete
 *   is not here (DeleteReportButton, owner only).
 * - Targets: people and three roles (All agents, All brokers, All admins), as
 *   broker_report_share_candidates sends them. No emails anywhere.
 * - "Everyone in <org>" includes agents at Can view; its description says so (Q4).
 * - Row scope default "All rows they can already see"; "Only their own" limits
 *   Can view only (Q3, Q7).
 *
 * Reads, copied from admin-portal/components/reports/ReportShareButton.tsx:
 * one number per opening (a reply from an earlier opening is dropped) and the
 * latest read wins (a slower earlier re-read never brings back a row a later
 * write removed). Each write returns its promise so the kit shows it in flight;
 * the re-read after it is the source of truth.
 *
 * Presentation only: every broker_report_* function checks the caller's level.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Share2 } from 'lucide-react';
import {
  Button,
  SharingDialog,
  type SharingEntry,
  type SharingLevelOption,
  type SharingOwner,
  type SharingPrincipal,
} from '@keepr/ui';
import {
  reportSharingApi,
  roleLabel,
  type DefinitionRecord,
  type GeneralAccess,
  type ReportLevel,
  type ReportSharingApi,
  type RowScope,
  type ShareState,
} from '@/lib/reports/sharing/sharing-api';
import { writeFailureMessage } from '@/lib/reports/sharing/write-failure';

export const SHARE_DESCRIPTION = 'People you add can open this report.';

export const SHARE_LEVELS: SharingLevelOption[] = [
  { value: 'viewer', label: 'Can view', description: 'Opens the report' },
  { value: 'editor', label: 'Can edit', description: 'Also edits and shares it' },
];

export const ROW_SCOPE_TITLE = 'What each person sees';
export const ROW_SCOPE_OPTIONS: ReadonlyArray<{ value: RowScope; label: string; description?: string }> = [
  { value: 'all', label: 'All rows they can already see' },
  { value: 'own', label: 'Only their own', description: 'Applies to people with Can view.' },
];

export function generalAccessOptions(orgName: string) {
  return [
    { value: 'restricted', label: 'Only people added' },
    {
      value: 'organization',
      label: `Everyone in ${orgName}`,
      description: `Anyone in ${orgName} can view it. Agents see only their own rows.`,
    },
  ];
}

/** Share is offered to the owner and to editors only. */
export function canShare(level: ReportLevel | null | undefined): boolean {
  return level === 'owner' || level === 'editor';
}

/** The owner row: their name, and their role or "Deactivated" (a deactivated owner stays owner). */
export function shareOwner(owner: ShareState['owner']): SharingOwner {
  const detail = owner.id === null ? undefined : owner.role ? roleLabel(owner.role) : 'Deactivated';
  return {
    id: owner.id ?? '',
    name: owner.id === null ? 'Former member' : owner.name,
    isYou: owner.isYou,
    ...(detail ? { detail } : {}),
  };
}

export interface BrokerReportShareButtonProps {
  defId: string;
  name: string;
  /** The brokerage's name, for "Everyone in <org>". */
  orgName: string;
  /** The caller's level from the page's read (broker_report_def_get). */
  level: ReportLevel | null;
  api?: ReportSharingApi;
}

export function BrokerReportShareButton({ defId, name, orgName, level: pageLevel, api = reportSharingApi }: BrokerReportShareButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ShareState | null>(null);
  const [candidates, setCandidates] = useState<SharingPrincipal[] | null>(null);
  const [def, setDef] = useState<DefinitionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scopeSaving, setScopeSaving] = useState(false);

  // One number per opening; a reply from an earlier opening is dropped.
  const session = useRef(0);
  // Latest read wins: a reply from a read older than the newest one sent is dropped.
  const readSeq = useRef(0);

  const noteFailure = useCallback((err: unknown) => {
    console.error('Report sharing failed:', err);
    setError(writeFailureMessage(err));
  }, []);

  const read = useCallback(
    (id: number) => {
      const seq = ++readSeq.current;
      const current = () => session.current === id && readSeq.current === seq;
      api.state(defId).then(
        (s) => current() && setState(s),
        (err) => {
          if (!current()) return;
          setState(null);
          noteFailure(err);
        }
      );
      api.candidates(defId).then(
        (rows) => current() && setCandidates(rows),
        (err) => {
          if (!current()) return;
          setCandidates(null);
          noteFailure(err);
        }
      );
      api.definition(defId).then(
        (d) => current() && setDef(d),
        (err) => {
          if (!current()) return;
          setDef(null);
          noteFailure(err);
        }
      );
    },
    [api, defId, noteFailure]
  );

  const entries = useMemo<SharingEntry[] | null>(() => (state ? state.entries : null), [state]);
  const level = state?.level ?? pageLevel;

  if (!canShare(pageLevel)) return null;

  /** Re-read after a write and show a refusal. Returns `op` so the kit shows the row in flight. */
  function afterWrite(op: Promise<unknown>): Promise<unknown> {
    const id = session.current;
    setError(null);
    op.then(
      () => session.current === id && read(id),
      (err) => {
        if (session.current !== id) return;
        noteFailure(err);
        read(id);
      }
    );
    return op;
  }

  const rowScope: RowScope = state?.rowScope ?? def?.rowScope ?? 'all';
  const scopeDisabled = def === null || scopeSaving;

  function changeRowScope(next: RowScope) {
    if (!def || next === rowScope) return;
    setScopeSaving(true);
    afterWrite(api.setRowScope(def, next)).then(
      () => setScopeSaving(false),
      () => setScopeSaving(false)
    );
  }

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        aria-label={`Share ${name}`}
        onClick={() => {
          session.current += 1;
          setState(null);
          setCandidates(null);
          setDef(null);
          setError(null);
          setOpen(true);
          read(session.current);
        }}
      >
        <Share2 className="h-4 w-4" aria-hidden="true" />
        Share
      </Button>
      <SharingDialog
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            session.current += 1;
            setOpen(false);
            // The page shows the level, owner and Delete from its own read: refresh it.
            router.refresh();
          }
        }}
        name={name}
        description={SHARE_DESCRIPTION}
        levels={SHARE_LEVELS}
        candidates={candidates}
        entries={entries}
        owner={state ? shareOwner(state.owner) : undefined}
        error={error}
        onGrant={(principals, lvl) => {
          // ONE call carrying every principal picked; the database validates them all first.
          afterWrite(api.share(defId, principals, lvl));
        }}
        onChangeLevel={(entry, lvl) => afterWrite(api.share(defId, [entry], lvl))}
        onRemove={(entry) => afterWrite(api.remove(defId, entry.kind, entry.id))}
        {...(level === 'owner'
          ? { onTransferOwnership: (entry: SharingEntry) => void afterWrite(api.transfer(defId, entry.id)) }
          : {})}
        generalAccess={{
          value: state?.generalAccess ?? 'restricted',
          options: generalAccessOptions(orgName),
          onChange: (value) => void afterWrite(api.setGeneralAccess(defId, value as GeneralAccess)),
          disabled: state === null,
        }}
        extraSection={{
          title: ROW_SCOPE_TITLE,
          content: (
            <fieldset className="flex flex-col gap-2" aria-label={ROW_SCOPE_TITLE}>
              {ROW_SCOPE_OPTIONS.map((o) => (
                <label key={o.value} className="flex items-start gap-2 text-sm text-gray-900">
                  <input
                    type="radio"
                    name={`row-scope-${defId}`}
                    value={o.value}
                    checked={rowScope === o.value}
                    disabled={scopeDisabled}
                    onChange={() => changeRowScope(o.value)}
                    className="mt-0.5"
                  />
                  <span className="flex flex-col">
                    <span>{o.label}</span>
                    {o.description ? <span className="text-xs text-gray-500">{o.description}</span> : null}
                  </span>
                </label>
              ))}
            </fieldset>
          ),
        }}
      />
    </>
  );
}
