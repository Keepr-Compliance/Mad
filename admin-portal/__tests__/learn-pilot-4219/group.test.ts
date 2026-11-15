/**
 * BACKLOG-4219 PR3 (A3, A3b): the admin list grouped for the page, from the transcribed capture.
 * Org, then Keepr user id; one column per version ascending by VERSION; the mark from each row's
 * own version fields; the change from the column to its left.
 */

import { describe, expect, it } from 'vitest';

import { buildViewModel, versionMark } from '@/lib/learn-pilot/group';
import { parseAdminList } from '@/lib/learn-pilot/parse';
import type { OrgGroup, PilotViewModel, UserGroup } from '@/lib/learn-pilot/types';
import { ADMIN_LIST, PR2_REPORT, USER_10, USER_13, USER_6, clone } from './fixtures';

function model(list: unknown = clone(ADMIN_LIST)): Extract<PilotViewModel, { ok: true }> {
  const m = buildViewModel(parseAdminList(list, null));
  if (!m.ok) throw new Error('fixture did not parse');
  return m;
}
const org = (m: { orgs: OrgGroup[] }, name: string) => m.orgs.find((o) => o.name === name)!;
const user = (o: OrgGroup, id: string) => o.users.find((u) => u.userId === id)!;
const row = (u: UserGroup, id: string) => u.rows.find((r) => r.id === id)!;

describe('A3 grouping and marks (capture as-is)', () => {
  it('two orgs; X shows its current pin once, Z is on the released rules', () => {
    const m = model();
    expect(m.orgs.map((o) => o.name).sort()).toEqual(['P4219 X', 'P4219 Z']);
    expect(org(m, 'P4219 X').pin).toEqual({ version: 5, since: '2026-11-11T18:50:02.172359+00:00' });
    expect(org(m, 'P4219 Z').pin).toBeNull();
  });

  it('users are grouped by user id, newest report first, with the name or null', () => {
    const x = org(model(), 'P4219 X');
    expect(x.users.map((u) => [u.userId, u.userName])).toEqual([
      [USER_6, 'P4219 user 6'],
      [USER_10, 'Pat Ten'],
    ]);
    expect(org(model(), 'P4219 Z').users.map((u) => [u.userId, u.userName])).toEqual([[USER_13, null]]);
  });

  // DERIVED: two different users with the same name stay two users (grouped by user id).
  it('two users with the same name are two users', () => {
    const list = clone(ADMIN_LIST);
    for (const r of list.rows) if (r.user_id === USER_6) r.user_name = 'Pat Ten';
    const x = org(model(list), 'P4219 X');
    expect(x.users.map((u) => [u.userId, u.userName])).toEqual([
      [USER_6, 'Pat Ten'],
      [USER_10, 'Pat Ten'],
    ]);
  });

  it('user 6: three columns in ascending version order, each with its own mark', () => {
    const u = user(org(model(), 'P4219 X'), USER_6);
    expect(u.columns.map((c) => [c.version, c.mark])).toEqual([
      [4, 'released'],
      [5, 'test-this-org'],
      [999999, 'unknown'],
    ]);
    expect(u.columns.map((c) => c.submittedAt)).toEqual([
      '2026-11-11T18:47:02.172359+00:00',
      '2026-11-11T18:49:02.172359+00:00',
      '2026-11-11T18:50:02.172359+00:00',
    ]);
  });

  it('user 10: v1 released and bundled, v2 a test for another org', () => {
    const u = user(org(model(), 'P4219 X'), USER_10);
    expect(u.columns.map((c) => [c.version, c.mark, c.bundled])).toEqual([
      [1, 'released', true],
      [2, 'test-other-org', false],
    ]);
  });

  it('the same canary seen from org Z is a test for another org', () => {
    const u = user(org(model(), 'P4219 Z'), USER_13);
    expect(u.columns.map((c) => [c.version, c.mark])).toEqual([[5, 'test-other-org']]);
  });

  // DERIVED, not captured: the capture has no row whose org was the canary org but is no longer
  // pinned (the state after that version is released). The migration emits it: was_canary is
  // coalesce(s.canary_org = pg.org_id, false) and does not read the pin
  // (20261112130000_backlog_4219_learn_pilot_report.sql, the admin-list SELECT). The mark must
  // not come from the org's current pin.
  it('a test for this org stays marked after the org is unpinned', () => {
    const list = clone(ADMIN_LIST);
    for (const r of list.rows) {
      if (r.org_id === list.rows[2].org_id) {
        r.org_current_pin_version = null;
        r.org_current_pin_at = null;
      }
    }
    const x = org(model(list), 'P4219 X');
    expect(x.pin).toBeNull();
    expect(user(x, USER_6).columns.map((c) => c.mark)).toEqual(['released', 'test-this-org', 'unknown']);
  });

  it('versionMark precedence: this-org test, released, test elsewhere, unknown', () => {
    expect(versionMark({ version_was_canary_for_this_org: true, version_released: false })).toBe('test-this-org');
    expect(versionMark({ version_was_canary_for_this_org: false, version_released: true })).toBe('released');
    expect(versionMark({ version_was_canary_for_this_org: false, version_released: false })).toBe('test-other-org');
    expect(versionMark({ version_was_canary_for_this_org: false, version_released: null })).toBe('unknown');
  });

  it('truncated is passed through', () => {
    expect(model({ ...clone(ADMIN_LIST), truncated: true }).truncated).toBe(true);
  });
});

