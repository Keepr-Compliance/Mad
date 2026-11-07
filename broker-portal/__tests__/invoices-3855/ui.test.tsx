/**
 * The invoices UI inside "Invoices & payment method" — BACKLOG-3855 (plan C8; SR C6, C9), BACKLOG-4187.
 */

const mockOpenPortal = jest.fn();
jest.mock('@/lib/actions/billingPortal', () => ({ openBrokerageBillingPortal: (...a: unknown[]) => mockOpenPortal(...a) }));

import { act, fireEvent, render, within } from '@testing-library/react';
import { ManageBillingBlock } from '@/components/billing/ManageBillingBlock';
import { ORG_INVOICES_LIMIT, type OrgInvoiceRow } from '@/lib/billing/orgInvoices';

const ROW: OrgInvoiceRow = {
  number: 'A9SLAZ3T-0001',
  created: 1793458800,
  amountCents: 12495,
  currency: 'usd',
  status: 'overdue',
  pdfUrl: 'https://invoice.stripe.test/REDACTED/fixture.pdf',
  payUrl: 'https://invoice.stripe.test/REDACTED/fixture',
};

beforeEach(() => mockOpenPortal.mockReset().mockResolvedValue(undefined));

const header = (c: HTMLElement) => c.querySelector('[data-billing-block="manage-billing"] > [data-billing-header]') as HTMLElement | null;

describe('BACKLOG-4187: Manage billing on the title line; no View all invoices', () => {
  it('Manage billing is the header action, next to the title; it calls the portal action with no arguments', async () => {
    const { container } = render(<ManageBillingBlock invoices={[ROW]} />);
    const h = header(container)!;
    expect(h).not.toBeNull();
    expect(h.querySelector('h2')?.textContent).toBe('Invoices & payment method');
    const btn = within(h).getByRole('button', { name: 'Manage billing' });
    expect(within(container).getAllByRole('button', { name: 'Manage billing' })).toEqual([btn]);
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(mockOpenPortal.mock.calls).toEqual([[]]);
  });

  it.each([
    ['rows', [ROW]],
    ['no rows', []],
    ['unavailable', null],
    ['no list passed', undefined],
  ] as const)('%s: no View all invoices control and no help-article link on the Billing page', (_n, invoices) => {
    const { container } = render(<ManageBillingBlock invoices={invoices as OrgInvoiceRow[] | null | undefined} />);
    expect(container.querySelector('[data-billing-action="view_all_invoices"]')).toBeNull();
    expect(container.textContent).not.toContain('View all invoices');
    expect(container.querySelector('a[href="/guides/invoices"]')).toBeNull();
    expect(container.textContent).not.toContain('Where do I find my invoices?');
    expect(within(header(container)!).getByRole('button', { name: 'Manage billing' })).toBeTruthy();
  });

  it('with rows: the sentence under the title is exactly the last-5 line, and 5 is the list cap', () => {
    const { container } = render(<ManageBillingBlock invoices={[ROW]} />);
    expect(ORG_INVOICES_LIMIT).toBe(5);
    const line = container.querySelector('[data-manage-billing-line]')!;
    expect(line.textContent).toBe('Showing your last 5 invoices. Click Manage billing to see all of them or change your payment method.');
    // directly after the header, before the table
    expect(header(container)!.nextElementSibling).toBe(line);
  });

  it('no list passed: no rows, the plain Manage billing line', () => {
    const { container } = render(<ManageBillingBlock />);
    expect(container.querySelector('[data-org-invoice-row]')).toBeNull();
    expect(container.querySelector('[data-manage-billing-line]')?.textContent).toBe(
      "Save a payment method and see every invoice on Stripe's billing page.",
    );
  });
});

describe('SR C6: an unavailable list keeps Manage billing', () => {
  it('null rows -> the unavailable line and Manage billing; no last-5 line', () => {
    const { container } = render(<ManageBillingBlock invoices={null} />);
    expect(container.textContent).toContain('Your invoices are unavailable right now.');
    expect(container.textContent).not.toContain('Showing your last');
    expect(within(container).getByRole('button', { name: 'Manage billing' })).toBeTruthy();
  });
});

describe('the table', () => {
  it('Date, Amount, Status; Download PDF and Pay links open in a new tab', () => {
    const { container } = render(<ManageBillingBlock invoices={[ROW, { ...ROW, status: 'paid', payUrl: null }]} />);
    const rows = container.querySelectorAll('[data-org-invoice-row]');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toBe('Oct 31, 2026$124.95OverdueDownload PDFPay');
    expect(rows[1].textContent).toBe('Oct 31, 2026$124.95PaidDownload PDF');
    const pay = rows[0].querySelector('[data-billing-action="pay_invoice"]') as HTMLAnchorElement;
    expect(pay.getAttribute('href')).toBe(ROW.payUrl);
    expect(pay.getAttribute('target')).toBe('_blank');
    expect(pay.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('SR C9: one short sentence that does not repeat the rows', () => {
    const { container } = render(<ManageBillingBlock invoices={[ROW]} />);
    expect(container.textContent).not.toContain('View, download and pay invoices');
  });
});
