'use client';

/**
 * Add Split Change Modal — BACKLOG-3504.
 *
 * "Change the split" writes a NEW effective-dated row; nothing is edited in
 * place. Dialog shell reused from EditRoleModal.tsx (Modal/ModalFooter/Label),
 * the form itself is new.
 *
 * Agent %/Brokerage % are two linked inputs that always sum to 100 — typing
 * one derives the other client-side — so the DB's
 * `CHECK (agent_pct + brokerage_pct = 100)` is defense-in-depth only and is
 * never hit through this form. Matches the signed-off mock
 * (claude.ai/artifact/671ybYdr3h2kC1S7fHZ5Xz) exactly.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Label, Modal, ModalFooter, Input, Textarea } from '@keepr/design-system';
import { AlertBanner, Button } from '@keepr/ui';
import { addSplitAgreementChange } from '@/lib/actions/addSplitAgreementChange';

interface AddSplitChangeModalProps {
  isOpen: boolean;
  onClose: (shouldRefresh?: boolean) => void;
  memberId: string;
  memberName: string;
  /** Pre-fills the form with the current split so a broker adjusts from it,
   *  rather than starting blank — matches the mock's openAddChange(). */
  currentAgentPct: number;
}

function clampPct(value: string): number {
  const n = Math.round(Number(value));
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

export default function AddSplitChangeModal({
  isOpen,
  onClose,
  memberId,
  memberName,
  currentAgentPct,
}: AddSplitChangeModalProps) {
  const router = useRouter();
  const [agentPct, setAgentPct] = useState(String(currentAgentPct));
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [note, setNote] = useState('');
  const [dateError, setDateError] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const brokeragePct = 100 - clampPct(agentPct);

  const handleAgentChange = (value: string) => {
    setAgentPct(value === '' ? '' : String(clampPct(value)));
  };
  const handleBrokerageChange = (value: string) => {
    setAgentPct(value === '' ? '' : String(100 - clampPct(value)));
  };

  const handleClose = () => {
    setAgentPct(String(currentAgentPct));
    setEffectiveFrom('');
    setNote('');
    setDateError(false);
    setError(null);
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!effectiveFrom) {
      setDateError(true);
      return;
    }
    setDateError(false);
    setIsSubmitting(true);
    setError(null);

    try {
      const result = await addSplitAgreementChange({
        memberId,
        agentPct: clampPct(agentPct),
        effectiveFrom,
        note: note.trim() || undefined,
      });

      if (result.error) {
        setError(result.error);
      } else {
        router.refresh();
        onClose(true);
      }
    } catch {
      setError('An unexpected error occurred');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <Modal
      open={isOpen}
      onClose={handleClose}
      size="sm"
      title={<>Add a change for {memberName}</>}
      dismissible={!isSubmitting}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="flex gap-4">
          <div className="flex-1 min-w-0">
            <Label htmlFor="split-agent-pct">Agent %</Label>
            <Input
              id="split-agent-pct"
              type="number"
              min={0}
              max={100}
              step={1}
              inputMode="numeric"
              value={agentPct}
              onChange={(e) => handleAgentChange(e.target.value)}
            />
          </div>
          <div className="flex-1 min-w-0">
            <Label htmlFor="split-brokerage-pct">Brokerage %</Label>
            <Input
              id="split-brokerage-pct"
              type="number"
              min={0}
              max={100}
              step={1}
              inputMode="numeric"
              value={String(brokeragePct)}
              onChange={(e) => handleBrokerageChange(e.target.value)}
            />
          </div>
        </div>
        <p className="text-xs text-gray-400 -mt-2">
          The two always add to 100% — typing one updates the other.
        </p>

        <div>
          <Label htmlFor="split-effective-from">Effective from</Label>
          <Input
            id="split-effective-from"
            type="date"
            value={effectiveFrom}
            onChange={(e) => {
              setEffectiveFrom(e.target.value);
              if (e.target.value) setDateError(false);
            }}
          />
          {dateError && (
            <p className="mt-1 text-sm text-red-600" role="alert">
              Enter an effective date.
            </p>
          )}
        </div>

        <div>
          <Label htmlFor="split-note">
            Note <span className="font-normal text-gray-400">(optional)</span>
          </Label>
          <Textarea
            id="split-note"
            rows={2}
            placeholder="Why this change is happening"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>

        {error && <AlertBanner variant="destructive">{error}</AlertBanner>}

        <ModalFooter>
          <Button type="button" variant="secondary" onClick={handleClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Saving...' : 'Save'}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
