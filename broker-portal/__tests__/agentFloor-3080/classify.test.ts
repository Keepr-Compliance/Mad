/**
 * The portal classifier — BACKLOG-3080.
 *
 * `classifyPortalAccess` and `mayOpenDashboardPath` decide, for every gate in
 * the portal, what a signed-in person may open. Rows come from the transcribed
 * PostgREST fixtures (helpers/postgrestEmulator.ts), never typed by hand.
 *
 * @jest-environment node
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  FIXTURE_BROKERAGE_ORG_ID,
  FIXTURE_OTHER_USER_ID,
  FIXTURE_PERSONAL_ORG_ID,
  FIXTURE_USER_ID,
  brokerageMembership,
  personalMembership,
  personalMembershipOwnedBy,
  type Row,
} from '../helpers/postgrestEmulator';
import {
  FLOOR_PATHS,
  FULL_PORTAL_ROLES,
  OWN_GATE_PATHS,
  classifyPortalAccess,
  mayOpenDashboardPath,
  type PortalAccess,
  type PortalMembershipRow,
} from '@/lib/auth/membership';

const classify = (rows: Row[] | null | undefined, userId = FIXTURE_USER_ID) =>
  classifyPortalAccess(rows as PortalMembershipRow[] | null | undefined, userId);

describe('classifyPortalAccess', () => {
  it('is `full` for exactly broker, admin and it_admin', () => {
    expect([...FULL_PORTAL_ROLES]).toEqual(['broker', 'admin', 'it_admin']);
    for (const role of FULL_PORTAL_ROLES) {
      expect(classify([brokerageMembership(role)])).toEqual({
        kind: 'full',
        role,
        organizationId: FIXTURE_BROKERAGE_ORG_ID,
      });
    }
  });

  it('floors a brokerage agent', () => {
    expect(classify([brokerageMembership('agent')])).toEqual({
      kind: 'floor',
      via: 'brokerage',
      role: 'agent',
      organizationId: FIXTURE_BROKERAGE_ORG_ID,
    });
  });

  it('floors a role it has never heard of — never full', () => {
    expect(classify([brokerageMembership('viewer')])).toMatchObject({
      kind: 'floor',
      via: 'brokerage',
      role: 'viewer',
    });
  });

  it('floors the OWNER of a personal organization', () => {
    expect(classify([personalMembership()])).toEqual({
      kind: 'floor',
      via: 'personal_owner',
      role: 'agent',
      organizationId: FIXTURE_PERSONAL_ORG_ID,
    });
  });

  it('is `none` for a member of a personal organization somebody else owns', () => {
    const row = personalMembershipOwnedBy(FIXTURE_OTHER_USER_ID, FIXTURE_USER_ID);
    expect((row.organizations as Record<string, unknown>).personal_owner_user_id).toBe(
      FIXTURE_OTHER_USER_ID
    );
    expect(classify([row])).toEqual({ kind: 'none' });
  });

  it('is `none` for a user with no membership at all', () => {
    expect(classify([])).toEqual({ kind: 'none' });
  });

  it('is `unknown` — not `none` — when the read failed', () => {
    expect(classify(null)).toEqual({ kind: 'unknown' });
    expect(classify(undefined)).toEqual({ kind: 'unknown' });
  });

  it('lets the brokerage row decide even when a personal row is returned first', () => {
    expect(classify([personalMembership(), brokerageMembership('broker')])).toMatchObject({
      kind: 'full',
      role: 'broker',
    });
    expect(classify([personalMembership(), brokerageMembership('agent')])).toMatchObject({
      kind: 'floor',
      via: 'brokerage',
      organizationId: FIXTURE_BROKERAGE_ORG_ID,
    });
  });

  it('takes two brokerage rows in the order they were returned', () => {
    const agent = brokerageMembership('agent');
    const broker = { ...brokerageMembership('broker'), id: 'second-row' };
    expect(classify([agent, broker]).kind).toBe('floor');
    expect(classify([broker, agent]).kind).toBe('full');
  });

  it('reads a pre-migration organization record (no owner key) as a brokerage', () => {
    expect(classify([brokerageMembership('broker', 'pre')]).kind).toBe('full');
    expect(classify([brokerageMembership('agent', 'pre')]).kind).toBe('floor');
  });
});

// ---------------------------------------------------------------------------
// mayOpenDashboardPath — swept across the boundary, not sampled.
// ---------------------------------------------------------------------------

const FULL: PortalAccess = { kind: 'full', role: 'broker', organizationId: 'o' };
const FLOOR: PortalAccess = { kind: 'floor', via: 'brokerage', role: 'agent', organizationId: 'o' };
const UNKNOWN: PortalAccess = { kind: 'unknown' };
const NONE: PortalAccess = { kind: 'none' };

/** Every path, with whether the FLOOR may open it. */
const PATHS: [string, boolean][] = [
  ['/dashboard', true],
  ['/dashboard/account', true],
  ['/dashboard/account/devices', true],
  ['/dashboard/support', true],
  ['/dashboard/support/new', true],
  ['/dashboard/support/abc-123', true],
  ['/dashboard/checklists', true],
  ['/dashboard/checklists/new', true],
  ['/dashboard/checklists/abc-123', true],
  ['/dashboard/submissions', false],
  ['/dashboard/submissions/abc-123', false],
  ['/dashboard/users', false],
  ['/dashboard/users/abc-123', false],
  ['/dashboard/settings', false],
  ['/dashboard/settings/scim', false],
  // Boundary: a shared prefix is not a sub-path.
  ['/dashboard/supportx', false],
  ['/dashboard/accounts', false],
  ['/dashboard/checklistsx', false],
  ['/dashboardx', false],
  ['/dashboard/x', false],
];

