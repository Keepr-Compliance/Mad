/**
 * BACKLOG-3511 (broker half, C3): the report roles the portal admits equal the roles the database
 * helper public.org_report_scope admits.
 *
 * The portal side: FULL_PORTAL_ROLES (what lib/reports/report-gate.ts and the registry's
 * ReportRole read) and PORTAL_GRANTING_LICENSE_STATUSES (what classifyPortalAccess treats as an
 * active licence). The database side: the helper's body in migration 20261108190000, read as text
 * (CRLF normalised): the IN list of the 'all' branch, the role of the 'own' branch and the
 * license_status it requires. Every role the organization_members role CHECK admits, plus values
 * nobody writes, is swept through both.
 *
 * @jest-environment node
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { FULL_PORTAL_ROLES, PORTAL_GRANTING_LICENSE_STATUSES } from '@/lib/auth/membership';

const MIGRATION = join(
  __dirname, '..', '..', '..', 'supabase', 'migrations',
  '20261108190000_backlog_3511_broker_report_readers.sql'
);
const normalise = (text: string) => text.replace(/\r\n/g, '\n');
const src = normalise(readFileSync(MIGRATION, 'utf8'));

/** The helper body: from CREATE ... org_report_scope( to the closing $function$;. */
function helperBody(text: string = src): string {
  const at = text.indexOf('CREATE OR REPLACE FUNCTION public.org_report_scope(');
  if (at < 0) throw new Error('migration does not define public.org_report_scope');
  const end = text.indexOf('$function$;', at);
  if (end < 0) throw new Error('org_report_scope: no $function$; terminator');
  return text.slice(at, end);
}

const unquote = (v: string) => v.trim().replace(/^'|'$/g, '');

function sqlFullRoles(text: string = src): string[] {
  const m = /WHEN\s+m\.role\s+IN\s*\(([^)]*)\)\s+THEN\s+'all'/i.exec(helperBody(text));
  if (!m) throw new Error("org_report_scope: no `m.role IN (...) THEN 'all'` branch");
  return m[1].split(',').map(unquote);
}

function sqlAgentRole(): string {
  const m = /WHEN\s+m\.role\s*=\s*'([^']*)'\s+THEN\s+'own'/i.exec(helperBody());
  if (!m) throw new Error("org_report_scope: no `m.role = '...' THEN 'own'` branch");
  return m[1];
}

function sqlActiveStatuses(): string[] {
  const m = /m\.license_status\s*=\s*'([^']*)'/i.exec(helperBody());
  if (!m) throw new Error('org_report_scope: no license_status filter');
  return [m[1]];
}

/** What the helper answers for an active brokerage member with this role. */
function sqlScope(role: string): 'all' | 'own' | null {
  if (sqlFullRoles().includes(role)) return 'all';
  if (role === sqlAgentRole()) return 'own';
  return null;
}

/** What the portal grants an active brokerage member with this role on an agent-scoped report. */
function tsScope(role: string): 'all' | 'own' | null {
  if ((FULL_PORTAL_ROLES as readonly string[]).includes(role)) return 'all';
  if (role === 'agent') return 'own';
  return null;
}

// organization_members_role_check (keepr-test, 2026-11-07): agent, broker, admin, it_admin.
const ROLE_SWEEP = ['agent', 'broker', 'admin', 'it_admin', 'Admin', 'owner', ''];

describe('C3 report roles: portal = public.org_report_scope', () => {
  it('a CRLF checkout of the migration parses to the same set', () => {
    const crlf = src.replace(/\n/g, '\r\n');
    expect(sqlFullRoles(normalise(crlf))).toEqual(sqlFullRoles());
  });

  it('full-role set: same set', () => {
    expect([...FULL_PORTAL_ROLES].sort()).toEqual(sqlFullRoles().sort());
  });

  it('the founder ruling: broker, admin and it_admin are full', () => {
    expect(sqlFullRoles().sort()).toEqual(['admin', 'broker', 'it_admin']);
  });

  it("the agent role is 'agent'", () => {
    expect(sqlAgentRole()).toBe('agent');
  });

  it('active means the statuses the portal treats as granting', () => {
    expect([...PORTAL_GRANTING_LICENSE_STATUSES].sort()).toEqual(sqlActiveStatuses());
  });

  it.each(ROLE_SWEEP)('role %p: portal scope = SQL scope', (role) => {
    expect(tsScope(role)).toBe(sqlScope(role));
  });
});
