/**
 * BACKLOG-4139/4140 billing phone-width harness: markup dumps (NOT a CI test).
 * Renders the real billing components in jsdom inside the dashboard frame (DashboardShell
 * outer flex + content column + <main> classes (DashboardShell.tsx:81,107,117), BillingPage wrapper, a w-64 stand-in for the md+ sidebar) and writes
 * $DUMP_DIR/<name>.html. run.sh compiles the real Tailwind for each and check.cjs measures it.
 * Rows are transcribed from the keepr-test billing page (2026-11-04, int-portal/billing 9616fe488):
 * dates, amounts, status and which links a row carries; link URLs are replaced.
 */
import { render, fireEvent, within } from '@testing-library/react';
import { writeFileSync } from 'fs';
import { join } from 'path';
import React from 'react';
import type { OrgInvoiceRow } from '@/lib/billing/orgInvoices';
import type { BillingRow } from '@/lib/billing/personalBilling';
import type { SeatsView } from '@/lib/billing/seats';
import type { PlanEnd } from '@/lib/billing/planEnd';

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
import type { PersonalBillingData } from '@/lib/billing/personalBilling';

const day = (iso: string) => Date.parse(iso) / 1000;
const PDF = 'https://invoice.stripe.test/REDACTED/fixture.pdf';
const PAY = 'https://invoice.stripe.test/REDACTED/fixture';
// Brokerage admin page: one Due row (PDF + Pay), one Paid row (PDF only).
const ORG_DUE: OrgInvoiceRow[] = [
  { number: 'FIXTURE-0002', created: day('2026-10-30T12:00:00Z'), amountCents: 9996, currency: 'usd', status: 'due', pdfUrl: PDF, payUrl: PAY },
  { number: 'FIXTURE-0001', created: day('2026-10-20T12:00:00Z'), amountCents: 0, currency: 'usd', status: 'paid', pdfUrl: PDF, payUrl: null },
] as OrgInvoiceRow[];
// Solo Agent plan: one Paid row with View.
const SOLO: BillingRow[] = [
  { id: 'in_FIXTURE0001', created: day('2026-11-04T12:00:00Z'), description: 'Agent plan · Nov 4 – Dec 4', amountCents: 1999, currency: 'usd', status: 'paid', link: PAY, linkLabel: 'View' },
];
const SEATS = { free: 2, bought: 3, inUse: 1, canAdd: true, version: 2, trialing: true, unlimited: false, unitPriceCents: 2499, reason: null, accountManagerEmail: null } as unknown as SeatsView;
const PE = (state: PlanEnd['state']): PlanEnd => ({ state, endsOn: state === 'ending' ? '2026-11-30T19:00:00+00:00' : null, periodEnd: '2026-11-30T19:00:00+00:00', canChange: true, version: 3 });

// Solo plan blocks (PM decision on BACKLOG-4140: the solo plan-block buttons are in scope). Prop shapes are
// PersonalPlanData / PersonalBillingData (components/billing/BillingPage.tsx:35, lib/billing/personalBilling.ts:77);
// price is the live Agent monthly price shown on the solo receipt above; card is Stripe's public test card.
const PRICES = { month: { id: 'price_FIXTURE_month', display: '$19.99' } };
const PLAN = (state: PersonalPlanData['state'], extra: Partial<PersonalPlanData> = {}): PersonalPlanData => ({
  state, interval: 'month', currentPeriodEnd: '2026-12-04T12:00:00+00:00', supportGrantEffective: false,
  prices: PRICES, checkout: null, sessionId: null, ...extra,
});
const BILLING: PersonalBillingData = {
  credits: 0, customer: 'present', card: { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 },
  contact: { name: null, email: 'agent@example.test' }, rows: SOLO, failedInvoice: null,
};

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div className="flex min-h-screen">
    <aside className="hidden w-64 shrink-0 md:block" data-sidebar-standin="" />
    <div className="flex-1 flex flex-col min-w-0">
      <main className="flex-1 p-4 md:p-6 bg-gray-50 overflow-auto">
        <div className="mx-auto max-w-4xl space-y-6">{children}</div>
      </main>
    </div>
  </div>
);

const dump = (name: string, html: string) => writeFileSync(join(process.env.DUMP_DIR as string, `${name}.html`), html);

describe('billing phone dumps', () => {
  it('org-due', () => {
    const { container } = render(<Frame><ManageBillingBlock invoices={ORG_DUE} /></Frame>);
    dump('org-due', container.innerHTML);
  });
  it('solo-receipts', () => {
    const { container } = render(<Frame><InvoicesBlock data={{ rows: SOLO, state: 'active' as never }} /></Frame>);
    dump('solo-receipts', container.innerHTML);
  });
  it('seats-modal', () => {
    const { container, getByText } = render(<Frame><SeatsBlock view={SEATS} viewer="admin" /></Frame>);
    dump('seats', container.innerHTML);
    fireEvent.click(getByText('Add seats'));
    dump('seats-modal', container.innerHTML);
  });
  it('solo plan blocks', () => {
    dump('solo-plan-active', render(<Frame><PlanBlock line="" personal={PLAN('active')} /></Frame>).container.innerHTML);
    dump('solo-plan-failed', render(<Frame><PlanBlock line="" personal={PLAN('payment_failed', { canEndPlanNow: true })} /></Frame>).container.innerHTML);
    dump('solo-payment', render(<Frame><PaymentContactBlock data={{ billing: BILLING, state: 'active', interval: 'month', suspended: false, canUpdateCard: true }} /></Frame>).container.innerHTML);
    dump('solo-choose', render(<Frame><ChoosePlanBlock prices={PRICES} /></Frame>).container.innerHTML);
  });
  it('auto-renew', () => {
    dump('autorenew-on', render(<Frame><AutoRenewBlock organizationId="00000000-0000-0000-0000-000000000000" planEnd={PE('renewing')} /></Frame>).container.innerHTML);
    const on = render(<Frame><AutoRenewBlock organizationId="00000000-0000-0000-0000-000000000000" planEnd={PE('renewing')} /></Frame>);
    fireEvent.click(within(on.container).getByText('Turn off auto-renew'));
    dump('autorenew-confirm', on.container.innerHTML);
    dump('autorenew-ending', render(<Frame><AutoRenewBlock organizationId="00000000-0000-0000-0000-000000000000" planEnd={PE('ending')} /></Frame>).container.innerHTML);
  });
});
