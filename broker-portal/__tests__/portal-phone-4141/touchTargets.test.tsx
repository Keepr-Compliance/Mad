/**
 * BACKLOG-4141: class contract for /login and the support ticket form below lg (phone and 768 tablet).
 * Every link, field and button carries the shared 44 px touch classes (components/billing/touch.ts)
 * and small print reads at 14 px; the desktop classes stay in place. The real layout is measured by
 * scripts/portal-phone-4141/run.sh.
 */
import { render, act, screen } from '@testing-library/react';
import React from 'react';
import { TOUCH_BUTTON, TOUCH_LINK } from '@/components/billing/touch';

let search = new URLSearchParams();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: jest.fn(), push: jest.fn() }),
  useSearchParams: () => search,
}));
jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { getUser: () => Promise.resolve({ data: { user: null } }) } }),
}));
jest.mock('@/lib/support-queries', () => ({
  getCategories: () => Promise.resolve([]),
  buildCategoryTree: () => [],
  createTicket: jest.fn(),
  uploadAttachment: jest.fn(),
}));
jest.mock('@/app/support/components/BrowserDiagnostics', () => {
  const actual = jest.requireActual('@/app/support/components/BrowserDiagnostics');
  return { ...actual, useBrowserDiagnostics: () => ({ userAgent: 'fixture' }) };
});

import LoginPage from '@/app/login/page';
import { TicketForm } from '@/app/support/components/TicketForm';

const classes = (el: Element) => (el.getAttribute('class') || '').split(/\s+/);
const hasAll = (el: Element, want: string) => want.split(' ').every((c) => classes(el).includes(c));

describe('BACKLOG-4141 login page below lg', () => {
  it.each([
    ['default', '', 4],
    ['org_not_setup', 'error=org_not_setup', 6],
  ])('%s: every link is a 44 px touch link', async (_n, q, count) => {
    search = new URLSearchParams(q);
    const { container } = render(<LoginPage />);
    await act(async () => {});
    const links = [...container.querySelectorAll('a')];
    expect(links).toHaveLength(count);
    for (const a of links) expect([a.textContent, hasAll(a, TOUCH_LINK)]).toEqual([a.textContent, true]);
  });

  it('small print is 14 px below lg and unchanged from lg up', async () => {
    search = new URLSearchParams();
    render(<LoginPage />);
    await act(async () => {});
    const label = screen.getByText('Broker Portal');
    expect(hasAll(label, 'text-[11px] max-lg:text-sm')).toBe(true);
    for (const t of [/Only authorized brokers/, /Invited as a brokerage admin/, /By continuing you agree/]) {
      const p = screen.getByText(t, { selector: 'p' });
      expect(hasAll(p, 'text-xs max-lg:text-sm')).toBe(true);
    }
  });
});

describe('BACKLOG-4141 support ticket form below lg', () => {
  it('fields, Submit and the Diagnostics toggle are 44 px; helper text is 14 px', async () => {
    const { container } = render(<TicketForm />);
    await act(async () => {});
    const controls = [
      ...container.querySelectorAll('input:not([type="file"]), select'),
      screen.getByRole('button', { name: 'Submit Ticket' }),
      screen.getByRole('button', { name: 'Diagnostics (attached automatically)' }),
    ];
    expect(controls).toHaveLength(7);
    for (const el of controls) expect([el.id || el.textContent, hasAll(el, TOUCH_BUTTON)]).toEqual([el.id || el.textContent, true]);
    expect(hasAll(screen.getByRole('button', { name: 'Submit Ticket' }), 'h-9')).toBe(true);
    for (const t of [/Drop files here/, /Max 10MB per file/]) {
      expect(hasAll(screen.getByText(t, { selector: 'p' }), 'text-xs max-lg:text-sm')).toBe(true);
    }
  });
});
