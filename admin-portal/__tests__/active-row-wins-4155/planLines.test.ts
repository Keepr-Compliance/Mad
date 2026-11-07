/**
 * BACKLOG-4155 — the admin users-list plan line follows the same deciding
 * brokerage row as the broker portal: an active row anywhere, else an
 * unassigned row, else the first row. planLines.ts calls BOTH
 * pickBrokerageMembership and classifyPortalAccess, so the line would
 * contradict the portal if only the classifier changed.
 *
 * Member rows use BASE_TABLES' transcribed shape (plan-view-3859/fixtures.ts:
 * user_id, role, organization_id, license_status, created_at, id,
 * organizations(name, personal_owner_user_id)); ids invented.
 */
import { describe, expect, it } from 'vitest';
import { makeClient } from '../plan-view-3859/emulator';
import { BROKERAGE_ORG, BROKERAGE_ORG_2, NOW, type Row } from '../plan-view-3859/fixtures';
import { readPlanLinesWithOrgs } from '@/lib/planLines';

type Svc = Parameters<typeof readPlanLinesWithOrgs>[0];

const USER = '00000000-0000-4000-8000-000000415501'; // pii-allow-uuid: invented fixture id
const PERSONAL = '00000000-0000-4000-8000-000000415502'; // pii-allow-uuid: invented fixture id

const row = (id: string, org: string, name: string, status: string, createdAt: string): Row => ({
  id,
  user_id: USER,
  role: 'agent',
  organization_id: org,
  license_status: status,
  created_at: createdAt,
  organizations: { name, personal_owner_user_id: null },
});
const EARLY = '2026-10-10T16:24:29.154388+00:00';
const LATE = '2026-10-11T09:00:00+00:00';
const personalRow: Row = {
  id: 'p-1',
  user_id: USER,
  role: 'owner',
  organization_id: PERSONAL,
  license_status: 'active',
  created_at: '2026-10-01T00:00:00+00:00',
  organizations: { name: 'Own personal', personal_owner_user_id: USER },
};

async function lineFor(members: Row[]) {
  const { client } = makeClient({
    organization_members: members,
    organizations: [{ id: PERSONAL, personal_owner_user_id: USER, is_test: true }],
    billing_subscriptions: [],
    organization_plans: [],
    licenses: [],
  });
  const res = await readPlanLinesWithOrgs(client as unknown as Svc, [USER], NOW);
  return { line: res.lines[USER], org: res.brokerageOrgIds[USER] };
}

describe('BACKLOG-4155 admin plan line', () => {
  it.each([
    ['A older', EARLY, LATE],
    ['B older', LATE, EARLY],
  ])('C1 unassigned at A + active at B (%s): the line names B, license assigned', async (_l, a, b) => {
    const { line, org } = await lineFor([
      row('m-a', BROKERAGE_ORG, 'Demo Realty', 'unassigned', a),
      row('m-b', BROKERAGE_ORG_2, 'Second Brokerage', 'active', b),
    ]);
    expect(line.kind).toBe('brokerage');
    expect(line.text).toBe('Brokerage Second Brokerage, license assigned');
    expect(org).toBe(BROKERAGE_ORG_2);
  });

  it.each([
    ['A older', EARLY, LATE],
    ['B older', LATE, EARLY],
  ])('C3a suspended at A + unassigned at B + own personal (%s): the line names B, no license assigned', async (_l, a, b) => {
    const { line, org } = await lineFor([
      personalRow,
      row('m-a', BROKERAGE_ORG, 'Demo Realty', 'suspended', a),
      row('m-b', BROKERAGE_ORG_2, 'Second Brokerage', 'unassigned', b),
    ]);
    expect(line.kind).toBe('brokerage');
    expect(line.text).toBe('Brokerage Second Brokerage, no license assigned');
    expect(line.warning).toBeNull();
    expect(org).toBe(BROKERAGE_ORG_2);
  });

  it('twin: suspended at A alone + own personal -> still the personal line, deactivated from A', async () => {
    const { line, org } = await lineFor([personalRow, row('m-a', BROKERAGE_ORG, 'Demo Realty', 'suspended', EARLY)]);
    expect(line.kind).not.toBe('brokerage');
    expect(line.warning).toContain('Deactivated from Demo Realty');
    expect(org).toBeUndefined();
  });
});
