/**
 * Reports sidebar entry per role and feature state — BACKLOG-3505 (C4).
 *
 * The REAL dashboard layout computes showReports through the REAL
 * lib/reports/report-gate.ts; the REAL Sidebar then renders those props. Mocked:
 * the portal classifier's result, the impersonation cookie, the feature read
 * (its own fail-closed behaviour is covered in gate.test.ts), the registry (a
 * TEST-ONLY fixture: PR-1 ships an empty one) and the unrelated nav gates.
 */

import { render } from '@testing-library/react';
import type { ReportDefinition } from '@/lib/reports/registry';

const mockImpersonation = jest.fn();
const mockPortal = jest.fn();
const mockFeature = jest.fn();
let mockRegistry: ReportDefinition[] = [];

jest.mock('@/lib/impersonation', () => ({
  getImpersonationSession: () => mockImpersonation(),
}));
jest.mock('@/lib/auth/portalAccess', () => ({
  getPortalAccess: () => mockPortal(),
}));
jest.mock('@/lib/feature-gate', () => ({
  isFeatureEnabledFailClosed: (...args: unknown[]) => mockFeature(...args),
}));
jest.mock('@/lib/reports/registry', () => ({
  get REPORT_REGISTRY() {
    return mockRegistry;
  },
}));
jest.mock('@/lib/checklist-access', () => ({
  CHECKLIST_FEATURE_KEY: 'transaction_checklists',
  isChecklistPageEnabled: jest.fn(async () => false),
}));
jest.mock('@/lib/checklist-nav', () => ({
  getChecklistNavPolicy: jest.fn(async () => 'hidden'),
}));
jest.mock('@/lib/my-transactions-access', () => ({
  getMyTransactionsGate: jest.fn(async () => null),
}));
jest.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

import DashboardLayout from '@/app/dashboard/layout';
import { Sidebar, type SidebarProps } from '@/components/layout/Sidebar';

const ORG = '00000000-0000-4000-8000-000000350511'; // pii-allow-uuid: invented fixture id

const BROKER_ONLY: ReportDefinition = {
  slug: 'fixture-broker-only',
  title: 'Fixture broker report',
  description: 'Invented.',
  source: 'fixture_source',
  access: { roles: ['broker', 'admin', 'it_admin'], agentScoped: false },
};
const AGENT_SCOPED: ReportDefinition = { ...BROKER_ONLY, slug: 'fixture-agent-scoped', access: { ...BROKER_ONLY.access, agentScoped: true } };

type Access = Record<string, unknown>;
const full = (role: string): Access => ({ kind: 'full', role, organizationId: ORG });
const agent: Access = { kind: 'floor', via: 'brokerage', role: 'agent', organizationId: ORG };
const personalOwner: Access = { kind: 'floor', via: 'personal_owner', role: 'agent', organizationId: ORG };

interface Case {
  access: Access;
  registry: ReportDefinition[];
  feature: boolean;
  impersonating?: boolean;
}

/** The Reports hrefs the sidebar renders for this case, through the real layout. */
async function reportsLinks(c: Case): Promise<string[]> {
  mockRegistry = c.registry;
  mockFeature.mockResolvedValue(c.feature);
  mockImpersonation.mockResolvedValue(c.impersonating ? { targetUserId: 'fixture-target', targetEmail: 't@fixture.example.test' } : null);
  mockPortal.mockResolvedValue({
    supabase: {},
    user: { id: 'fixture-user', email: 'member@fixture.example.test', user_metadata: {} },
    access: c.access,
    suspended: false,
    orgSuspended: false,
    billingContact: false,
  });
  const element = await DashboardLayout({ children: null });
  const p = element.props as Partial<SidebarProps> & Record<string, unknown>;
  const { container, unmount } = render(
    <Sidebar
      collapsed={false}
      onToggle={() => {}}
      role={p.role}
      floorOnly={p.floorOnly}
      isImpersonating={p.isImpersonating as boolean}
      displayEmail="member@fixture.example.test"
      showReports={p.showReports}
      showMyTransactions={p.showMyTransactions}
      showBilling={p.showBilling}
    />
  );
  const out = Array.from(container.querySelectorAll('nav a'))
    .map((a) => a.getAttribute('href') as string)
    .filter((h) => h.startsWith('/dashboard/reports'));
  unmount();
  return out;
}

