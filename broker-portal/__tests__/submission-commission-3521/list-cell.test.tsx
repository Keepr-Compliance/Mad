/**
 * Submissions list row: commission in place of the attachments count —
 * BACKLOG-3615 (shipped with BACKLOG-3521).
 *
 * Runs the real list page against the BACKLOG-3364 PostgREST emulator
 * (plumbing copied from __tests__/submission-list-3609/row-click.test.tsx).
 * Figure shapes are the two production rows transcribed on 2026-09-29 (see
 * commission.test.tsx): 3.000/2.500 and 3.000/3.000, sent by PostgREST as
 * JSON numbers. Ids and addresses are invented.
 */
import { render, screen } from '@testing-library/react';
import React from 'react';
import { FIXTURE_BROKERAGE_ORG_ID, createPostgrestEmulator, type Row } from '../helpers/postgrestEmulator';
import { submissionRow } from '../helpers/submissionRows';
import { ORG_WITHOUT_PLAN_FEATURES, withFeature } from '../fixtures/orgFeatures';
import { listCell, readCommission } from '@/lib/submissions/commission';

const mockEmulator = createPostgrestEmulator();

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
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
jest.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  usePathname: () => '/dashboard/submissions',
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import SubmissionsPage from '@/app/dashboard/submissions/page';

const AGENT = '00000000-0000-4000-8000-0000003615a1'; // pii-allow-uuid: invented fixture id
const S_REDUCED = '00000000-0000-4000-8000-000000361501'; // pii-allow-uuid: invented fixture id
const S_EQUAL = '00000000-0000-4000-8000-000000361502'; // pii-allow-uuid: invented fixture id
const S_NONE = '00000000-0000-4000-8000-000000361503'; // pii-allow-uuid: invented fixture id

function row(id: string, address: string, createdAt: string, offered: number | null, actual: number | null, gross: number | null): Row {
  return {
    ...submissionRow({ id, organizationId: FIXTURE_BROKERAGE_ORG_ID, submittedBy: AGENT, status: 'submitted', parentSubmissionId: null, createdAt, address }),
    version: 1,
    message_count: 3,
    attachment_count: 7,
    commission_offered_rate: offered,
    commission_actual_rate: actual,
    commission_gross_amount: gross,
    commission_adjustment_reason: null,
  };
}

beforeEach(() => {
  mockEmulator.reset();
  mockEmulator.set({
    rows: {
      transaction_submissions: [
        row(S_REDUCED, '12 Invented Lane', '2026-09-29T03:00:00Z', 3, 2.5, 12500),
        row(S_EQUAL, '34 Fictional Road', '2026-09-29T02:00:00Z', 3, 3, 36000),
        row(S_NONE, '56 Made-up Court', '2026-09-29T01:00:00Z', null, null, null),
      ],
    },
  });
});

function cellFor(address: string): string {
  const tr = screen.getByText(address).closest('tr') as HTMLTableRowElement;
  const cell = tr.querySelector('[data-testid="list-commission"]');
  return cell?.textContent ?? '<missing>';
}

describe('Submissions list commission cell (BACKLOG-3615)', () => {
  it('shows offered → actual, one rate when equal, "–" when none, and no attachments count', async () => {
    render(await SubmissionsPage({ searchParams: Promise.resolve({}) }));
    expect(cellFor('12 Invented Lane')).toBe('3% → 2.5%');
    expect(cellFor('34 Fictional Road')).toBe('3%');
    expect(cellFor('56 Made-up Court')).toBe('–');
    expect(screen.queryByText('7 files')).toBeNull();
    expect(screen.queryByTitle('Attachments')).toBeNull();
    expect(screen.getAllByText('3 msgs')).toHaveLength(3);
  });

  it('either rate alone', () => {
    expect(listCell(readCommission({ commission_offered_rate: '3.000', commission_actual_rate: null }))).toBe('3%');
    expect(listCell(readCommission({ commission_offered_rate: null, commission_actual_rate: '2.500' }))).toBe('2.5%');
    expect(listCell(readCommission({ commission_offered_rate: '3.000', commission_actual_rate: '2.375' }))).toBe('3% → 2.375%');
  });
});
