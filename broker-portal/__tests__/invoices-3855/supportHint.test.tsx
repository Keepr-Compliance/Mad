/**
 * "Where do I find my invoices?" in BOTH support forms — BACKLOG-3855 (plan C11, SR C7).
 * TicketForm (/support/new, /dashboard/support/new) and SupportWidget (every dashboard page).
 * Category rows: names and slugs as the 3080 / 3851 suites transcribed them; ids invented.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockGetCategories = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock('html2canvas', () => ({
  __esModule: true,
  default: async () => ({ toBlob: (cb: (b: Blob | null) => void) => cb(null) }),
}));
jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));
jest.mock('@/lib/support-queries', () => ({
  ...jest.requireActual('@/lib/support-queries'),
  getCategories: () => mockGetCategories(),
  createTicket: jest.fn(),
  uploadAttachment: jest.fn(),
}));
jest.mock('@/app/support/components/FileUpload', () => ({ FileUpload: () => null }));
jest.mock('@/app/support/components/BrowserDiagnostics', () => ({
  useBrowserDiagnostics: () => null,
  BrowserDiagnostics: () => null,
}));

import { TicketForm } from '@/app/support/components/TicketForm';
import { SupportWidget } from '@/app/dashboard/components/SupportWidget';

const CATEGORIES = [
  { id: 'cat-billing', name: 'Billing & Subscription', slug: 'billing-subscription', description: null, parent_id: null, sort_order: 1, is_active: true, metadata: null },
  { id: 'cat-tech', name: 'Technical Issue', slug: 'technical-issue', description: null, parent_id: null, sort_order: 2, is_active: true, metadata: null },
  { id: 'sub-invoice', name: 'Invoice/payment issue', slug: 'invoice-payment-issue', description: null, parent_id: 'cat-billing', sort_order: 1, is_active: true, metadata: null },
];

const hint = () => document.querySelector('[data-support-hint="invoices"]');

beforeEach(() => mockGetCategories.mockReset().mockResolvedValue(CATEGORIES));
afterEach(cleanup);

async function pick(select: HTMLSelectElement, id: string) {
  await act(async () => {
    fireEvent.change(select, { target: { value: id } });
  });
}

describe('TicketForm', () => {
  it('Billing & Subscription -> the hint links /guides/invoices; Technical Issue / none -> no hint', async () => {
    render(<TicketForm />);
    const category = (await screen.findByLabelText('Category')) as HTMLSelectElement;
    await waitFor(() => expect(category.querySelectorAll('option').length).toBeGreaterThan(2));
    expect(hint()).toBeNull();
    await pick(category, 'cat-tech');
    expect(hint()).toBeNull();
    await pick(category, 'cat-billing');
    expect(hint()?.textContent).toBe('Looking for an invoice? Where do I find my invoices?');
    expect(hint()?.querySelector('a')?.getAttribute('href')).toBe('/guides/invoices');
  });
});

describe('SupportWidget', () => {
  it('Billing & Subscription -> the hint; Technical Issue -> no hint', async () => {
    render(<SupportWidget />);
    await act(async () => {
      window.dispatchEvent(new Event('open-support-widget'));
    });
    const category = (await screen.findByLabelText('Category')) as HTMLSelectElement;
    await waitFor(() => expect(category.querySelectorAll('option').length).toBeGreaterThan(2));
    expect(hint()).toBeNull();
    await pick(category, 'cat-tech');
    expect(hint()).toBeNull();
    await pick(category, 'cat-billing');
    expect(hint()?.querySelector('a')?.getAttribute('href')).toBe('/guides/invoices');
  });
});