const SHOWN = ['/dashboard/reports'];
const HIDDEN: string[] = [];

const TABLE: [string, Case, string[]][] = [
  ['broker, feature on', { access: full('broker'), registry: [BROKER_ONLY], feature: true }, SHOWN],
  ['admin, feature on', { access: full('admin'), registry: [BROKER_ONLY], feature: true }, SHOWN],
  ['it_admin, feature on (no member bucket)', { access: full('it_admin'), registry: [BROKER_ONLY], feature: true }, SHOWN],
  ['agent with an agent-scoped report', { access: agent, registry: [BROKER_ONLY, AGENT_SCOPED], feature: true }, SHOWN],
  ['agent without an agent-scoped report', { access: agent, registry: [BROKER_ONLY], feature: true }, HIDDEN],
  ['personal-org owner', { access: personalOwner, registry: [BROKER_ONLY, AGENT_SCOPED], feature: true }, HIDDEN],
  ['impersonating', { access: full('broker'), registry: [BROKER_ONLY, AGENT_SCOPED], feature: true, impersonating: true }, HIDDEN],
  ['broker, feature off', { access: full('broker'), registry: [BROKER_ONLY], feature: false }, HIDDEN],
  ['agent with an agent-scoped report, feature off', { access: agent, registry: [AGENT_SCOPED], feature: false }, HIDDEN],
  ['broker, shipped empty registry', { access: full('broker'), registry: [], feature: true }, HIDDEN],
];

beforeEach(() => jest.clearAllMocks());

describe('C4: Reports sidebar entry', () => {
  it.each(TABLE)('%s', async (_n, c, expected) => {
    expect(await reportsLinks(c)).toEqual(expected);
  });

  it('the layout reads portal access once per render (the gate reuses it)', async () => {
    await reportsLinks({ access: full('broker'), registry: [BROKER_ONLY], feature: true });
    expect(mockPortal).toHaveBeenCalledTimes(1);
    expect(mockFeature).toHaveBeenCalledWith(ORG, 'broker_reports');
  });

  it('renders exactly once, before My Account, for every bucket', () => {
    for (const props of [
      { role: 'broker' },
      { role: 'it_admin' },
      { role: 'agent', floorOnly: true },
    ] as Partial<SidebarProps>[]) {
      const { container, unmount } = render(
        <Sidebar collapsed={false} onToggle={() => {}} isImpersonating={false} displayEmail="m@fixture.example.test" showReports {...props} />
      );
      const hrefs = Array.from(container.querySelectorAll('nav a')).map((a) => a.getAttribute('href'));
      expect(hrefs.filter((h) => h === '/dashboard/reports')).toHaveLength(1);
      expect(hrefs.indexOf('/dashboard/reports')).toBeLessThan(hrefs.indexOf('/dashboard/account'));
      unmount();
    }
  });

  it('renders nothing for Reports when showReports is false, for every bucket (the Sidebar reads the flag)', () => {
    for (const props of [
      { role: 'broker' },
      { role: 'admin' },
      { role: 'it_admin' },
      { role: 'agent', floorOnly: true },
    ] as Partial<SidebarProps>[]) {
      const { container, unmount } = render(
        <Sidebar collapsed={false} onToggle={() => {}} isImpersonating={false} displayEmail="m@fixture.example.test" showReports={false} {...props} />
      );
      const hrefs = Array.from(container.querySelectorAll('nav a')).map((a) => a.getAttribute('href'));
      expect(hrefs).toContain('/dashboard/account'); // the nav rendered
      expect(hrefs).not.toContain('/dashboard/reports');
      unmount();
    }
  });
});
