'use client';

/**
 * BrokerageBillingCard - staff deal setup for one brokerage (BACKLOG-3853 PR-2A).
 *
 * Shows the deal (seats, price per seat, billing contact, account manager), the Stripe
 * status and any suspension. Sales and Super Admin set up or edit the deal, and suspend
 * or reinstate the brokerage. The database checks every permission and the Sales cap;
 * this card only mirrors the cap for the readout under the price.
 *
 * The page renders it only when brokerage billing is switched on or the organization is
 * a test organization (shouldShowBillingCard).
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Alert,
  Badge,
  Button,
  Card,
  FieldError,
  FieldHelp,
  Input,
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  Select,
  Textarea,
} from '@keepr/design-system';
import { formatDate } from '@/lib/format';
import {
  centsFromDollars,
  checkPrice,
  formatCents,
  resolveDealReason,
  visibleChangeLog,
  type OrgBilling,
} from '@/lib/billing/dealRules';
import { reinstateOrgAction, saveDealAction, suspendOrgAction } from '@/lib/actions/brokerageBilling';

interface BrokerageBillingCardProps {
  organizationId: string;
  organizationName: string;
  planName: string;
  billing: OrgBilling;
}

const STATUS_BADGE: Record<string, { label: string; hue: 'green' | 'red' | 'amber' | 'gray' }> = {
  active: { label: 'Billing active', hue: 'green' },
  suspended: { label: 'Suspended', hue: 'red' },
  canceling: { label: 'Cancel pending', hue: 'amber' },
  canceled: { label: 'Canceled', hue: 'gray' },
  draft: { label: 'Draft', hue: 'gray' },
};

const ACTION_LABEL: Record<string, string> = {
  deal_saved: 'Deal saved',
  suspended: 'Suspended',
  reinstated: 'Reinstated',
};

export function BrokerageBillingCard({ organizationId, organizationName, planName, billing }: BrokerageBillingCardProps) {
  const router = useRouter();
  const deal = billing.deal;
  const [editing, setEditing] = useState(false);
  const [suspending, setSuspending] = useState(false);
  const [reinstating, setReinstating] = useState(false);
  const [logExpanded, setLogExpanded] = useState(false);
  const { visible: visibleLog, hidden: hiddenLog } = visibleChangeLog(billing.log, logExpanded);

  const status = deal ? STATUS_BADGE[deal.status] ?? { label: deal.status, hue: 'gray' as const } : { label: 'No billing set up', hue: 'gray' as const };
  const manager = billing.account_managers.find((m) => m.id === deal?.account_manager_id);
  const price = billing.seat_line?.unit_price_cents ?? null;
  const list = billing.list_price_cents;

  const done = () => {
    setEditing(false);
    setSuspending(false);
    setReinstating(false);
    router.refresh();
  };

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-gray-900">Billing</h2>
            <Badge hue={status.hue}>{status.label}</Badge>
            {billing.stripe?.status === 'past_due' && <Badge hue="red">Invoice overdue</Badge>}
            {billing.is_test && <Badge hue="purple">Test organization</Badge>}
          </div>
          <p className="mt-1 text-sm text-gray-500">
            {deal ? `Stripe invoice, net-15, ${deal.stripe_mode === 'test' ? 'test mode' : 'live mode'}.` : `${organizationName} has a plan but no deal and no invoices.`}
            {billing.stripe?.status ? ` Stripe subscription: ${billing.stripe.status.replace('_', ' ')}.` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {billing.can_suspend && deal && (deal.status === 'active' || deal.status === 'canceling') && (
            <Button variant="dangerOutline" size="sm" onClick={() => setSuspending(true)}>Suspend organization</Button>
          )}
          {billing.can_suspend && deal?.status === 'suspended' && (
            <Button variant="secondary" size="sm" onClick={() => setReinstating(true)}>Reinstate organization</Button>
          )}
          {billing.can_manage && (
            <Button size="sm" onClick={() => setEditing(true)}>{deal ? 'Edit deal' : 'Set up billing'}</Button>
          )}
        </div>
      </div>

      {deal?.status === 'suspended' && (
        <Alert variant="error" className="mt-4">
          {organizationName} is suspended{deal.suspended_at ? ` since ${formatDate(deal.suspended_at)}` : ''}.
          {' '}Reason: {deal.suspended_reason === 'non_payment' ? 'Non-payment' : 'Other'}
          {deal.suspended_note ? ` — ${deal.suspended_note}` : ''}. Exports, submissions, reviews and license changes are off for every member.
        </Alert>
      )}

      {deal && (
        <dl className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-4">
          <Field label="Plan" value={planName} />
          <Field label="Seats bought" value={String(deal.seats)} help={`${billing.assigned_seats} assigned`} />
          <Field
            label="Price per seat"
            value={`${formatCents(price)} / month`}
            help={price != null && list != null ? priceHelp(list, price) : undefined}
          />
          <Field label="Started" value={formatDate(deal.start_date)} />
          <Field label="Billing contact" value={deal.billing_contact_name || deal.billing_contact_email || 'Not set'} help={deal.billing_contact_name ? deal.billing_contact_email ?? undefined : undefined} />
          <Field label="Account manager" value={manager?.name ?? 'Not assigned'} />
        </dl>
      )}

      {billing.log.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-semibold text-gray-900">Change log</h3>
          <ul className="mt-2 divide-y divide-gray-100 text-sm">
            {visibleLog.map((e, i) => (
              <li key={`${e.created_at}-${i}`} className="flex flex-wrap justify-between gap-2 py-2">
                <span className="text-gray-900">
                  {ACTION_LABEL[e.action] ?? e.action}
                  {typeof e.detail?.reason === 'string' ? ` — ${e.detail.reason}` : ''}
                  {typeof e.detail?.note === 'string' && e.detail.note ? ` — ${e.detail.note}` : ''}
                </span>
                <span className="text-gray-500">{e.actor ?? 'System'} · {formatDate(e.created_at)}</span>
              </li>
            ))}
          </ul>
          {(hiddenLog > 0 || logExpanded) && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <p className="text-sm text-gray-500">Showing {visibleLog.length} of {billing.log.length}, newest first</p>
              {hiddenLog > 0 ? (
                <button type="button" onClick={() => setLogExpanded(true)} className="text-sm font-medium text-primary-600 hover:text-primary-800">
                  Show more
                </button>
              ) : (
                <button type="button" onClick={() => setLogExpanded(false)} className="text-sm font-medium text-primary-600 hover:text-primary-800">
                  Show fewer
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {editing && (
        <DealEditor organizationId={organizationId} organizationName={organizationName} planName={planName} billing={billing} onClose={() => setEditing(false)} onSaved={done} />
      )}
      {suspending && (
        <ReasonDialog
          title="Suspend this organization?"
          body={`Every member of ${organizationName} loses exports, submitting, reviews and license changes. Brokers and Admins keep Billing. Invoices keep coming.`}
          cta="Suspend organization"
          withReason
          onClose={() => setSuspending(false)}
          onSubmit={(note, reason) => suspendOrgAction(organizationId, reason ?? 'non_payment', note)}
          onDone={done}
        />
      )}
      {reinstating && (
        <ReasonDialog
          title="Reinstate this organization?"
          body={`${organizationName} gets exports, submitting, reviews and license changes back.`}
          cta="Reinstate organization"
          onClose={() => setReinstating(false)}
          onSubmit={(note) => reinstateOrgAction(organizationId, note)}
          onDone={done}
        />
      )}
    </Card>
  );
}

function priceHelp(list: number, price: number): string {
  if (price === list) return 'List price';
  if (price > list) return `Above list ${formatCents(list)}`;
  const pct = Math.round((10000 * (list - price)) / list) / 100;
  return `${pct}% off list ${formatCents(list)}`;
}

function Field({ label, value, help }: { label: string; value: string; help?: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wider text-gray-500">{label}</dt>
      <dd className="mt-1 text-sm text-gray-900">{value}</dd>
      {help && <dd className="text-xs text-gray-500">{help}</dd>}
    </div>
  );
}

export function DealEditor({
  organizationId,
  organizationName,
  planName,
  billing,
  onClose,
  onSaved,
}: {
  organizationId: string;
  organizationName: string;
  planName: string;
  billing: OrgBilling;
  onClose: () => void;
  onSaved: () => void;
}) {
  const deal = billing.deal;
  const list = billing.list_price_cents;
  // A canceled deal's price is not kept (founder ruling): it is measured against the cap again.
  const current = deal && deal.status !== 'canceled' ? billing.seat_line?.unit_price_cents ?? null : null;
  const currentSeats = deal && deal.status !== 'canceled' ? deal.seats : null;
  const [seats, setSeats] = useState(String(deal?.seats ?? Math.max(billing.assigned_seats, 1)));
  const [priceText, setPriceText] = useState(((current ?? list ?? 0) / 100).toFixed(2));
  const [contactName, setContactName] = useState(deal?.billing_contact_name ?? '');
  const [contactEmail, setContactEmail] = useState(deal?.billing_contact_email ?? '');
  const [managerId, setManagerId] = useState(deal?.account_manager_id ?? '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const priceCents = centsFromDollars(priceText);
  const seatCount = Number(seats);
  const check = useMemo(
    () => (priceCents != null && list
      ? checkPrice({ listCents: list, priceCents, capPct: Number(billing.cap_pct), canApprove: billing.can_approve, currentCents: current, seats: seatCount, currentSeats })
      : null),
    [priceCents, list, billing.cap_pct, billing.can_approve, current, seatCount, currentSeats]
  );

  const submit = async () => {
    setError(null);
    const n = Number(seats);
    if (!Number.isInteger(n) || n < 1) return setError('Enter at least 1 seat.');
    if (priceCents == null) return setError('Enter a price per seat.');
    if (!contactEmail.trim()) return setError('Enter the billing contact email. Invoices are sent there.');
    const dealReason = resolveDealReason(!!deal, reason);
    if (dealReason == null) return setError('Enter a reason. Every deal change is logged with who and why.');
    setSaving(true);
    const res = await saveDealAction({
      organizationId,
      seats: n,
      unitPriceCents: priceCents,
      billingContactName: contactName,
      billingContactEmail: contactEmail,
      accountManagerId: managerId || null,
      reason: dealReason,
      expectedVersion: deal?.version ?? null,
    });
    setSaving(false);
    if (!res.ok) return setError(res.error);
    onSaved();
  };

  return (
    <Modal open onClose={onClose} size="lg" title={deal ? `Edit deal — ${organizationName}` : `Set up billing — ${organizationName}`} dismissible={!saving}>
      <ModalBody>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <Label>Plan</Label>
            <p className="mt-1 text-sm text-gray-900">{planName}</p>
            <FieldHelp>Change the plan in the Plan card.</FieldHelp>
          </div>
          <div>
            <Label>Start date</Label>
            <p className="mt-1 text-sm text-gray-900">{deal ? formatDate(deal.start_date) : 'Today, when you save'}</p>
          </div>
          <div>
            <Label htmlFor="deal-seats" required>Seats</Label>
            <Input id="deal-seats" type="number" min={1} step={1} value={seats} onChange={(e) => setSeats(e.target.value)} />
            <FieldHelp>{billing.assigned_seats} assigned now. Every brokerage user holds a seat.</FieldHelp>
          </div>
          <div>
            <Label htmlFor="deal-price" required>Price per seat, per month</Label>
            <Input id="deal-price" inputMode="decimal" value={priceText} onChange={(e) => setPriceText(e.target.value)} />
            <FieldHelp>{priceReadout(check, list, Number(billing.cap_pct))}</FieldHelp>
          </div>
          <div>
            <Label htmlFor="deal-contact-name">Billing contact name</Label>
            <Input id="deal-contact-name" value={contactName} onChange={(e) => setContactName(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="deal-contact-email" required>Billing contact email</Label>
            <Input id="deal-contact-email" type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} />
            <FieldHelp>Invoices and reminders go here.</FieldHelp>
          </div>
          <div>
            <Label htmlFor="deal-manager">Account manager</Label>
            <Select id="deal-manager" value={managerId} onChange={(e) => setManagerId(e.target.value)}>
              <option value="">Not assigned</option>
              {billing.account_managers.map((m) => (
                <option key={m.id} value={m.id}>{m.name ?? m.email ?? m.id}</option>
              ))}
            </Select>
          </div>
        </div>
        {deal && (
          <div className="mt-4">
            <Label htmlFor="deal-reason" required>Reason</Label>
            <Textarea id="deal-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this deal changing?" />
            <FieldHelp>Saved in the change log with your name.</FieldHelp>
          </div>
        )}
        {error && <FieldError className="mt-3">{error}</FieldError>}
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={submit} disabled={saving || check?.kind === 'needs_approval'}>{saving ? 'Saving…' : 'Save deal'}</Button>
      </ModalFooter>
    </Modal>
  );
}

function priceReadout(check: ReturnType<typeof checkPrice> | null, list: number | null, cap: number): string {
  if (!list) return 'The price book has no seat price.';
  if (!check) return `List price ${formatCents(list)}.`;
  switch (check.kind) {
    case 'at_list': return `At list price ${formatCents(list)}.`;
    case 'above_list': return `Above list price ${formatCents(list)}.`;
    case 'within_cap': return `${check.pct}% off list ${formatCents(list)}. Within the Sales cap of ${cap}%.`;
    case 'kept': return `${check.pct}% off list. Deeper than the Sales cap of ${cap}%, but it is the price already on this deal.`;
    case 'approver': return `${check.pct}% off list. Deeper than the Sales cap of ${cap}%; you can save it as Super Admin.`;
    case 'needs_approval': return `${check.pct}% off list, deeper than the Sales cap of ${cap}%. A Super Admin has to save this price or add seats at it.`;
  }
}

function ReasonDialog({
  title,
  body,
  cta,
  withReason = false,
  onClose,
  onSubmit,
  onDone,
}: {
  title: string;
  body: string;
  cta: string;
  withReason?: boolean;
  onClose: () => void;
  onSubmit: (note: string, reason?: 'non_payment' | 'other') => Promise<{ ok: boolean; error: string | null }>;
  onDone: () => void;
}) {
  const [note, setNote] = useState('');
  const [reason, setReason] = useState<'non_payment' | 'other'>('non_payment');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!note.trim()) return setError('Enter a note. It is saved in the change log.');
    setBusy(true);
    const res = await onSubmit(note, withReason ? reason : undefined);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    onDone();
  };

  return (
    <Modal open onClose={onClose} title={title} dismissible={!busy}>
      <ModalBody>
        <p className="text-sm text-gray-700">{body}</p>
        {withReason && (
          <div className="mt-4">
            <Label htmlFor="suspend-reason" required>Reason</Label>
            <Select id="suspend-reason" value={reason} onChange={(e) => setReason(e.target.value as 'non_payment' | 'other')}>
              <option value="non_payment">Non-payment (lifts by itself when they pay)</option>
              <option value="other">Other (only a reinstate lifts it)</option>
            </Select>
          </div>
        )}
        <div className="mt-4">
          <Label htmlFor="reason-note" required>Note</Label>
          <Textarea id="reason-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        {error && <FieldError className="mt-3">{error}</FieldError>}
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant={withReason ? 'danger' : 'primary'} onClick={submit} disabled={busy}>{busy ? 'Working…' : cta}</Button>
      </ModalFooter>
    </Modal>
  );
}
