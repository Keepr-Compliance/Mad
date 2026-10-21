'use client';

/**
 * Seats on the organization Billing page — BACKLOG-3854.
 *
 * Three numbers from public.broker_get_seats (lib/billing/seats.ts): bought, in use, free. "Add
 * seats" shows only when the database says this person may add now (can_add: an active Broker or
 * Admin, a live deal, no overdue invoice, not ending). It opens a design-system Modal (pattern of
 * components/users/UnassignLicenseModal.tsx) with a number field; Confirm calls the addSeats
 * server action with how many to ADD and the deal version the page read. Copy: at most two
 * sentences per line (founder: less is better).
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, FieldError, Input, Label, Modal, ModalFooter, StatCard } from '@keepr/design-system';
import { BillingBlock } from './BillingBlock';
import { addSeats } from '@/lib/actions/seats';
import { formatSeatPrice, type SeatsView } from '@/lib/billing/seats';

export type SeatsViewer = 'broker' | 'admin' | 'it_admin' | 'billing_contact';

export const SALES_EMAIL = 'sales@keeprcompliance.com';

/** The one line shown instead of the button, or null. */
export function cannotAddLine(view: SeatsView, viewer: SeatsViewer): string | null {
  if (view.canAdd) return null;
  if (viewer === 'it_admin') return 'Ask a Broker or Admin to add seats.';
  if (viewer === 'billing_contact') return null;
  switch (view.reason) {
    case 'invoice_overdue':
      return 'Pay the overdue invoice to add seats.';
    case 'deal_canceling':
      // SR change 5: only an Admin (or the billing contact) may turn auto-renew back on.
      return viewer === 'admin'
        ? 'Your plan is ending. Turn auto-renew back on to add seats.'
        : 'Your plan is ending. An Admin can turn auto-renew back on.';
    default:
      // suspended: the banner says it; draft / not live: "Managed by Keepr"; ended: the plan line.
      return null;
  }
}

/** The confirm dialog's line: the totals, then what it costs. */
export function addSeatsLine(view: SeatsView, add: number): string {
  const now = view.bought ?? 0;
  const totals = `You have ${now} seats. After this: ${now + add}.`;
  if (view.trialing) return `${totals} The new seats are billed from the end of your trial.`;
  const price = formatSeatPrice(view.unitPriceCents);
  return price
    ? `${totals} A prorated charge for the rest of this period appears on your next invoice (${price} per seat per month).`
    : `${totals} A prorated charge for the rest of this period appears on your next invoice.`;
}

export function fewerSeatsLine(view: SeatsView): string {
  return `Fewer seats? Email ${view.accountManagerEmail ?? SALES_EMAIL}.`;
}

export function SeatsBlock({ view, viewer }: { view: SeatsView | null; viewer: SeatsViewer | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState('1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!view || !viewer) {
    return (
      <BillingBlock id="seats" title="Seats & licenses">
        <p className="mt-2 text-sm text-gray-700">Seat counts are unavailable right now.</p>
      </BillingBlock>
    );
  }

  const add = Number(count);
  const valid = Number.isInteger(add) && add >= 1 && add <= 10000;
  const close = () => {
    if (busy) return;
    setOpen(false);
    setError(null);
    setCount('1');
  };
  const confirm = async () => {
    if (!valid || view.version === null) return;
    setBusy(true);
    setError(null);
    try {
      const res = await addSeats(add, view.version);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setOpen(false);
      setCount('1');
      router.refresh();
    } catch {
      setError('Something went wrong. No seats were added.');
    } finally {
      setBusy(false);
    }
  };
  const line = cannotAddLine(view, viewer);

  return (
    <BillingBlock id="seats" title="Seats & licenses">
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3" data-seats-counts="">
        {view.unlimited ? (
          <StatCard label="Seats" value="No seat limit" hue="gray" />
        ) : (
          <StatCard label="Seats" value={view.bought ?? 0} hue="gray" />
        )}
        <StatCard label="In use" value={view.inUse} hue="gray" />
        {view.unlimited ? null : <StatCard label="Available" value={view.free ?? 0} hue="gray" />}
      </div>
      {view.canAdd && view.version !== null ? (
        <div className="mt-4">
          <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
            Add seats
          </Button>
        </div>
      ) : null}
      {line ? (
        <p className="mt-4 text-sm text-gray-700" data-seats-line="">
          {line}
        </p>
      ) : null}
      {viewer !== 'it_admin' ? <p className="mt-2 text-sm text-gray-500">{fewerSeatsLine(view)}</p> : null}
      <Modal open={open} onClose={close} size="sm" title="Add seats" dismissible={!busy}>
        <Label htmlFor="add-seats-count">Seats to add</Label>
        <Input
          id="add-seats-count"
          type="number"
          inputMode="numeric"
          min={1}
          max={10000}
          step={1}
          value={count}
          onChange={(e) => setCount(e.target.value)}
          disabled={busy}
        />
        {valid ? <p className="mt-3 text-sm text-gray-600">{addSeatsLine(view, add)}</p> : null}
        {error ? (
          <FieldError className="mt-3">
            <span role="alert">{error}</span>
          </FieldError>
        ) : null}
        <ModalFooter>
          <Button type="button" variant="secondary" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" variant="primary" onClick={confirm} disabled={busy || !valid}>
            {busy ? 'Adding…' : 'Confirm'}
          </Button>
        </ModalFooter>
      </Modal>
    </BillingBlock>
  );
}
