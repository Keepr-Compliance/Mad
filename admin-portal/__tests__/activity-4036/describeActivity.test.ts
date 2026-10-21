/**
 * BACKLOG-4036: the activity sentences. The action list is read from the migrations (every
 * INSERT INTO billing_change_log, its action literal or CASE), so a new writer without a
 * sentence goes red here.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTIVITY_TEMPLATES, activityNote, describeActivity, humanise, type ActivityRow } from '@/lib/activity/describeActivity';

const MIGRATIONS = join(__dirname, '..', '..', '..', 'supabase', 'migrations');
const INSERT = /INSERT\s+INTO\s+(?:public\.)?billing_change_log\b/gi;
const SHAPE =
  /INSERT\s+INTO\s+(?:public\.)?billing_change_log\s*\([^)]*\)\s*(?:VALUES\s*\(|SELECT\s)\s*[^,]+,\s*[^,]+,\s*(CASE[\s\S]*?END|'[a-z_]+')/gi;

function loggedActions(): { actions: Set<string>; inserts: number; parsed: number } {
  const actions = new Set<string>();
  let inserts = 0;
  let parsed = 0;
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql'))) {
    const sql = readFileSync(join(MIGRATIONS, f), 'utf8');
    inserts += (sql.match(INSERT) ?? []).length;
    for (const m of sql.matchAll(SHAPE)) {
      parsed += 1;
      for (const lit of m[1].matchAll(/'([a-z_]+)'/g)) actions.add(lit[1]);
    }
  }
  return { actions, inserts, parsed };
}

// Real reader rows (admin_get_org_activity on keepr-test, 2026-10-21), names replaced.
function row(action: string, over: Partial<ActivityRow> = {}): ActivityRow {
  return {
    action,
    detail: {},
    actor_name: 'Pat Doe',
    created_at: '2026-10-21T16:39:22.834541+00:00',
    subject_name: 'Sam Roe',
    actor_is_staff: false,
    actor_is_subject: false,
    ...over,
  };
}

describe('describeActivity (BACKLOG-4036)', () => {
  it('has a sentence for every action any migration writes to billing_change_log', () => {
    const { actions, inserts, parsed } = loggedActions();
    expect(inserts, 'every insert statement is parsed (a new shape must be taught here)').toBe(parsed);
    expect(actions.size).toBeGreaterThanOrEqual(27);
    const missing = [...actions].filter((a) => !(a in ACTIVITY_TEMPLATES));
    expect(missing).toEqual([]);
  });

  it('has a sentence for both staff rows the reader takes from admin_audit_logs', () => {
    expect(describeActivity(row('organization.created', { actor_is_staff: true }))).toBe('Pat Doe created the organization');
    expect(describeActivity(row('org_plan.assigned', { detail: { plan: 'Team' } }))).toBe('Pat Doe set the plan to Team');
  });

  it('writes the member sentences', () => {
    expect(describeActivity(row('member_role_changed', { detail: { from: 'agent', to: 'admin' } }))).toBe("Pat Doe changed Sam Roe's role to Admin");
    expect(describeActivity(row('member_license_changed', { detail: { from: 'active', to: 'suspended' } }))).toBe('Pat Doe deactivated Sam Roe');
    expect(describeActivity(row('member_license_changed', { detail: { from: 'suspended', to: 'active' } }))).toBe('Pat Doe reactivated Sam Roe');
    expect(describeActivity(row('member_license_changed', { detail: { from: 'unassigned', to: 'active' } }))).toBe('Pat Doe gave Sam Roe a license');
    expect(describeActivity(row('member_license_changed', { detail: { from: 'active', to: 'unassigned' } }))).toBe("Pat Doe took Sam Roe's license");
    expect(describeActivity(row('member_role_changed', { actor_name: 'Directory sync', detail: { to: 'broker', via: 'directory' } }))).toBe("Directory sync changed Sam Roe's role to Broker");
    expect(describeActivity(row('phone_changed', { actor_name: 'Sam Roe', actor_is_subject: true, detail: { cleared: false } }))).toBe('Sam Roe changed their phone');
    expect(describeActivity(row('phone_changed', { detail: { cleared: true } }))).toBe("Pat Doe removed Sam Roe's phone");
    expect(describeActivity(row('auto_renew_off', { detail: { note: null, ends_on: '2026-10-30T12:00:00+00:00' } }))).toBe('Pat Doe turned off auto-renew');
  });

  it('falls back to Keepr and "a member" when the reader has no names', () => {
    expect(describeActivity(row('member_removed', { actor_name: null, subject_name: null }))).toBe('Keepr removed a member');
  });

  it('renders an unknown action without throwing', () => {
    expect(describeActivity(row('some_new_thing'))).toBe('Pat Doe: Some new thing');
    expect(humanise('billing.deal_saved')).toBe('Billing deal saved');
  });

  it('shows the staff note, and the reason only for a deal save', () => {
    expect(activityNote(row('suspended', { detail: { reason: 'non_payment', note: 'Card declined' } }))).toBe('Card declined');
    expect(activityNote(row('suspended', { detail: { reason: 'non_payment' } }))).toBeNull();
    expect(activityNote(row('deal_saved', { detail: { reason: 'Deal created' } }))).toBe('Deal created');
  });
});
