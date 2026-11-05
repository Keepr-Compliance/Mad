/**
 * BACKLOG-4139 / BACKLOG-4140: class contract for the Billing page on phones and tablets.
 *
 * Below lg (1024 px) both invoice tables stack into rows and every billing action is at least
 * 44 px; from lg up nothing changes. jsdom has no layout, so this checks the classes that do it;
 * scripts/billing-phone-4139 measures the real CSS in Chromium. Breakpoint is lg, not md: at 768
 * the md sidebar leaves a 414 px column and the tables still hide Pay and View.
 */
import { render, fireEvent, within } from '@testing-library/react';
import React from 'react';

jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: jest.fn(), push: jest.fn() }) }));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
jest.mock('@/lib/actions/billingPortal', () => ({ openBrokerageBillingPortal: jest.fn() }));
jest.mock('@/lib/actions/seats', () => ({ addSeats: jest.fn() }));
jest.mock('@/lib/actions/autoRenew', () => ({ setAutoRenew: jest.fn() }));
jest.mock('@/lib/actions/agentPlan', () => ({}));
jest.mock('@/lib/actions/billingCard', () => ({}));

import { ManageBillingBlock } from '@/components/billing/ManageBillingBlock';
import { InvoicesBlock } from '@/components/billing/InvoicesBlock';
import { SeatsBlock } from '@/components/billing/SeatsBlock';
import { AutoRenewBlock } from '@/components/billing/AutoRenewBlock';
import { PlanBlock } from '@/components/billing/PlanBlock';
import { PaymentContactBlock } from '@/components/billing/PaymentContactBlock';
import { ChoosePlanBlock } from '@/components/billing/ChoosePlanBlock';
import type { PersonalPlanData } from '@/components/billing/BillingPage';
import type { OrgInvoiceRow } from '@/lib/billing/orgInvoices';
import type { BillingRow, PersonalBillingData } from '@/lib/billing/personalBilling';
import type { SeatsView } from '@/lib/billing/seats';

const tok = (el: Element) => (el.getAttribute('class') || '').split(/\s+/);
const LINK = ['max-lg:inline-flex', 'max-lg:min-h-11', 'max-lg:min-w-11'];
const BTN = ['max-lg:min-h-11'];
/** 44 px below lg only: the max-lg tokens are present and no width-independent minimum is. */
const touch = (el: Element, want: string[]) => {
  for (const w of want) expect(tok(el)).toContain(w);
  expect(tok(el)).not.toContain('min-h-11');
  expect(tok(el)).not.toContain('min-h-[44px]');
};
const stacksBelowLg = (table: HTMLTableElement, rowSelector: string) => {
  expect(table.outerHTML).not.toMatch(/max-(sm|md):/);
  expect(tok(table.querySelector('thead')!)).toContain('max-lg:hidden');
  const rows = table.querySelectorAll(rowSelector);
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) expect(tok(r)).toContain('max-lg:grid');
};

const U = 'https://invoice.stripe.test/REDACTED/fixture';
const ORG = [
  { number: 'FIXTURE-0002', created: 1793000000, amountCents: 9996, currency: 'usd', status: 'due', pdfUrl: U, payUrl: U },
  { number: 'FIXTURE-0001', created: 1792000000, amountCents: 0, currency: 'usd', status: 'paid', pdfUrl: U, payUrl: null },
] as OrgInvoiceRow[];
const SOLO: BillingRow[] = [
  { id: 'in_FIXTURE0001', created: 1793000000, description: 'Agent plan', amountCents: 1999, currency: 'usd', status: 'paid', link: U, linkLabel: 'View' },
] as BillingRow[];
const PRICES = { month: { id: 'price_FIXTURE_month', display: '$19.99' } };
const PLAN = (state: PersonalPlanData['state'], extra: Partial<PersonalPlanData> = {}): PersonalPlanData => ({
  state,
  interval: 'month',
  currentPeriodEnd: '2026-12-04T12:00:00+00:00',
  supportGrantEffective: false,
  prices: PRICES,
  checkout: null,
  sessionId: null,
  ...extra,
});
const BILLING: PersonalBillingData = {
  credits: 0,
  customer: 'present',
  card: { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 },
  contact: { name: null, email: 'agent@example.test' },
  rows: SOLO,
  failedInvoice: null,
};

