/**
 * BACKLOG-3904 row design B on the REAL Submissions list page: street / city line,
 * no Docs or Review column, phone card with status over price.
 * Addresses are invented, in the stored shape "<street>, <city>, <ST> <zip>, USA".
 */

import { render, fireEvent, screen, within } from '@testing-library/react';
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

const rowOf = (text: string) => within(document.querySelector('table') as HTMLElement).getByText(text).closest('tr') as HTMLTableRowElement;

describe('desktop columns', () => {
  it('has no Docs or Review/Actions column, and no msgs/files counts', async () => {
    const { container } = await renderList();
    const heads = Array.from(container.querySelectorAll('thead th')).map((th) => th.textContent?.trim());
    expect(heads).toEqual(['Property', 'Agent', 'Type', 'Price', 'Status', 'Submitted']); // Agent: BACKLOG-3977
    expect(container.textContent).not.toMatch(/\bmsgs\b|\bfiles\b|Review\b/);
    expect(container.querySelectorAll('tbody tr:first-child > td:not(.hidden)')).toHaveLength(6);
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

describe('phone card (the shared SubmissionCard)', () => {
  const cardOf = (text: string) =>
    within(document.querySelector('[data-slot=submission-cards]') as HTMLElement).getByText(text).closest('a') as HTMLAnchorElement;

  it('is one link to the submission, with street, city line, status over price, and agent - type - date', async () => {
    await renderList();
    const card = cardOf('33 Example Rd');
    expect(card).toHaveAttribute('href', `/dashboard/submissions/${S1}`);
    expect(card.textContent).toContain('Fixture City, CA 90000');
    expect(card.textContent).not.toMatch(/USA/);
    const cells = Array.from(card.children) as HTMLElement[];
    const status = cells.find((c) => c.textContent === 'Submitted') as HTMLElement;
    expect(status.className).toMatch(/col-start-2/);
    expect(status.className).toMatch(/row-start-1/);
    const price = cells.find((c) => /^\$|^-/.test(c.textContent ?? '')) as HTMLElement;
    expect(price.className).toMatch(/col-start-2/);
    expect(price.className).toMatch(/row-start-2/);
    const meta = cells[cells.length - 1];
    expect(meta.textContent).toMatch(/^.+ · .+ · .+$/);
  });

  it('has a focus ring and applies hover only where a pointer can hover', async () => {
    await renderList();
    const cls = cardOf('33 Example Rd').className;
    expect(cls).toMatch(/focus-visible:ring-2/);
    expect(cls).toContain('[@media(hover:hover)]:hover:bg-gray-50');
    expect(cls.split(' ')).not.toContain('hover:bg-gray-50');
  });

  it('renders one card per row, and the cards list is phone only', async () => {
    await renderList();
    const list = document.querySelector('[data-slot=submission-cards]') as HTMLElement;
    expect(list.className.split(' ')).toContain('md:hidden');
    expect(list.querySelectorAll('[data-slot=submission-card]')).toHaveLength(3);
  });
});
