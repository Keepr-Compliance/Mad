'use client';

/**
 * Billing step of the setup guide — BACKLOG-4007 PR-3 (founder de1bdabb, 591d68aa).
 *
 * Shows the order staff set (plan, seats, price per seat, monthly total, billing start; read only),
 * then asks for: company legal name + billing address (+ optional PO number), the billing contact
 * (Me / Someone else; phone required), and agreement to the Terms of Service and this order.
 * No payment method: invoices (net 15) go to the billing contact with Stripe's pay link.
 * Confirm sends the deal version shown; a staff change in between is refused (version_conflict)
 * and the page reloads with the new order.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Card, Checkbox, FieldHelp, Input, Label, Select } from '@keepr/design-system';
import type { BillingSetupView } from '@/lib/billing/setupState';
import { askAboutPrice, completeBillingSetup } from '@/lib/actions/billingSetup';
import { TERMS_URL, formatCents, formatDateOnly } from '@/lib/billing/setupCopy';

export interface BillingStepProps {
  organizationId: string;
  view: BillingSetupView;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 py-1 text-sm">
      <dt className="text-gray-600">{label}</dt>
      <dd className="text-right font-medium text-gray-900">{value}</dd>
    </div>
  );
}

export function BillingStep({ organizationId, view }: BillingStepProps) {
  const router = useRouter();
  const c = view.company;
  const [company, setCompany] = useState({
    legal_name: c?.legal_name ?? '',
    address_line1: c?.address_line1 ?? '',
    address_line2: c?.address_line2 ?? '',
    city: c?.city ?? '',
    region: c?.region ?? '',
    postal_code: c?.postal_code ?? '',
    country: c?.country ?? 'US',
    po_number: c?.po_number ?? '',
  });
  const [who, setWho] = useState<'me' | 'other'>('me');
  const [other, setOther] = useState({ name: '', email: '' });
  const [phone, setPhone] = useState(view.contact?.phone ?? '');
  const [agreed, setAgreed] = useState(false);
  // The order changed (version_conflict -> router.refresh()): consent given to the old order does
  // not carry over. The refusal message stays visible.
  const [seenVersion, setSeenVersion] = useState(view.version);
  if (seenVersion !== view.version) {
    setSeenVersion(view.version);
    setAgreed(false);
  }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState<'idle' | 'sent' | 'failed'>('idle');

  const set = (k: keyof typeof company) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setCompany({ ...company, [k]: e.target.value });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await completeBillingSetup({
      organizationId,
      expectedVersion: view.version,
      acceptTerms: agreed,
      contact: who === 'me' ? { who: 'me', phone } : { who: 'other', name: other.name, email: other.email, phone },
      company,
    });
    if (res.success) {
      router.push('/dashboard/setup');
      router.refresh();
      return;
    }
    setError(res.error);
    setBusy(false);
    if (res.reload) router.refresh();
  };

  const ask = async () => {
    const r = await askAboutPrice(organizationId);
    setAsked(r.success ? 'sent' : 'failed');
  };

  return (
    <form onSubmit={submit} className="space-y-6" aria-label="Billing setup">
      <Card>
        <h2 className="text-lg font-semibold text-gray-900">Your order</h2>
        <dl className="mt-3">
          <Row label="Plan" value={view.plan_name ?? '—'} />
          <Row label="Seats" value={String(view.seats)} />
          <Row label="Price per seat" value={`${formatCents(view.unit_price_cents)} / month`} />
          <Row label="Monthly total" value={formatCents(view.monthly_total_cents)} />
          <Row label="Billing starts" value={formatDateOnly(view.billing_starts_on)} />
        </dl>
        <p className="mt-3 text-sm text-gray-600">
          Invoices are due in 15 days.
        </p>
        <div className="mt-3 text-sm">
          {asked === 'sent' ? (
            <span className="text-gray-700">
              {view.account_manager ?? 'Your account manager'} will contact you. You can still confirm now or come back later.
            </span>
          ) : (
            <button type="button" onClick={ask} className="text-primary-600 hover:text-primary-700">
              Question about this price?
            </button>
          )}
          {asked === 'failed' ? <span className="ml-2 text-red-600">Could not send. Please try again.</span> : null}
        </div>
      </Card>

      <Card>
        <h2 className="text-lg font-semibold text-gray-900">Company details</h2>
        <p className="mt-1 text-sm text-gray-600">Shown on your invoices.</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label htmlFor="bs-legal" required>Legal company name</Label>
            <Input id="bs-legal" value={company.legal_name} onChange={set('legal_name')} required />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="bs-line1" required>Address</Label>
            <Input id="bs-line1" value={company.address_line1} onChange={set('address_line1')} required />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="bs-line2">Address line 2</Label>
            <Input id="bs-line2" value={company.address_line2} onChange={set('address_line2')} />
          </div>
          <div>
            <Label htmlFor="bs-city" required>City</Label>
            <Input id="bs-city" value={company.city} onChange={set('city')} required />
          </div>
          <div>
            <Label htmlFor="bs-region" required={company.country === 'US'}>State</Label>
            <Input id="bs-region" value={company.region} onChange={set('region')} required={company.country === 'US'} />
          </div>
          <div>
            <Label htmlFor="bs-postal" required>ZIP code</Label>
            <Input id="bs-postal" value={company.postal_code} onChange={set('postal_code')} required />
          </div>
          <div>
            <Label htmlFor="bs-country" required>Country</Label>
            <Select id="bs-country" value={company.country} onChange={set('country')}>
              <option value="US">United States</option>
              <option value="CA">Canada</option>
            </Select>
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="bs-po">PO number</Label>
            <Input id="bs-po" value={company.po_number} onChange={set('po_number')} />
            <FieldHelp>Optional. Printed on every invoice.</FieldHelp>
          </div>
        </div>
      </Card>

      <Card>
        <h2 className="text-lg font-semibold text-gray-900">Billing contact</h2>
        <p className="mt-1 text-sm text-gray-600">Invoices are emailed here with a link to pay. No login is needed.</p>
        <fieldset className="mt-4 space-y-2">
          <legend className="sr-only">Who receives invoices</legend>
          <label className="flex items-center gap-2 text-sm text-gray-900">
            <input type="radio" className="h-4 w-4 border-gray-300 bg-white text-primary-600 focus:ring-primary-500" name="bs-who" checked={who === 'me'} onChange={() => setWho('me')} />
            Me{view.me ? ` (${view.me.email})` : ''}
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-900">
            <input type="radio" className="h-4 w-4 border-gray-300 bg-white text-primary-600 focus:ring-primary-500" name="bs-who" checked={who === 'other'} onChange={() => setWho('other')} />
            Someone else
          </label>
        </fieldset>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {who === 'other' ? (
            <>
              <div>
                <Label htmlFor="bs-cname" required>Name</Label>
                <Input id="bs-cname" value={other.name} onChange={(e) => setOther({ ...other, name: e.target.value })} required />
              </div>
              <div>
                <Label htmlFor="bs-cemail" required>Email</Label>
                <Input
                  id="bs-cemail"
                  type="email"
                  value={other.email}
                  onChange={(e) => setOther({ ...other, email: e.target.value })}
                  required
                />
              </div>
            </>
          ) : null}
          <div>
            <Label htmlFor="bs-phone" required>Phone</Label>
            <Input id="bs-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} required />
          </div>
        </div>
      </Card>

      <Card>
        <label className="flex items-start gap-2 text-sm text-gray-700">
          <Checkbox id="bs-terms" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          <span>
            I agree to the{' '}
            <a href={TERMS_URL} target="_blank" rel="noreferrer" className="text-primary-600 hover:text-primary-700">
              Terms of Service
            </a>{' '}
            and this order.
          </span>
        </label>
        {error ? (
          <Alert variant="error" className="mt-4">
            {error}
          </Alert>
        ) : null}
        <div className="mt-6">
          <Button type="submit" disabled={busy || !agreed}>
            {busy ? 'Confirming…' : 'Confirm and finish billing setup'}
          </Button>
        </div>
      </Card>
    </form>
  );
}
