/**
 * BACKLOG-3513 PR-2: the shared broker report rows in the organization Activity list. Detail key
 * sets per action are the ones admin_get_org_activity returned on keepr-test (2026-11-12, after the
 * supabase/tests/backlog-3513-broker controls ran): created/deleted {report_name}; owner_changed
 * {report_name} or {report_name, via}; general_access/row_scope/share_changed/shared/unshared
 * {from, report_name, to}; a role grant adds {role} and has no subject_name. Values and names invented.
 */
import { describe, expect, it } from 'vitest';
import { describeActivity, type ActivityRow } from '@/lib/activity/describeActivity';

function row(action: string, detail: Record<string, unknown>, over: Partial<ActivityRow> = {}): ActivityRow {
  return {
    action,
    detail,
    actor_name: 'Pat Doe',
    created_at: '2026-11-12T16:39:22.834541+00:00',
    subject_name: 'Sam Roe',
    actor_is_staff: false,
    actor_is_subject: false,
    ...over,
  };
}

describe('shared broker report activity (BACKLOG-3513)', () => {
  it('names the report, the grantee and both levels on a level change', () => {
    expect(describeActivity(row('report_share_changed', { from: 'viewer', to: 'editor', report_name: 'Pipeline five' }))).toBe(
      'Pat Doe changed Sam Roe\'s access to the report "Pipeline five" from Can view to Can edit',
    );
  });

  it('writes a first share, to a person and to a role', () => {
    expect(describeActivity(row('report_shared', { from: null, to: 'viewer', report_name: 'Q4' }))).toBe(
      'Pat Doe shared the report "Q4" with Sam Roe (Can view)',
    );
    expect(describeActivity(row('report_shared', { role: 'it_admin', from: null, to: 'editor', report_name: 'Q4' }, { subject_name: null }))).toBe(
      'Pat Doe shared the report "Q4" with all IT admins (Can edit)',
    );
  });

  it('writes a removal, and a person leaving on their own', () => {
    expect(describeActivity(row('report_unshared', { from: 'editor', to: null, report_name: 'Q4' }))).toBe(
      'Pat Doe removed Sam Roe from the report "Q4" (was Can edit)',
    );
    expect(describeActivity(row('report_unshared', { from: 'viewer', to: null, report_name: 'Q4' }, { actor_is_subject: true }))).toBe(
      'Sam Roe left the report "Q4" (was Can view)',
    );
    expect(describeActivity(row('report_unshared', { role: 'agent', from: 'viewer', to: null, report_name: 'Q4' }, { subject_name: null }))).toBe(
      'Pat Doe removed all agents from the report "Q4" (was Can view)',
    );
  });

  it('writes general access, row scope, ownership and lifecycle', () => {
    expect(describeActivity(row('report_general_access_changed', { from: 'restricted', to: 'organization', report_name: 'Q4' }))).toBe(
      'Pat Doe shared the report "Q4" with everyone in the organization',
    );
    expect(describeActivity(row('report_general_access_changed', { from: 'organization', to: 'restricted', report_name: 'Q4' }))).toBe(
      'Pat Doe limited the report "Q4" to the people added',
    );
    expect(describeActivity(row('report_row_scope_changed', { from: 'all', to: 'own', report_name: 'Q4' }))).toBe(
      'Pat Doe set the report "Q4" to show each person only their own rows',
    );
    expect(describeActivity(row('report_owner_changed', { report_name: 'Q4' }))).toBe('Pat Doe made Sam Roe the owner of the report "Q4"');
    expect(describeActivity(row('report_owner_changed', { via: 'take_over', report_name: 'Q4' }))).toBe('Pat Doe took over the report "Q4"');
    expect(describeActivity(row('report_created', { report_name: 'Q4' }))).toBe('Pat Doe created the report "Q4"');
    expect(describeActivity(row('report_deleted', { report_name: 'Q4' }))).toBe('Pat Doe deleted the report "Q4"');
  });

  it('falls back when the reader has no report name', () => {
    expect(describeActivity(row('report_deleted', {}))).toBe('Pat Doe deleted a report');
  });
});