describe('BACKLOG-4139/4140 billing page below lg', () => {
  it('brokerage invoices stack below lg (not md); Pay, Download PDF, View all, guide link are 44 below lg only', () => {
    const { container, getByText } = render(<ManageBillingBlock invoices={ORG} />);
    stacksBelowLg(container.querySelector('table')!, 'tr[data-org-invoice-row]');
    const actions = container.querySelectorAll('a[data-billing-action], button[data-billing-action]');
    // Download PDF x2, Pay x1, View all invoices x1
    expect(actions.length).toBe(4);
    for (const a of actions) touch(a, LINK);
    touch(getByText('Where do I find my invoices?'), LINK);
    touch(getByText(/Manage billing/), BTN);
  });

  it('solo receipts stack below lg (not md); View is 44 below lg only', () => {
    const { container, getByText } = render(<InvoicesBlock data={{ rows: SOLO, state: 'active' }} />);
    stacksBelowLg(container.querySelector('table')!, 'tr[data-billing-row]');
    touch(getByText('View'), LINK);
  });

  it('seats, Add seats modal and auto-renew buttons are 44 below lg only', () => {
    const v = { free: 2, bought: 3, inUse: 1, canAdd: true, version: 2, trialing: true, unlimited: false, unitPriceCents: 2499, reason: null, accountManagerEmail: null } as unknown as SeatsView;
    const s = render(<SeatsBlock view={v} viewer="admin" />);
    touch(s.getByText('Add seats', { selector: 'button' }), BTN);
    fireEvent.click(s.getByText('Add seats', { selector: 'button' }));
    const dlg = s.getByRole('dialog');
    touch(within(dlg).getByText('Cancel'), BTN);
    touch(within(dlg).getByText('Confirm'), BTN);
    touch(dlg.querySelector('input#add-seats-count')!, BTN);
    const pe = { state: 'renewing', endsOn: null, periodEnd: '2026-11-30T19:00:00+00:00', canChange: true, version: 3 } as const;
    const a = render(<AutoRenewBlock organizationId="00000000-0000-0000-0000-000000000000" planEnd={pe} />);
    touch(a.getByText('Turn off auto-renew'), BTN);
    const pe2 = { ...pe, state: 'ending', endsOn: '2026-11-30T19:00:00+00:00' } as const;
    const b = render(<AutoRenewBlock organizationId="00000000-0000-0000-0000-000000000000" planEnd={pe2} />);
    touch(b.getByText('Turn auto-renew back on'), BTN);
  });

  it('solo plan buttons (Update card, Edit contact, Subscribe, Book a Call, Cancel plan, End plan now) are 44 below lg only', () => {
    const pay = render(<PaymentContactBlock data={{ billing: BILLING, state: 'active', interval: 'month', suspended: false, canUpdateCard: true }} />);
    touch(pay.getByText('Update card', { selector: 'button' }), BTN);
    touch(pay.getByText('Edit contact', { selector: 'button' }), BTN);
    const choose = render(<ChoosePlanBlock prices={PRICES} />);
    touch(choose.getByText(/^Subscribe/, { selector: 'button' }), BTN);
    touch(choose.getByText('Book a Call', { selector: 'a' }), BTN);
    const active = render(<PlanBlock line="" personal={PLAN('active')} />);
    for (const b of active.container.querySelectorAll('button')) touch(b, BTN);
    expect(active.container.querySelectorAll('button').length).toBeGreaterThan(0);
    const failed = render(<PlanBlock line="" personal={PLAN('payment_failed', { canEndPlanNow: true })} />);
    touch(failed.getByText('End plan now', { selector: 'button' }), BTN);
  });
});
