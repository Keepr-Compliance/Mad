'use client';

/**
 * "Move people onto your brokerage" — BACKLOG-3962 PR3b.
 *
 * Rendered by ./page.tsx only when loadCaptureSection returned a list (admin or IT admin through
 * requireDomainClaimAccess, and at least one verified domain). It carries no gate of its own:
 * startCapture and cancelCapture re-check on the server, take the organization from the session,
 * and the database re-evaluates every person.
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Badge,
  EmptyState,
  Modal,
  Table,
  TableBody,
  TableContainer,
  TableHead,
  Td,
  Th,
  Tr,
} from '@keepr/design-system';
import { AlertBanner, Button } from '@keepr/ui';
import { cancelCapture, startCapture } from '@/lib/actions/domainCapture';
import { DOMAIN_CAPTURE_FAILED, DOMAIN_CAPTURE_UNAVAILABLE } from '@/lib/domain/captureMessages';
import {
  CAPTURE_CANCEL_CONFIRM,
  CAPTURE_CANNOT_MOVE,
  CAPTURE_CAN_MOVE,
  CAPTURE_EMPTY_DESCRIPTION,
  CAPTURE_EMPTY_TITLE,
  CAPTURE_LOAD_FAILED,
  CAPTURE_NOTICE_RETRYING,
  CAPTURE_SECTION_INTRO,
  CAPTURE_SECTION_TITLE,
  CAPTURE_DEFER_DETAIL,
  captureDeferLabel,
  captureEndedLabel,
  captureReasonCopy,
  captureScheduledLabel,
  captureStartConfirmText,
  formatCaptureDate,
} from '@/lib/domain/captureCopy';
import { isSelectable, type CaptureDomainView, type CaptureRow } from '@/lib/domain/captureView';

const NOTICE_DAYS = 14;

type BadgeHue = 'gray' | 'green' | 'yellow' | 'red';

interface Notice {
  tone: 'success' | 'destructive' | 'info';
  text: string;
}

function rowStatus(row: CaptureRow, now: number): { label: string; hue: BadgeHue; detail: string | null } {
  if (row.switchId && row.switchAt) {
    const due = new Date(row.switchAt).getTime();
    if (!Number.isNaN(due) && due <= now) {
      return {
        label: captureDeferLabel(row.lastDeferReason),
        hue: 'yellow',
        detail: (row.lastDeferReason && CAPTURE_DEFER_DETAIL[row.lastDeferReason]) || null,
      };
    }
    return {
      label: captureScheduledLabel(formatCaptureDate(row.switchAt)),
      hue: 'yellow',
      detail: row.noticeDelivered === null ? CAPTURE_NOTICE_RETRYING : null,
    };
  }
  if (row.ended) {
    const label = captureEndedLabel(row.ended.status, row.ended.reason);
    const hue: BadgeHue = row.ended.status === 'switched' ? 'green' : 'gray';
    const detail = !row.convertible && row.reason ? captureReasonCopy(row.reason) : null;
    return { label, hue, detail };
  }
  if (row.convertible) return { label: CAPTURE_CAN_MOVE, hue: 'green', detail: null };
  return { label: CAPTURE_CANNOT_MOVE, hue: 'gray', detail: captureReasonCopy(row.reason) };
}

function DomainCapture({ view }: { view: CaptureDomainView }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [moveDate, setMoveDate] = useState('');
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const now = Date.now();
  const selectAllRef = useRef<HTMLInputElement>(null);
  const selectableIds = view.rows.filter(isSelectable).map((r) => r.userId);
  const chosenIds = selectableIds.filter((id) => selected.has(id));
  const selectedCount = chosenIds.length;
  const allSelected = selectableIds.length > 0 && selectedCount === selectableIds.length;
  const someSelected = selectedCount > 0 && !allSelected;

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected;
  }, [someSelected]);

  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) selectableIds.forEach((id) => next.delete(id));
      else selectableIds.forEach((id) => next.add(id));
      return next;
    });
  };

  const toggle = (userId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const openConfirm = () => {
    setMoveDate(formatCaptureDate(new Date(Date.now() + NOTICE_DAYS * 86_400_000).toISOString()));
    setConfirmOpen(true);
  };

  const handleStart = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await startCapture({ claimId: view.claimId, userIds: chosenIds });
      setNotice({ tone: res.success ? 'success' : 'destructive', text: res.message });
      if (res.success) {
        setSelected(new Set());
        router.refresh();
      }
    } catch {
      setNotice({ tone: 'destructive', text: DOMAIN_CAPTURE_FAILED });
    } finally {
      setBusy(false);
      setConfirmOpen(false);
    }
  };

  const handleCancel = async () => {
    if (!cancelId) return;
    const id = cancelId;
    setBusy(true);
    setNotice(null);
    try {
      const res = await cancelCapture(id);
      setNotice({ tone: res.success ? 'info' : 'destructive', text: res.message });
      if (res.success) router.refresh();
    } catch {
      setNotice({ tone: 'destructive', text: DOMAIN_CAPTURE_FAILED });
    } finally {
      setBusy(false);
      setCancelId(null);
    }
  };

  return (
    <div className="space-y-3" data-testid={`capture-domain-${view.claimId}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-gray-900">{view.domain}</h3>
        {view.state === 'ok' && view.rows.length > 0 && (
          <Button type="button" onClick={openConfirm} disabled={busy || chosenIds.length === 0}>
            Start
          </Button>
        )}
      </div>

      {view.state === 'unavailable' && <AlertBanner variant="warning">{DOMAIN_CAPTURE_UNAVAILABLE}</AlertBanner>}
      {view.state === 'error' && <AlertBanner variant="destructive">{CAPTURE_LOAD_FAILED}</AlertBanner>}
      {notice && <AlertBanner variant={notice.tone}>{notice.text}</AlertBanner>}

      {view.state === 'ok' && view.rows.length === 0 && (
        <EmptyState title={CAPTURE_EMPTY_TITLE} description={CAPTURE_EMPTY_DESCRIPTION} />
      )}

      {view.state === 'ok' && view.rows.length > 0 && (
        <TableContainer scrollX>
          <Table>
            <TableHead>
              <tr>
                <Th>
                  <span className="sr-only">Select</span>
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    aria-label="Select everyone who can move"
                    checked={allSelected}
                    onChange={toggleAll}
                    disabled={busy || selectableIds.length === 0}
                  />
                </Th>
                <Th>Name</Th>
                <Th>Status</Th>
                <Th>Actions</Th>
              </tr>
            </TableHead>
            <TableBody>
              {view.rows.map((row) => {
                const status = rowStatus(row, now);
                const selectable = isSelectable(row);
                return (
                  <Tr key={row.userId} data-testid={`capture-row-${row.userId}`}>
                    <Td>
                      {selectable && (
                        <input
                          type="checkbox"
                          aria-label={`Select ${row.email}`}
                          checked={selected.has(row.userId)}
                          onChange={() => toggle(row.userId)}
                          disabled={busy}
                        />
                      )}
                    </Td>
                    <Td className="whitespace-normal break-words">
                      <div className="text-sm text-gray-900">{row.name}</div>
                      {row.name !== row.email && <div className="text-xs text-gray-500">{row.email}</div>}
                    </Td>
                    <Td className="whitespace-normal" data-testid={`capture-status-${row.userId}`}>
                      <Badge hue={status.hue}>{status.label}</Badge>
                      {status.detail && <p className="mt-1 max-w-xs text-xs text-gray-500">{status.detail}</p>}
                    </Td>
                    <Td className="whitespace-nowrap">
                      {row.switchId && (
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => setCancelId(row.switchId)}
                          disabled={busy}
                        >
                          Cancel
                        </Button>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={<span id={`capture-start-title-${view.claimId}`}>Move these people?</span>}
        aria-labelledby={`capture-start-title-${view.claimId}`}
        dismissible={!busy}
      >
        <p className="text-sm text-gray-700" data-testid="capture-start-confirm-text">
          {captureStartConfirmText(chosenIds.length, moveDate)}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => setConfirmOpen(false)} disabled={busy}>
            Back
          </Button>
          <Button type="button" onClick={handleStart} disabled={busy || chosenIds.length === 0}>
            {busy ? 'Starting...' : 'Start the move'}
          </Button>
        </div>
      </Modal>

      <Modal
        open={cancelId !== null}
        onClose={() => setCancelId(null)}
        title={<span id={`capture-cancel-title-${view.claimId}`}>Cancel the move</span>}
        aria-labelledby={`capture-cancel-title-${view.claimId}`}
        dismissible={!busy}
      >
        <p className="text-sm text-gray-700">{CAPTURE_CANCEL_CONFIRM}</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => setCancelId(null)} disabled={busy}>
            Keep it scheduled
          </Button>
          <Button type="button" onClick={handleCancel} disabled={busy}>
            {busy ? 'Cancelling...' : 'Cancel the move'}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

export interface CaptureSectionProps {
  domains: CaptureDomainView[];
}

export default function CaptureSection({ domains }: CaptureSectionProps) {
  return (
    <section className="max-w-7xl mx-auto mt-8 space-y-4" aria-labelledby="capture-section-title">
      <div>
        <h2 id="capture-section-title" className="text-lg font-semibold text-gray-900">
          {CAPTURE_SECTION_TITLE}
        </h2>
        <p className="mt-1 text-sm text-gray-500">{CAPTURE_SECTION_INTRO}</p>
      </div>
      {domains.map((view) => (
        <DomainCapture key={view.claimId} view={view} />
      ))}
    </section>
  );
}
