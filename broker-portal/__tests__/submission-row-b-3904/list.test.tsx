/**
 * BACKLOG-3904 row design B on the REAL Submissions list page: street / city line,
 * no Docs or Review column, phone card with status over price.
 * Addresses are invented, in the stored shape "<street>, <city>, <ST> <zip>, USA".
 */

import { render, fireEvent, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import { FIXTURE_BROKERAGE_ORG_ID, createPostgrestEmulator, type Row } from '../helpers/postgrestEmulator';
import { submissionRow } from '../helpers/submissionRows';
import { ORG_WITHOUT_PLAN_FEATURES, withFeature } from '../fixtures/orgFeatures';

const mockEmulator = createPostgrestEmulator();
const mockPush = jest.fn();

jest.mock('@/lib/impersonation-guards', () => ({
  getDataClient: jest.fn(async () => ({
    client: { from: (t: string) => mockEmulator.from(t) },
    impersonation: null,
    organizationId: null,
  })),
  getTargetOrganizationId: (id: string | null) => id || undefined,
}));
jest.mock('@/lib/feature-gate', () => {
  const actual = jest.requireActual('@/lib/feature-gate');
  return {
    ...actual,
    getOrgFeatures: jest.fn(async (orgId: string) =>
      withFeature({ ...ORG_WITHOUT_PLAN_FEATURES, org_id: orgId }, 'broker_portal_access', true)
    ),
  };
});
jest.mock('@/lib/auth/portalAccess', () => ({ requireFullPortalAccess: jest.fn(async () => ({ ok: true })) }));
jest.mock('@/components/submission/SubmissionListClient', () => ({
  SubmissionListClient: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
jest.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  usePathname: () => '/dashboard/submissions',
  useRouter: () => ({ push: mockPush, refresh: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import SubmissionsPage from '@/app/dashboard/submissions/page';

const AGENT = '00000000-0000-4000-8000-0000003904a1'; // pii-allow-uuid: invented fixture id
const S1 = '00000000-0000-4000-8000-000000390401'; // pii-allow-uuid: invented fixture id
const S2 = '00000000-0000-4000-8000-000000390402'; // pii-allow-uuid: invented fixture id
const S3 = '00000000-0000-4000-8000-000000390403'; // pii-allow-uuid: invented fixture id

const mk = (id: string, address: string, createdAt: string): Row => ({
  ...submissionRow({ id, organizationId: FIXTURE_BROKERAGE_ORG_ID, submittedBy: AGENT, status: 'submitted', parentSubmissionId: null, createdAt, address }),
  version: 1,
});

beforeEach(() => {
  mockEmulator.reset();
  mockEmulator.set({
    rows: {
      transaction_submissions: [
        mk(S1, '33 Example Rd, Fixture City, CA 90000, USA', '2026-09-03T00:00:00Z'),
        mk(S2, '5120 Sample Ave, Unit 2, Fixture City, CA 90000, USA', '2026-09-02T00:00:00Z'),
        mk(S3, '1234 Invented Boulevard', '2026-09-01T00:00:00Z'),
      ],
    },
  });
});

async function renderList() {
  return render(await SubmissionsPage({ searchParams: Promise.resolve({}) }));
}

const rowOf = (text: string) => screen.getByText(text).closest('tr') as HTMLTableRowElement;

describe('desktop columns', () => {
  it('has no Docs or Review/Actions column, and no msgs/files counts', async () => {
    const { container } = await renderList();
    const heads = Array.from(container.querySelectorAll('thead th')).map((th) => th.textContent?.trim());
    expect(heads).toEqual(['Property', 'Type', 'Price', 'Status', 'Submitted']);
    expect(container.textContent).not.toMatch(/\bmsgs\b|\bfiles\b|Review\b/);
    expect(container.querySelectorAll('tbody tr:first-child > td:not(.hidden)')).toHaveLength(5);
  });

  it('shows the street on line 1 and "City, ST ZIP" on line 2, with no USA', async () => {
    await renderList();
    const cell = rowOf('33 Example Rd').querySelector('td') as HTMLElement;
    const lines = Array.from(cell.children).map((c) => c.textContent);
    expect(lines).toEqual(['33 Example Rd', 'Fixture City, CA 90000']);
    expect(cell.textContent).not.toMatch(/USA/);
  });

  it('keeps a unit on line 1', async () => {
    await renderList();
    const lines = Array.from((rowOf('5120 Sample Ave, Unit 2').querySelector('td') as HTMLElement).children).map((c) => c.textContent);
    expect(lines).toEqual(['5120 Sample Ave, Unit 2', 'Fixture City, CA 90000']);
  });

  it('falls back to the full address and city, state when it cannot be parsed', async () => {
    await renderList();
    const lines = Array.from((rowOf('1234 Invented Boulevard').querySelector('td') as HTMLElement).children).map((c) => c.textContent);
    expect(lines).toEqual(['1234 Invented Boulevard', 'Fixture City, CA']);
  });

  it('the street is the row\'s one link, named by the street, to that submission', async () => {
    await renderList();
    const row = rowOf('33 Example Rd');
    const links = row.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', `/dashboard/submissions/${S1}`);
    expect(links[0]).toHaveAccessibleName('33 Example Rd');
    expect(links[0].className).toMatch(/focus-visible:ring-2/);
  });
});

describe('phone card', () => {
  it('puts the status pill over the price in the right column', async () => {
    await renderList();
    const cells = Array.from(rowOf('33 Example Rd').querySelectorAll('td'));
    const status = cells.find((td) => td.textContent === 'Submitted') as HTMLElement;
    const price = cells.find((td) => /^\$|^—|^-/.test(td.textContent ?? '')) ?? cells[2];
    expect(status.className).toMatch(/max-md:col-start-2/);
    expect(status.className).toMatch(/max-md:row-start-1/);
    expect(price.className).toMatch(/max-md:col-start-2/);
    expect(price.className).toMatch(/max-md:row-start-2/);
  });

  it('shows "agent · type · date" as one phone-only line, hiding the desktop type and date cells', async () => {
    await renderList();
    const cells = Array.from(rowOf('33 Example Rd').querySelectorAll('td'));
    const meta = cells.find((td) => td.className.includes('hidden max-md:block')) as HTMLElement;
    expect(meta.textContent).toMatch(/^.+ · .+ · .+$/);
    expect(cells[1].className).toMatch(/max-md:hidden/);
    expect(cells[4].className).toMatch(/max-md:hidden/);
  });
});
