'use client';

/**
 * SuspensionAction — support-facing "account suspended (chargeback)" surface
 * (BACKLOG-2077, LAUNCH-RELEVANT).
 *
 * Replaces the disabled "Suspend account" placeholder in BillingCreditsCard.
 *
 * Renders one of two states:
 *   - SUSPENDED: a red banner explaining WHY (dispute id, tx, amount, date) +
 *     a "Reinstate account" action (opens a modal with a REQUIRED reason).
 *   - NOT SUSPENDED: nothing user-actionable (v1 does not add a manual "suspend"
 *     button — suspension is driven by the Stripe chargeback webhook. A manual
 *     suspend lever can be a follow-up ticket).
 *
 * AUTH PATH (critical — mirrors CreditGrantAction / the internal-role portal
 * RPC pattern): the reinstate RPC is guarded by has_internal_role(auth.uid()).
 * We call it through the BROWSER supabase client (cookie session), so auth.uid()
 * resolves to the operator and the guard passes + the action is attributed
 * (acted_by = auth.uid()). We deliberately do NOT use the service-role client —
 * a mutation must be attributable to the acting operator.
 */

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldAlert, AlertTriangle } from 'lucide-react';
import {
  Button,
  Label,
  Textarea,
  FieldError,
  Modal,
} from '@keepr/design-system';
import { createClient } from '@/lib/supabase/client';
import { formatTimestamp } from '@/lib/format';
import { formatCents } from '@/lib/billing-queries';
import {
  validateReinstateReason,
  type SuspensionStatus,
} from '@/lib/suspension-queries';

interface SuspensionActionProps {
  userId: string;
  status: SuspensionStatus;
}

export function SuspensionAction({ userId, status }: SuspensionActionProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const openModal = useCallback(() => {
    setReason('');
    setReasonError(null);
    setSubmitError(null);
    setOpen(true);
  }, []);

  const closeModal = useCallback(() => {
    if (submitting) return; // block dismissal mid-submit
    setOpen(false);
  }, [submitting]);

  const handleReinstate = useCallback(async () => {
    setSubmitError(null);

    const validation = validateReinstateReason(reason);
    if (!validation.ok) {
      setReasonError(validation.error);
      return;
    }
    setReasonError(null);
    setSubmitting(true);

    try {
      // Browser client → authenticated cookie session → auth.uid() flows through
      // the RPC's has_internal_role guard. NOT service-role.
      const supabase = createClient();
      const { error } = await supabase.rpc('reinstate_suspended_account', {
        p_user_id: userId,
        p_reason: validation.reason,
      });

      if (error) {
        setSubmitError(error.message);
        return;
      }

      setOpen(false);
      // Re-fetch the server component so the banner + license status update.
      router.refresh();
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : 'An unexpected error occurred.'
      );
    } finally {
      setSubmitting(false);
    }
  }, [reason, userId, router]);

  // Not suspended: nothing to show here (v1 has no manual suspend lever).
  if (!status.isSuspended) {
    return (
      <p className="mt-3 text-sm text-gray-500">
        Account is not suspended. Suspension is applied automatically on a Stripe
        chargeback.
      </p>
    );
  }

  const event = status.event;

  return (
    <>
      <div className="mt-3 rounded-md border border-danger-200 bg-danger-50 p-4">
        <div className="flex items-start gap-2">
          <ShieldAlert className="h-5 w-5 text-danger-600 mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-danger-700">
              Account suspended
            </p>
            {event ? (
              <div className="mt-1 space-y-0.5 text-xs text-danger-700">
                <p>{event.reason}</p>
                <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                  {event.stripe_dispute_id && (
                    <>
                      <dt className="font-medium">Dispute</dt>
                      <dd>
                        <code className="text-[11px]">
                          {event.stripe_dispute_id}
                        </code>
                      </dd>
                    </>
                  )}
                  {event.local_transaction_id && (
                    <>
                      <dt className="font-medium">Transaction</dt>
                      <dd>
                        <code className="text-[11px]">
                          {event.local_transaction_id}
                        </code>
                      </dd>
                    </>
                  )}
                  {event.amount_cents != null && (
                    <>
                      <dt className="font-medium">Amount</dt>
                      <dd>{formatCents(event.amount_cents)}</dd>
                    </>
                  )}
                  <dt className="font-medium">
                    {event.dispute_created_at ? 'Disputed' : 'Suspended'}
                  </dt>
                  <dd>
                    {formatTimestamp(
                      event.dispute_created_at ?? event.created_at
                    )}
                  </dd>
                </dl>
              </div>
            ) : (
              <p className="mt-1 text-xs text-danger-700">
                No suspension detail on record.
              </p>
            )}

            <div className="mt-3">
              <button
                type="button"
                onClick={openModal}
                className="inline-flex items-center gap-1.5 rounded-md border border-danger-300 bg-white px-3 py-1.5 text-sm font-medium text-danger-700 hover:bg-danger-100 transition-colors"
              >
                Reinstate account
              </button>
            </div>
          </div>
        </div>
      </div>

      <Modal
        open={open}
        onClose={closeModal}
        title="Reinstate account"
        dismissible={!submitting}
      >
        <div className="space-y-4">
          <div className="rounded-md border border-amber-100 bg-amber-50 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
              <p className="text-xs text-amber-700">
                Reinstating lifts the suspension and restores desktop access. Do
                this only once the chargeback is resolved or repaid.
              </p>
            </div>
          </div>

          <div>
            <Label htmlFor="reinstate-reason" required>
              Reason (recorded on the audit log)
            </Label>
            <Textarea
              id="reinstate-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="e.g. Chargeback withdrawn / customer repaid (ticket #123)"
              disabled={submitting}
              aria-invalid={reasonError ? true : undefined}
            />
            {reasonError && <FieldError>{reasonError}</FieldError>}
          </div>

          {submitError && (
            <div className="rounded-md bg-danger-50 border border-danger-200 p-3">
              <p className="text-sm text-danger-700">{submitError}</p>
            </div>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <Button
            type="button"
            variant="secondary"
            onClick={closeModal}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={handleReinstate}
            disabled={submitting}
          >
            {submitting ? 'Reinstating…' : 'Reinstate account'}
          </Button>
        </div>
      </Modal>
    </>
  );
}
