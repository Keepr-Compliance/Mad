/**
 * BACKLOG-3851 PR-2a (C8): the TS twins of the database's membership
 * predicates equal the SQL helpers, read from the migrations that define them.
 *
 * For each helper the LAST migration (by file name = ledger order) that
 * defines `FUNCTION public.<name>(` is the live body; its `IN (...)` list is
 * the set. Then every value the status CHECK admits, NULL, and a value nobody
 * writes are swept through both: the SQL answer is
 * `COALESCE(x IN (list), false)`, which is the whole body of each helper.
 *
 * @jest-environment node
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  MEMBER_DEACTIVATED_STATUSES,
  MEMBER_IDP_ORIGINS,
  MEMBER_SEAT_STATUSES,
  PORTAL_GRANTING_LICENSE_STATUSES,
  memberOriginIsIdp,
  memberStatusGrantsAccess,
  memberStatusHoldsSeat,
  memberStatusIsDeactivated,
} from '@keepr/shared';

const MIGRATIONS = join(__dirname, '..', '..', '..', 'supabase', 'migrations');
const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();

/** The IN-list of the live body of `public.<fn>(text)`. */
function sqlList(fn: string): string[] {
  let body: string | null = null;
  for (const f of files) {
    const src = readFileSync(join(MIGRATIONS, f), 'utf8');
    const at = src.lastIndexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
    if (at >= 0) body = src.slice(at, src.indexOf('$function$;', at));
  }
  if (!body) throw new Error(`no migration defines public.${fn}`);
  const m = /\bIN\s*\(([^)]*)\)/.exec(body);
  if (!m) throw new Error(`public.${fn}: no IN list`);
  return m[1].split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
}

/** The values organization_members_license_status_check admits (last definition). */
function checkValues(): string[] {
  let list: string[] | null = null;
  for (const f of files) {
    const src = readFileSync(join(MIGRATIONS, f), 'utf8');
    const re = /organization_members_license_status_check\s+CHECK\s*\(\s*license_status\s+IN\s*\(([^)]*)\)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) list = m[1].split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
  }
  if (!list) throw new Error('no license_status CHECK found');
  return list;
}

const sqlAnswer = (list: string[], v: string | null) => v !== null && list.includes(v);

const STATUS_SWEEP: (string | null)[] = [...checkValues(), null, 'bogus', 'Active', ''];
const ORIGIN_SWEEP: (string | null)[] = ['manual', 'scim', 'jit', 'invite', 'directory_sync', null, 'bogus', 'JIT'];

const CASES = [
  ['member_status_grants_access', [...PORTAL_GRANTING_LICENSE_STATUSES], memberStatusGrantsAccess, STATUS_SWEEP],
  ['member_status_is_deactivated', [...MEMBER_DEACTIVATED_STATUSES], memberStatusIsDeactivated, STATUS_SWEEP],
  ['member_status_holds_seat', [...MEMBER_SEAT_STATUSES], memberStatusHoldsSeat, STATUS_SWEEP],
  ['member_origin_is_idp', [...MEMBER_IDP_ORIGINS], memberOriginIsIdp, ORIGIN_SWEEP],
] as const;

describe('C8 TS twins equal the SQL helpers', () => {
  it('the CHECK admits unassigned (M1)', () => {
    expect(checkValues()).toEqual(expect.arrayContaining(['pending', 'active', 'suspended', 'expired', 'unassigned']));
  });

  it.each(CASES)('%s: same set', (fn, ts) => {
    expect([...ts].sort()).toEqual(sqlList(fn).sort());
  });

  it.each(CASES.flatMap(([fn, , pred, sweep]) => sweep.map((v) => [fn, v, pred] as const)))(
    '%s(%p): TS answers what SQL answers',
    (fn, v, pred) => {
      expect((pred as (x: string | null) => boolean)(v)).toBe(sqlAnswer(sqlList(fn), v));
    }
  );
});
