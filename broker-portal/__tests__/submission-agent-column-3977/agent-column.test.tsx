/**
 * BACKLOG-3977: the Submissions table (md and up) has an Agent column showing
 * each deal's submitter, labelled exactly as the agent filter labels them:
 *   - normal session: the user's display name, "Former member" when the
 *     submitter is no longer readable in users;
 *   - support session (no name lookup) or a failed lookup: neutral "Agent N".
 * Users rows use userNameRow (the production column pattern). Names invented.
 */

import { render, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import { FIXTURE_BROKERAGE_ORG_ID, createPostgrestEmulator, type Row } from '../helpers/postgrestEmulator';
import { submissionRow, userNameRow } from '../helpers/submissionRows';
import { ORG_WITHOUT_PLAN_FEATURES, withFeature } from '../fixtures/orgFeatures';

const mockEmulator = createPostgrestEmulator();
let mockImpersonatedOrg: string | null = null;
let mockUsersLookupFails = false;

jest.mock('@/lib/impersonation-guards', () => ({
  getDataClient: jest.fn(async () => ({
    client: {
      from: (t: string) =>
        t === 'users' && mockUsersLookupFails
          ? { select: () => ({ in: async () => ({ data: null, error: { message: 'lookup failed' } }) }) }
          : mockEmulator.from(t),
    },
    impersonation: mockImpersonatedOrg ? { organizationId: mockImpersonatedOrg } : null,
    organizationId: mockImpersonatedOrg,
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
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import SubmissionsPage from '@/app/dashboard/submissions/page';

// pii-allow-uuid: invented fixture ids below (whole block)
const ORG = FIXTURE_BROKERAGE_ORG_ID;
const AGENT_A = '00000000-0000-4000-8000-0000003977a1'; // pii-allow-uuid: invented fixture id
const AGENT_B = '00000000-0000-4000-8000-0000003977a2'; // pii-allow-uuid: invented fixture id
const S_A = '00000000-0000-4000-8000-000000397701'; // pii-allow-uuid: invented fixture id
const S_B = '00000000-0000-4000-8000-000000397702'; // pii-allow-uuid: invented fixture id

const NAME_A = 'Agent Alpha';
const NAME_B = 'Agent Bravo';
const STREET_A = '10 Birch Lane';
const STREET_B = '20 Cedar Court';

const sub = (id: string, agent: string, address: string, createdAt: string): Row => ({
  ...submissionRow({ id, organizationId: ORG, submittedBy: agent, status: 'submitted', parentSubmissionId: null, createdAt, address }),
  version: 1,
});

const ROWS: Row[] = [
  sub(S_A, AGENT_A, STREET_A, '2026-09-03T00:00:00Z'),
  sub(S_B, AGENT_B, STREET_B, '2026-09-02T00:00:00Z'),
];
const USERS: Row[] = [
  userNameRow(AGENT_A, NAME_A, 'alpha@fixture.example.test'),
  userNameRow(AGENT_B, NAME_B, 'bravo@fixture.example.test'),
];

function given(opts: { users?: Row[]; impersonating?: string | null; usersLookupFails?: boolean } = {}): void {
  mockEmulator.reset();
  mockEmulator.set({ rows: { transaction_submissions: ROWS, users: opts.users ?? USERS } });
  mockImpersonatedOrg = opts.impersonating ?? null;
  mockUsersLookupFails = opts.usersLookupFails ?? false;
}

async function renderList() {
  return render(await SubmissionsPage({ searchParams: Promise.resolve({}) }));
}

/** The Agent cell of the table row whose street is `street`, read by column header. */
function agentCell(street: string): HTMLTableCellElement {
  const table = document.querySelector('table') as HTMLTableElement;
  const heads = Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent?.trim());
  const col = heads.indexOf('Agent');
  expect(col).toBeGreaterThanOrEqual(0);
  const row = within(table).getByText(street).closest('tr') as HTMLTableRowElement;
  return row.querySelectorAll('td')[col] as HTMLTableCellElement;
}

describe('BACKLOG-3977 Agent column', () => {
  it('sits right after Property', async () => {
    given();
    const { container } = await renderList();
    const heads = Array.from(container.querySelectorAll('thead th')).map((th) => th.textContent?.trim());
    expect(heads.slice(0, 2)).toEqual(['Property', 'Agent']);
  });

  it('shows each deal\'s submitter by display name', async () => {
    given();
    await renderList();
    expect(agentCell(STREET_A)).toHaveTextContent(NAME_A);
    expect(agentCell(STREET_B)).toHaveTextContent(NAME_B);
  });

  it('a long name is truncated in the cell, with the full name as its title', async () => {
    given();
    await renderList();
    const span = agentCell(STREET_A).querySelector('span') as HTMLElement;
    expect(span.className.split(' ')).toEqual(expect.arrayContaining(['truncate', 'max-w-[12rem]']));
    expect(span).toHaveAttribute('title', NAME_A);
  });

  it('a submitter no longer in users is "Former member"', async () => {
    given({ users: [userNameRow(AGENT_A, NAME_A, 'alpha@fixture.example.test')] });
    await renderList();
    expect(agentCell(STREET_A)).toHaveTextContent(NAME_A);
    expect(agentCell(STREET_B)).toHaveTextContent('Former member');
  });

  it('a support session reads no names and shows neutral "Agent N" labels, never blank', async () => {
    // Models scoped-client.ts: users is ID-scoped to the target (AGENT_A) only.
    given({ impersonating: ORG, users: [userNameRow(AGENT_A, NAME_A, 'alpha@fixture.example.test')] });
    const { container } = await renderList();
    expect(mockEmulator.state.selects.filter((s) => s.table === 'users')).toEqual([]);
    const labels = [agentCell(STREET_A).textContent?.trim(), agentCell(STREET_B).textContent?.trim()];
    expect(labels.sort()).toEqual(['Agent 1', 'Agent 2']);
    expect(container).not.toHaveTextContent('Former member');
    expect(container).not.toHaveTextContent(NAME_A);
  });

  it('a failed users lookup shows neutral labels, never "Former member"', async () => {
    given({ usersLookupFails: true });
    const { container } = await renderList();
    const labels = [agentCell(STREET_A).textContent?.trim(), agentCell(STREET_B).textContent?.trim()];
    expect(labels.sort()).toEqual(['Agent 1', 'Agent 2']);
    expect(container).not.toHaveTextContent('Former member');
  });

  it('the table (and so the column) is md and up; phones keep the card list', async () => {
    given();
    await renderList();
    expect((document.querySelector('table') as HTMLElement).className.split(' ')).toContain('max-md:hidden');
    expect((document.querySelector('[data-slot=submission-cards]') as HTMLElement).className.split(' ')).toContain('md:hidden');
  });

  it('at tablet widths the six-column table scrolls sideways instead of clipping', async () => {
    given();
    await renderList();
    const frame = (document.querySelector('table') as HTMLElement).parentElement as HTMLElement;
    expect(frame.className.split(' ')).toContain('md:overflow-x-auto');
  });
});