describe('A3b change vs the previous version', () => {
  it('user 10 detections 7 -> 1: the first column has no change, the second -6 (capture as-is)', () => {
    const r = row(user(org(model(), 'P4219 X'), USER_10), 'detections');
    expect(r.cells).toEqual([
      { kind: 'count', value: 7 },
      { kind: 'count', value: 1 },
    ]);
    expect(r.changes).toEqual([null, { kind: 'count', d: -6 }]);
  });

  // User 6's v5 report replaced by the desktop builder's real output (PR2_REPORT, recall 1/1, two
  // mailboxes), so the middle column differs from both neighbours.
  function withPr2() {
    const list = clone(ADMIN_LIST);
    const v5 = list.rows.find((r) => r.user_id === USER_6 && r.sender_rules_version === 5)!;
    (v5 as { report: unknown }).report = { ...clone(PR2_REPORT), sender_rules_version: 5 };
    return user(org(model(list), 'P4219 X'), USER_6);
  }

  it('each change is against the column to its left', () => {
    const r = row(withPr2(), 'recall');
    expect(r.cells).toEqual([
      { kind: 'kn', k: 2, n: 3 },
      { kind: 'kn', k: 1, n: 1 },
      { kind: 'kn', k: 2, n: 3 },
    ]);
    expect(r.changes).toEqual([null, { kind: 'kn', dk: -1, dn: -2 }, { kind: 'kn', dk: 1, dn: 2 }]);
  });

  it('a mailbox only one version has: empty cells elsewhere and no change next to them', () => {
    const u = withPr2();
    const ids = u.rows.map((r) => r.id);
    expect(ids).toContain('learn_questions.2.hidden');
    const r = row(u, 'learn_questions.2.hidden');
    expect(r.cells[0]).toBeNull();
    expect(r.cells[1]).not.toBeNull();
    expect(r.cells[2]).toBeNull();
    expect(r.changes).toEqual([null, null, null]);
  });

  it('census rows: one per signal per mailbox, plus the bulk sample and real-estate rows', () => {
    const u = user(org(model(), 'P4219 X'), USER_6);
    expect(row(u, 'learn_questions.1.bulkHeaders').cells).toEqual([1, 1, 1].map((value) => ({ kind: 'count', value })));
    expect(row(u, 'detector.1.hidden').cells).toEqual([0, 0, 0].map((k) => ({ kind: 'kn', k, n: 40 })));
    expect(row(u, 'learn_questions.bulk_caught').cells[0]).toEqual({ kind: 'kn', k: 3, n: 10 });
    expect(row(u, 'detector.real_estate_suppressed').cells[0]).toEqual({ kind: 'kn', k: 0, n: 10 });
  });
});
