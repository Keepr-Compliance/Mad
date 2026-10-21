'use client';

/**
 * BrokerageBillingCard - staff deal setup for one brokerage (BACKLOG-3853 PR-2A).
 *
 * Shows the deal (seats, price per seat, start date, billing contact, account manager), the
 * deal state, the Stripe subscription and any suspension. BACKLOG-4007: a new deal waits for
 * customer setup ('draft'); its start date is chosen here and locks once setup is done. Sales and Super Admin set up or edit the deal, and suspend
 * or reinstate the brokerage. The database checks every permission and the Sales cap;
 * this card only mirrors the cap for the readout under the price.
 *
 * BACKLOG-4019: Sales and Super Admin turn the deal's auto-renew off ("Ends <date>" at the
 * Stripe period end) and back on, with a note; set_org_auto_renew checks the permission.
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
  autoRenewAction,
  autoRenewField,
  centsFromDollars,
  checkPrice,
  checkStartDate,
  dealBadge,
  dealErrorMessage,
  formatCents,
  formatDay,
  formatPeriodEnd,
  resolveDealReason,
  startDateEditable,
  subscriptionLine,
  visibleChangeLog,
  type OrgBilling,
} from '@/lib/billing/dealRules';
import { reinstateOrgAction, saveDealAction, setAutoRenewAction, suspendOrgAction } from '@/lib/actions/brokerageBilling';

interface BrokerageBillingCardProps {
  organizationId: string;
  organizationName: string;
  planName: string;
  billing: OrgBilling;
}

const ACTION_LABEL: Record<string, string> = {
  deal_saved: 'Deal saved',
  setup_completed: 'Billing setup completed',
  suspended: 'Suspended',
  reinstated: 'Reinstated',
  auto_renew_off: 'Auto-renew turned off',
  auto_renew_on: 'Auto-renew turned on',
  deal_ended: 'Deal ended',
};

/** BACKLOG-4019: the confirm text for turning auto-renew off. */
export function autoRenewOffBody(billing: OrgBilling): string {
  const date = formatPeriodEnd(billing.stripe?.current_period_end) ?? 'the end of the billing period';
  if (billing.stripe?.status === 'trialing') return `It ends on ${date}, before the first invoice.`;
  return `Billing stops on ${date}. Members keep access until then.`;
}

export function BrokerageBillingCard({ organizationId, organizationName, planName, billing }: BrokerageBillingCardProps) {
  const router = useRouter();
  const deal = billing.deal;
  const [editing, setEditing] = useState(false);
  const [suspending, setSuspending] = useState(false);
  const [reinstating, setReinstating] = useState(false);
  const [renewTarget, setRenewTarget] = useState<'off' | 'on' | null>(null);
  const [logExpanded, setLogExpanded] = useState(false);
  const { visible: visibleLog, hidden: hiddenLog } = visibleChangeLog(billing.log, logExpanded);

  const status = dealBadge(billing);
  const renewAction = autoRenewAction(billing);
  const renewField = autoRenewField(billing);
  const subscription = subscriptionLine(billing);
  const contact = billing.contact;
  const manager = billing.account_managers.find((m) => m.id === deal?.account_manager_id);
  const price = billing.seat_line?.unit_price_cents ?? null;
  const list = billing.list_price_cents;

  const done = () => {
    setEditing(false);
    setSuspending(false);
    setReinstating(false);
    setRenewTarget(null);
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
            {deal?.status === 'draft' ? ' Becomes Active when the broker finishes billing setup.' : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {renewAction === 'off' && (
            <Button variant="secondary" size="sm" onClick={() => setRenewTarget('off')}>Turn off auto-renew</Button>
          )}
          {renewAction === 'on' && (
            <Button variant="secondary" size="sm" onClick={() => setRenewTarget('on')}>Turn auto-renew back on</Button>
          )}
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
          <Field label="Start date" value={formatDay(deal.start_date)} />
          {subscription && <Field label="Stripe subscription" value={subscription.value} help={subscription.help} />}
          {renewField && <Field label="Auto-renew" value={renewField} />}
          <Field
            label="Billing contact"
            value={contact ? contact.name || contact.email : deal.status === 'draft' ? 'Not set yet. The broker sets it in setup.' : 'Not set'}
            help={contact ? [contact.email, contact.phone ?? 'Phone not set', contact.has_login ? 'billing-only login' : null].filter(Boolean).join(' · ') : undefined}
          />
          <Field label="Account manager" value={manager?.name ?? 'Not assigned'} />
          {billing.company?.legal_name && (
            <Field
              label="Company"
              value={billing.company.legal_name}
              help={[billing.company.city, billing.company.region, billing.company.po_number ? `PO ${billing.company.po_number}` : null].filter(Boolean).join(' · ') || undefined}
            />
          )}
          {billing.terms_accepted && (
            <Field label="Terms accepted" value={formatDate(billing.terms_accepted.at)} help={billing.terms_accepted.by ?? undefined} />
          )}
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
      {renewTarget && deal && (
        <ReasonDialog
          title={renewTarget === 'off' ? 'Turn off auto-renew?' : 'Turn auto-renew back on?'}
          body={renewTarget === 'off' ? autoRenewOffBody(billing) : 'Billing continues each month.'}
          cta={renewTarget === 'off' ? 'Turn off auto-renew' : 'Turn auto-renew back on'}
          onClose={() => setRenewTarget(null)}
          onSubmit={(note) => setAutoRenewAction(organizationId, renewTarget === 'on', note, deal.version)}
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
  // BACKLOG-4007 People v2: the billing contact is a brokerage member, set in setup or in
  // People (next to this card); the deal editor has no contact fields.
  const dateEditable = startDateEditable(deal);
  const [startDate, setStartDate] = useState(deal?.start_date ?? billing.business_date);
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
    if (dateEditable) {
      const dateError = checkStartDate(startDate, billing.business_date, deal?.start_date ?? null);
      if (dateError) return setError(dealErrorMessage(dateError));
    }
    const dealReason = resolveDealReason(!!deal, reason);
    if (dealReason == null) return setError('Enter a reason. Every deal change is logged with who and why.');
    setSaving(true);
    const res = await saveDealAction({
      organizationId,
      seats: n,
      unitPriceCents: priceCents,
      accountManagerId: managerId || null,
      reason: dealReason,
      expectedVersion: deal?.version ?? null,
      startDate: dateEditable ? startDate : null,
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
            {dateEditable ? (
              <>
                <Label htmlFor="deal-start-date" required>Start date</Label>
                <Input id="deal-start-date" type="date" min={billing.business_date} value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                <FieldHelp>Today or later. Billing starts on this date or when the broker finishes setup, whichever is later.</FieldHelp>
              </>
            ) : (
              <>
                <Label>Start date</Label>
                <p className="mt-1 text-sm text-gray-900">{formatDay(deal?.start_date)}</p>
                <FieldHelp>Locked after customer setup.</FieldHelp>
              </>
            )}
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
            <Label htmlFor="deal-manager">Account manager</Label>
            <Select id="deal-manager" value={managerId} onChange={(e) => setManagerId(e.target.value)}>
              <option value="">Not assigned</option>
              {billing.account_managers.map((m) => (
                <option key={m.id} value={m.id}>{m.name ?? m.email ?? m.id}</option>
              ))}
            </Select>
          </div>
        </div>
        {deal?.status === 'canceled' && (
          <FieldHelp className="mt-4">Saving restarts this deal with a new subscription. Billing starts today.</FieldHelp>
        )}
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
