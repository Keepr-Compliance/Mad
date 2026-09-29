/**
 * Submissions list rows open the submission on click — BACKLOG-3609.
 *
 * Renders the REAL broker Submissions list page (same harness as
 * __tests__/submission-deals-3597/deal-list.test.tsx) and the REAL
 * SubmissionRow client component. Row shape comes from
 * __tests__/helpers/submissionRows.ts; every id is invented.
 *
 * jsdom has no layout, so "click anywhere on the row" is exercised by clicking
 * cells that hold no link (the Property and Price cells).
 */

import { render, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

const AGENT = '00000000-0000-4000-8000-0000003609a1'; // pii-allow-uuid: invented fixture id
const S1 = '00000000-0000-4000-8000-000000360901'; // pii-allow-uuid: invented fixture id
const S2 = '00000000-0000-4000-8000-000000360902'; // pii-allow-uuid: invented fixture id

const ROWS: Row[] = [
  {
    ...submissionRow({ id: S1, organizationId: FIXTURE_BROKERAGE_ORG_ID, submittedBy: AGENT, status: 'submitted', parentSubmissionId: null, createdAt: '2026-09-02T00:00:00Z', address: '12 Invented Lane' }),
    version: 1,
  },
  {
    ...submissionRow({ id: S2, organizationId: FIXTURE_BROKERAGE_ORG_ID, submittedBy: AGENT, status: 'approved', parentSubmissionId: null, createdAt: '2026-09-01T00:00:00Z', address: '34 Fictional Road' }),
    version: 1,
  },
];

let openSpy: jest.SpyInstance;

beforeEach(() => {
  mockEmulator.reset();
  mockEmulator.set({ rows: { transaction_submissions: ROWS } });
  mockPush.mockClear();
  openSpy = jest.spyOn(window, 'open').mockImplementation(() => null);
  window.getSelection()?.removeAllRanges();
});

afterEach(() => openSpy.mockRestore());

async function renderList() {
  const element = await SubmissionsPage({ searchParams: Promise.resolve({}) });
  return render(element);
}

function rowOf(address: string): HTMLTableRowElement {
  return screen.getByText(address).closest('tr') as HTMLTableRowElement;
}

describe('Submissions list: clicking a row opens that submission', () => {
  it('R1: clicking a non-link cell navigates to that row\'s submission', async () => {
    await renderList();
    fireEvent.click(screen.getByText('12 Invented Lane'));
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith(`/dashboard/submissions/${S1}`);

    mockPush.mockClear();
    const priceCell = rowOf('34 Fictional Road').querySelectorAll('td')[2];
    fireEvent.click(priceCell);
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith(`/dashboard/submissions/${S2}`);
  });

  it('R2: clicking the Review link inside a row keeps the link\'s own action (no second navigation)', async () => {
    await renderList();
    const review = rowOf('12 Invented Lane').querySelector('a') as HTMLAnchorElement;
    expect(review).toHaveAttribute('href', `/dashboard/submissions/${S1}`);
    fireEvent.click(review);
    expect(mockPush).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('R3: cmd/ctrl-click on a row opens it in a new tab, like the dashboard link', async () => {
    await renderList();
    fireEvent.click(screen.getByText('12 Invented Lane'), { metaKey: true });
    expect(openSpy).toHaveBeenCalledWith(`/dashboard/submissions/${S1}`, '_blank', 'noopener');
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('R4: keyboard — each row has exactly one tab stop, the Review link to that submission', async () => {
    await renderList();
    const user = userEvent.setup();
    const links = [
      ...Array.from(rowOf('12 Invented Lane').querySelectorAll('a, [tabindex]')),
      ...Array.from(rowOf('34 Fictional Road').querySelectorAll('a, [tabindex]')),
    ];
    expect(links).toHaveLength(2);
    // Tab past the status filter links to the first row's link.
    let focused: Element | null = null;
    for (let i = 0; i < 20 && focused !== links[0]; i++) {
      await user.tab();
      focused = document.activeElement;
    }
    expect(document.activeElement).toBe(links[0]);
    expect(document.activeElement).toHaveAttribute('href', `/dashboard/submissions/${S1}`);
    await user.tab();
    expect(document.activeElement).toBe(links[1]);
    expect(document.activeElement).toHaveAttribute('href', `/dashboard/submissions/${S2}`);
  });

  it('R5: selecting text in a row does not navigate', async () => {
    await renderList();
    const cell = screen.getByText('12 Invented Lane');
    const range = document.createRange();
    range.selectNodeContents(cell);
    window.getSelection()!.addRange(range);
    fireEvent.click(cell);
    expect(mockPush).not.toHaveBeenCalled();
  });
});