describe('mayOpenDashboardPath', () => {
  it('lists exactly the floor and own-gate paths', () => {
    expect([...FLOOR_PATHS]).toEqual(['/dashboard', '/dashboard/account', '/dashboard/support']);
    expect([...OWN_GATE_PATHS]).toEqual(['/dashboard/checklists']);
  });

  it.each(PATHS)('floor and unknown: %s -> %s', (path, floorMay) => {
    expect(mayOpenDashboardPath(FLOOR, path)).toBe(floorMay);
    expect(mayOpenDashboardPath(UNKNOWN, path)).toBe(floorMay);
  });

  it.each(PATHS)('full opens %s; none opens nothing', (path) => {
    expect(mayOpenDashboardPath(FULL, path)).toBe(true);
    expect(mayOpenDashboardPath(NONE, path)).toBe(false);
  });
});

describe('lib/auth/membership.ts stays importable from the Edge runtime', () => {
  // BACKLOG-3859: the classifier moved to packages/shared/src/billing/planRule.ts.
  // membership.ts may now reach exactly one module, @keepr/shared, and every
  // source file of that package must itself import nothing outside the package.
  const SHARED_SRC = join(__dirname, '../../../packages/shared/src');

  function specifiers(source: string): string[] {
    return [...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  }

  function sharedSources(dir: string): string[] {
    const { readdirSync, statSync } = require('fs') as typeof import('fs');
    return readdirSync(dir).flatMap((name: string) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? sharedSources(full) : full.endsWith('.ts') ? [full] : [];
    });
  }

  it('membership.ts reaches no module but @keepr/shared', () => {
    const source = readFileSync(join(__dirname, '../../lib/auth/membership.ts'), 'utf8');
    expect(source.length).toBeGreaterThan(1000);
    expect(source).toContain('classifyPortalAccess,');
    const specs = specifiers(source);
    expect(specs.length).toBeGreaterThan(0);
    expect(new Set(specs)).toEqual(new Set(['@keepr/shared']));
    expect(source).not.toMatch(/\brequire\(/);
  });

  it('packages/shared source imports nothing outside the package', () => {
    const files = sharedSources(SHARED_SRC);
    expect(files.some((f) => f.endsWith(join('billing', 'planRule.ts')))).toBe(true);
    for (const f of files) {
      const source = readFileSync(f, 'utf8');
      expect({ f, bad: specifiers(source).filter((s) => !s.startsWith('./') && !s.startsWith('../')) }).toEqual({ f, bad: [] });
      expect({ f, require: /\brequire\(/.test(source) }).toEqual({ f, require: false });
    }
    const rule = readFileSync(join(SHARED_SRC, 'billing/planRule.ts'), 'utf8');
    expect(rule).toContain('export function classifyPortalAccess');
    expect(specifiers(rule)).toEqual([]);
  });
});
