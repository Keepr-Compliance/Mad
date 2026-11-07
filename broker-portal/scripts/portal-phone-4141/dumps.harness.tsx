/**
 * BACKLOG-4141 login + support-form phone-width harness: markup dumps (NOT a CI test).
 * Renders the real /login page (default, and with ?error=org_not_setup for the in-alert links) and
 * the real support TicketForm (as /dashboard/support/new renders it, inside a Card, with the
 * diagnostics block present) and writes $DUMP_DIR/<name>.html. run.sh compiles the real Tailwind
 * for each and check.cjs measures it.
 */
import { render, act } from '@testing-library/react';
import { writeFileSync } from 'fs';
import { join } from 'path';
import React from 'react';

let search = new URLSearchParams();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: jest.fn(), push: jest.fn() }),
  useSearchParams: () => search,
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
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
  return { ...actual, useBrowserDiagnostics: () => ({ userAgent: 'fixture', platform: 'fixture' }) };
});

import LoginPage from '@/app/login/page';
import { TicketForm } from '@/app/support/components/TicketForm';
import { Card } from '@keepr/design-system';

const dump = (name: string, html: string) => writeFileSync(join(process.env.DUMP_DIR as string, `${name}.html`), html);

describe('portal phone dumps', () => {
  it('login', async () => {
    search = new URLSearchParams();
    const r = render(<LoginPage />);
    await act(async () => {});
    dump('login', r.container.innerHTML);
  });
  it('login-org-not-setup', async () => {
    search = new URLSearchParams('error=org_not_setup');
    const r = render(<LoginPage />);
    await act(async () => {});
    dump('login-org-not-setup', r.container.innerHTML);
  });
  it('support-new', async () => {
    const r = render(
      <div className="max-w-4xl mx-auto p-4">
        <Card>
          <TicketForm />
        </Card>
      </div>,
    );
    await act(async () => {});
    dump('support-new', r.container.innerHTML);
  });
});
