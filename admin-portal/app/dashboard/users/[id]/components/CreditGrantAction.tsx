'use client';

/**
 * CreditGrantAction — support-facing "Grant / claw back credits" flow
 * (BACKLOG-2016, LAUNCH-REQUIRED).
 *
 * Replaces the disabled "Grant credits" placeholder in BillingCreditsCard.
 * Opens a modal to grant N (or claw back N) credits to the viewed user with a
 * REQUIRED reason, then calls the `admin_adjust_credits` RPC.
 *
 * AUTH PATH (critical — see task SR gate):
 *   The RPC is guarded by `has_internal_role(auth.uid())`. We call it through
 *   the BROWSER supabase client (`@/lib/supabase/client`), which carries the
 *   authenticated internal-user COOKIE session, so `auth.uid()` resolves to the
 *   operator and the guard passes. We deliberately do NOT use the service-role
 *   client here — service-role is only for RLS-bypassing cross-user READS in
 *   getBillingData; a mutation must be attributable to the acting operator
 *   (the RPC stamps `created_by = auth.uid()` on the ledger row + admin log).
 *   This mirrors RoleManagement.tsx / DevicesTable.tsx (the established
 *   internal-role portal RPC pattern).
 *
 * Founder rule surfaced in the UI: grant-funded credits do NOT advance the
 * user's PAYG tier ladder (only paid unlocks count toward tier discounts).
 */

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Gift, Info } from 'lucide-react';
import {
  Button,
  Label,
  Input,
  Textarea,
  FieldError,
  Modal,
} from '@keepr/design-system';
import { createClient } from '@/lib/supabase/client';
import {
  validateGrantInput,
  directionVerb,
  type GrantDirection,
} from '@/lib/credit-grant';

interface CreditGrantActionProps {
  userId: string;
  /** Current credit balance, shown for context in the modal. */
  currentBalance: number;
}

export function CreditGrantAction({ userId, currentBalance }: CreditGrantActionProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState<GrantDirection>('grant');
  const [amountRaw, setAmountRaw] = useState('');
  const [reason, setReason] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ amount?: string; reason?: string }>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const openModal = useCallback((dir: GrantDirection) => {
    setDirection(dir);
    setAmountRaw('');
    setReason('');
    setFieldErrors({});
    setSubmitError(null);
    setOpen(true);
  }, []);

  const closeModal = useCallback(() => {
    if (submitting) return; // block dismissal mid-submit
    setOpen(false);
  }, [submitting]);

  const handleSubmit = useCallback(async () => {
    setSubmitError(null);

    const validation = validateGrantInput({ amountRaw, reason, direction });
    if (!validation.ok) {
      setFieldErrors(validation.errors);
      return;
    }
    setFieldErrors({});
    setSubmitting(true);

    try {
      // Browser client → authenticated cookie session → auth.uid() flows
      // through the RPC's has_internal_role guard. NOT service-role.
      const supabase = createClient();
      const { error } = await supabase.rpc('admin_adjust_credits', {
        p_user_id: userId,
        p_amount: validation.amount,
        p_reason: validation.reason,
        p_metadata: { source: 'admin-portal', surface: 'user-detail-billing' },
      });

      if (error) {
        setSubmitError(error.message);
        return;
      }

      setOpen(false);
      // Re-fetch the server component so the balance + ledger reflect the
      // new append-only adjustment row.
      router.refresh();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'An unexpected error occurred.');
    } finally {
      setSubmitting(false);
    }
  }, [amountRaw, reason, direction, userId, router]);

  const verb = directionVerb(direction);
  const isClawback = direction === 'clawback';

  return (
    <>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => openModal('grant')}
          className="inline-flex items-center gap-1.5 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-sm font-medium text-indigo-700 hover:bg-indigo-100 transition-colors"
        >
          <Gift className="h-4 w-4" />
          Grant credits
        </button>
        <button
          type="button"
          onClick={() => openModal('clawback')}
          className="inline-flex items-center gap-1.5 rounded-md border border-orange-200 bg-orange-50 px-3 py-1.5 text-sm font-medium text-orange-700 hover:bg-orange-100 transition-colors"
        >
          Claw back credits
        </button>
      </div>

      <Modal
        open={open}
        onClose={closeModal}
        title={`${verb} credits`}
        dismissible={!submitting}
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Current balance:{' '}
            <span className="font-medium text-gray-900">{currentBalance}</span> credits
          </p>

          {/* Founder rule — grants never advance the tier ladder. */}
          <div className="rounded-md border border-blue-100 bg-blue-50 p-3">
            <div className="flex items-start gap-2">
              <Info className="h-4 w-4 text-blue-500 mt-0.5 shrink-0" />
              <p className="text-xs text-blue-700">
                Grant-funded credits do <span className="font-semibold">not</span> advance
                the user&rsquo;s PAYG tier ladder. Only paid unlocks count toward tier
                discounts.
              </p>
            </div>
          </div>

          <div>
            <Label htmlFor="grant-amount" required>
              Amount ({isClawback ? 'credits to remove' : 'credits to add'})
            </Label>
            <Input
              id="grant-amount"
              type="number"
              min={1}
              inputMode="numeric"
              value={amountRaw}
              onChange={(e) => setAmountRaw(e.target.value)}
              placeholder="e.g. 5"
              disabled={submitting}
              aria-invalid={fieldErrors.amount ? true : undefined}
            />
            {fieldErrors.amount && <FieldError>{fieldErrors.amount}</FieldError>}
          </div>

          <div>
            <Label htmlFor="grant-reason" required>
              Reason (recorded on the audit ledger)
            </Label>
            <Textarea
              id="grant-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="e.g. Goodwill credit for onboarding issue (ticket #123)"
              disabled={submitting}
              aria-invalid={fieldErrors.reason ? true : undefined}
            />
            {fieldErrors.reason && <FieldError>{fieldErrors.reason}</FieldError>}
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
            variant={isClawback ? 'danger' : 'primary'}
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? `${verb}ing…` : `${verb} credits`}
          </Button>
        </div>
      </Modal>
    </>
  );
}
