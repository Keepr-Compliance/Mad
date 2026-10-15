/**
 * Submissions list org scope — BACKLOG-3906.
 *
 * The REAL Submissions page and the REAL getAllowedOrgIds over the PostgREST
 * emulator (filters applied, NO RLS, so every scope asserted here is the
 * page's own query). The list shows only orgs whose broker_portal_access read
 * succeeded and is enabled, in broker and support sessions alike; when that
 * cannot be established it lists nothing and says so.
 *
 * FIXTURE PROVENANCE:
 *   - row shape: __tests__/helpers/submissionRows.ts (the production columns).
 *   - feature sets: ORG_WITHOUT_PLAN_FEATURES (transcribed) with
 *     broker_portal_access set per org, as in __tests__/submission-deals-3597.
 *   - a failed feature read is produced by the REAL getOrgFeatures, its RPC
 *     answering with NOT_AUTHENTICATED_PAYLOAD (transcribed from the live
 *     broker_get_org_features) — not a hand-written feature set.
 *   - a failed org-list read answers with ABSENT_COLUMN_ERROR (a transcribed
 *     PostgREST error); the page only tests that an error is present.
 *   Every id is invented.
 */

import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import {
  ABSENT_COLUMN_ERROR,
  FIXTURE_BROKERAGE_ORG_ID,
  createPostgrestEmulator,
  type Row,
} from '../helpers/postgrestEmulator';
import { submissionRow } from '../helpers/submissionRows';
import { NOT_AUTHENTICATED_PAYLOAD, ORG_WITHOUT_PLAN_FEATURES, withFeature } from '../fixtures/orgFeatures';

const mockEmulator = createPostgrestEmulator();
let mockImpersonatedOrg: string | null = null;
let mockPortalAccess: Record<string, boolean> = {};
let mockFeatureReadFails: string[] = [];
let mockOrgListFails = false;

/** The org-list read in getAllowedOrgIds selects exactly 'organization_id'. */
function mockClientFrom(table: string) {
  const chain = mockEmulator.from(table) as unknown as Record<string, (...a: unknown[]) => unknown>;
  if (!mockOrgListFails || table !== 'transaction_submissions') return chain;
  const select = chain.select;
  chain.select = (columns: unknown, ...rest: unknown[]) => {
    if (columns !== 'organization_id') return select(columns, ...rest);
    const failed: Record<string, unknown> = {};
    failed.neq = () => failed;
    failed.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
      Promise.resolve({ data: null, error: { ...ABSENT_COLUMN_ERROR }, status: 400 }).then(ok, ko);
    return failed;
  };
  return chain;
}

