/**
 * The invoices UI inside "Invoices & payment method" — BACKLOG-3855 (plan C8; SR C6, C9).
 */

const mockOpenPortal = jest.fn();
jest.mock('@/lib/actions/billingPortal', () => ({ openBrokerageBillingPortal: (...a: unknown[]) => mockOpenPortal(...a) }));

import { act, fireEvent, render, within } from '@testing-library/react';
import { ManageBillingBlock } from '@/components/billing/ManageBillingBlock';
import type { OrgInvoiceRow } from '@/lib/billing/orgInvoices';

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

describe('C8: View all invoices', () => {
  it('is a text link (not a second Manage billing button) and calls the portal action with no arguments', async () => {
    const { container } = render(<ManageBillingBlock invoices={[ROW]} />);
    const link = container.querySelector('[data-billing-action="view_all_invoices"]') as HTMLElement;
    expect(link.textContent).toBe('View all invoices ↗');
    expect(link.className).not.toMatch(/\bbg-/);
    await act(async () => {
      fireEvent.click(link);
    });
    expect(mockOpenPortal.mock.calls).toEqual([[]]);
  });

  it('not shown when no invoice list was passed (the block on its own, as before 3855)', () => {
    const { container } = render(<ManageBillingBlock />);
    expect(container.querySelector('[data-billing-action="view_all_invoices"]')).toBeNull();
    expect(container.querySelector('[data-org-invoice-row]')).toBeNull();
    expect(within(container).getByRole('button', { name: 'Manage billing ↗' })).toBeTruthy();
  });
});

describe('SR C6: an unavailable list keeps both controls', () => {
  it('null rows -> the unavailable line, View all and Manage billing', () => {
    const { container } = render(<ManageBillingBlock invoices={null} />);
    expect(container.textContent).toContain('Your invoices are unavailable right now.');
    expect(container.querySelector('[data-billing-action="view_all_invoices"]')).not.toBeNull();
    expect(within(container).getByRole('button', { name: 'Manage billing ↗' })).toBeTruthy();
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

  it('SR C9: one short sentence that does not repeat the rows; the help article link', () => {
    const { container } = render(<ManageBillingBlock invoices={[ROW]} />);
    expect(container.textContent).not.toContain('View, download and pay invoices');
    expect(container.querySelector('a[href="/guides/invoices"]')?.textContent).toBe('Where do I find my invoices?');
  });
});
