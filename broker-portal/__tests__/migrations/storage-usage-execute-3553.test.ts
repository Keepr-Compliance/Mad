/**
 * BACKLOG-3553 — text checks on the migration that sets EXECUTE on
 * public.get_storage_usage().
 *
 * Checks, over the migration text with comments stripped:
 *   - every REVOKE / GRANT names the function as the literal
 *     `public.get_storage_usage()`;
 *   - the union of roles across all REVOKE statements on it contains PUBLIC,
 *     anon and authenticated, and does not contain service_role;
 *   - the GRANT on it goes to service_role and to no other role;
 *   - the function itself is not redefined, altered or dropped.
 *
 * Reads repo text only. The privilege behaviour is exercised against a real
 * Postgres by supabase/tests/backlog-3553/.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '../../..');
const FILE = '20260929074121_backlog_3553_storage_usage_execute.sql';
const TARGET = 'public.get_storage_usage()';

const RAW = readFileSync(join(REPO, 'supabase/migrations', FILE), 'utf8').replace(/\r\n?/g, '\n');

/** Remove block comments, then `--` comments outside single quotes. */
function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      let inQuote = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === "'") inQuote = !inQuote;
        else if (!inQuote && c === '-' && line[i + 1] === '-') return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

const STATEMENTS = stripSqlComments(RAW)
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter((s) => s.length > 0);

type Acl = { kind: 'GRANT' | 'REVOKE'; privilege: string; target: string; roles: string[] };

const ACL_RE = /^(GRANT|REVOKE)\s+(.+?)\s+ON\s+FUNCTION\s+(.+?\))\s+(TO|FROM)\s+(.+)$/i;

/** Role names from a TO/FROM list: unquoted, lower-cased, trailing CASCADE/RESTRICT removed. */
function parseRoles(list: string): string[] {
  return list
    .replace(/\s+(CASCADE|RESTRICT)$/i, '')
    .split(',')
    .map((r) => r.trim().replace(/^"(.*)"$/, '$1').toLowerCase())
    .filter((r) => r.length > 0);
}

const ACLS: Acl[] = STATEMENTS.flatMap((s) => {
  const m = ACL_RE.exec(s);
  if (!m) return [];
  return [
    {
      kind: m[1].toUpperCase() as Acl['kind'],
      privilege: m[2].trim().toUpperCase(),
      target: m[3].replace(/\s+/g, ''),
      roles: parseRoles(m[5]),
    },
  ];
});

const onTarget = (kind: Acl['kind']): Acl[] => ACLS.filter((a) => a.kind === kind && a.target === TARGET);
const union = (acls: Acl[]): Set<string> => new Set(acls.flatMap((a) => a.roles));

describe(`BACKLOG-3553 migration ${FILE}`, () => {
  it('names the function only as the literal public.get_storage_usage()', () => {
    const mentioning = STATEMENTS.filter((s) => /get_storage_usage/i.test(s));
    expect(mentioning.length).toBeGreaterThan(0);
    for (const s of mentioning) {
      const m = ACL_RE.exec(s);
      expect(m).not.toBeNull();
      expect(m![3].replace(/\s+/g, '')).toBe(TARGET);
    }
  });

  it('has at least one REVOKE EXECUTE on public.get_storage_usage()', () => {
    const revokes = onTarget('REVOKE');
    expect(revokes.length).toBeGreaterThan(0);
    for (const r of revokes) expect(r.privilege).toBe('EXECUTE');
  });

  it('revokes from PUBLIC (the role), anon and authenticated', () => {
    const roles = union(onTarget('REVOKE'));
    // `public` here is a parsed role-list entry; the `public.` schema prefix
    // lives in the target and never reaches this set.
    expect(roles.has('public')).toBe(true);
    expect(roles.has('anon')).toBe(true);
    expect(roles.has('authenticated')).toBe(true);
  });

  it('does not revoke from service_role', () => {
    expect(union(onTarget('REVOKE')).has('service_role')).toBe(false);
  });

  it('grants EXECUTE on public.get_storage_usage() to service_role and to no other role', () => {
    const grants = onTarget('GRANT');
    expect(grants.length).toBeGreaterThan(0);
    for (const g of grants) expect(g.privilege).toBe('EXECUTE');
    expect([...union(grants)].sort()).toEqual(['service_role']);
  });

  it('does not redefine, alter or drop the function', () => {
    for (const s of STATEMENTS) {
      expect(s).not.toMatch(/^(CREATE|ALTER|DROP)\b.*\bFUNCTION\b/i);
    }
  });

  it('contains only REVOKE / GRANT statements', () => {
    expect(STATEMENTS.length).toBeGreaterThan(0);
    expect(ACLS.length).toBe(STATEMENTS.length);
  });
});