jest.mock('@/lib/impersonation-guards', () => ({
  getDataClient: jest.fn(async () => ({
    client: { from: (t: string) => mockClientFrom(t) },
    impersonation: mockImpersonatedOrg ? { organizationId: mockImpersonatedOrg } : null,
    organizationId: mockImpersonatedOrg,
  })),
  getTargetOrganizationId: (id: string | null) => id || undefined,
}));
// The feature RPC's own client: answers like the live function for a failed read.
jest.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    rpc: async (_fn: string, args: { p_org_id: string }) => ({
      data: { ...NOT_AUTHENTICATED_PAYLOAD, org_id: args.p_org_id },
      error: null,
    }),
  }),
}));
jest.mock('@/lib/feature-gate', () => {
  const actual = jest.requireActual('@/lib/feature-gate');
  return {
    ...actual,
    getOrgFeatures: jest.fn(async (orgId: string) =>
      mockFeatureReadFails.includes(orgId)
        ? actual.getOrgFeatures(orgId)
        : withFeature({ ...ORG_WITHOUT_PLAN_FEATURES, org_id: orgId }, 'broker_portal_access', mockPortalAccess[orgId] ?? true)
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
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import SubmissionsPage from '@/app/dashboard/submissions/page';

// pii-allow-uuid: invented fixture ids below (whole block)
const ORG = FIXTURE_BROKERAGE_ORG_ID;
const ORG_NO_ACCESS = '00000000-0000-4000-8000-0000003906b1'; // pii-allow-uuid: invented fixture id
const ORG_2 = '00000000-0000-4000-8000-0000003906b2'; // pii-allow-uuid: invented fixture id
const AGENT = '00000000-0000-4000-8000-0000003906a1'; // pii-allow-uuid: invented fixture id
const IN_ORG = '00000000-0000-4000-8000-000000390601'; // pii-allow-uuid: invented fixture id
const IN_ORG_2 = '00000000-0000-4000-8000-000000390602'; // pii-allow-uuid: invented fixture id
const NO_ACCESS = '00000000-0000-4000-8000-000000390603'; // pii-allow-uuid: invented fixture id

const ROWS: Row[] = [
  submissionRow({ id: IN_ORG, organizationId: ORG, submittedBy: AGENT, status: 'submitted', createdAt: '2026-09-03T00:00:00Z' }),
  submissionRow({ id: IN_ORG_2, organizationId: ORG_2, submittedBy: AGENT, status: 'submitted', createdAt: '2026-09-02T00:00:00Z' }),
  submissionRow({ id: NO_ACCESS, organizationId: ORG_NO_ACCESS, submittedBy: AGENT, status: 'submitted', createdAt: '2026-09-01T00:00:00Z' }),
];

const ERROR_TEXT = 'Submissions could not be loaded. Reload the page to try again.';

function given(opts: { impersonating?: string | null; featureReadFails?: string[]; orgListFails?: boolean } = {}): void {
  mockEmulator.reset();
  mockEmulator.set({ rows: { transaction_submissions: ROWS } });
  mockImpersonatedOrg = opts.impersonating ?? null;
  mockPortalAccess = { [ORG_NO_ACCESS]: false };
  mockFeatureReadFails = opts.featureReadFails ?? [];
  mockOrgListFails = opts.orgListFails ?? false;
}

async function renderList(params: { view?: string } = {}) {
  const element = await SubmissionsPage({ searchParams: Promise.resolve(params) });
  return render(element);
}

/** Every submission id the page links to (table rows, phone cards, board cards). */
function linkedIds(container: HTMLElement): string[] {
  const ids = Array.from(container.querySelectorAll('a[href^="/dashboard/submissions/"]')).map(
    (a) => (a.getAttribute('href') as string).split('/').pop() as string
  );
  return Array.from(new Set(ids)).sort();
}

function expectLoadError(): void {
  const alert = screen.getByRole('alert');
  expect(alert).toHaveTextContent(ERROR_TEXT);
  // Visible at every width: not inside a container hidden from md up.
  expect(alert.closest('.md\\:hidden')).toBeNull();
  expect(screen.queryByText('No submissions yet')).not.toBeInTheDocument();
}

beforeEach(() => given());

describe('broker session', () => {
  it('O1: lists the orgs with broker_portal_access and not the org without it (fixture can fail)', async () => {
    const { container } = await renderList();
    expect(linkedIds(container)).toEqual([IN_ORG, IN_ORG_2].sort());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('O2: the org list cannot be read -> nothing listed, error shown', async () => {
    given({ orgListFails: true });
    const { container } = await renderList();
    expect(linkedIds(container)).toEqual([]);
    expectLoadError();
  });

  it('O3: the org list cannot be read, board view -> nothing listed, error shown, no board', async () => {
    given({ orgListFails: true });
    const { container } = await renderList({ view: 'board' });
    expect(linkedIds(container)).toEqual([]);
    expectLoadError();
    expect(container.querySelector('[data-slot="submission-board"]')).toBeNull();
  });

  it('O4: one org\'s feature read fails -> nothing listed from any org, error shown', async () => {
    given({ featureReadFails: [ORG_2] });
    const { container } = await renderList();
    expect(linkedIds(container)).toEqual([]);
    expectLoadError();
  });

  it('O5: the org without access fails its feature read -> still not listed', async () => {
    given({ featureReadFails: [ORG_NO_ACCESS] });
    const { container } = await renderList();
    expect(linkedIds(container)).not.toContain(NO_ACCESS);
    expectLoadError();
  });
});

describe('support session', () => {
  it('O6: target org with broker_portal_access -> its submissions listed', async () => {
    given({ impersonating: ORG });
    const { container } = await renderList();
    expect(linkedIds(container)).toEqual([IN_ORG]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('O7: target org without broker_portal_access -> still listed (support sessions do not apply the check; BACKLOG-3922)', async () => {
    given({ impersonating: ORG_NO_ACCESS });
    const { container } = await renderList();
    expect(linkedIds(container)).toEqual([NO_ACCESS]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('O8: the feature lookup answers not_authenticated (the real support-session shape) -> submissions still load, no error', async () => {
    given({ impersonating: ORG, featureReadFails: [ORG] });
    const { container } = await renderList();
    expect(linkedIds(container)).toEqual([IN_ORG]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(ERROR_TEXT)).not.toBeInTheDocument();
  });
});
