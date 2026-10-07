/**
 * lib/checklists/audit.ts — date/time formatting (BACKLOG-3474 PR 4).
 *
 * jest.config.js pins process.env.TZ to 'America/Los_Angeles' for the whole
 * broker-portal suite (NOT here, and NOT in a per-test beforeAll — see the
 * comment there for why a per-test assignment silently does nothing under
 * jest-environment-jsdom).
 *
 * The fixture below deliberately straddles the UTC/Pacific day boundary:
 * 2026-09-25T02:00:00Z is already "Sep 25" in UTC, but only 7:00 PM "Sep 24"
 * in Pacific (UTC-7 in September). formatAuditDate must return the UTC date
 * (it is the pre-mount render, which has to match what the server — Vercel,
 * UTC — sent) and formatAuditDateTime must return the viewer's local time
 * (it only ever runs post-mount, in the browser). If either formatter used
 * the wrong zone, this fixture is exactly where that would show up — a
 * same-zone-for-both fixture would not catch it.
 */

import { formatAuditDate, formatAuditDateTime, auditText, type AuditEntry } from '@/lib/checklists/audit';

const BOUNDARY = '2026-09-25T02:00:00+00:00';

describe('formatAuditDate', () => {
  it('formats in UTC regardless of the viewer/process timezone', () => {
    expect(formatAuditDate(BOUNDARY)).toBe('Sep 25, 2026');
  });

  it('returns "" for null, undefined, and an unparseable value', () => {
    expect(formatAuditDate(null)).toBe('');
    expect(formatAuditDate(undefined)).toBe('');
    expect(formatAuditDate('not-a-date')).toBe('');
  });
});

describe('formatAuditDateTime', () => {
  it("formats in the viewer's local timezone, not UTC", () => {
    expect(formatAuditDateTime(BOUNDARY)).toBe('Sep 24, 2026, 7:00 PM');
  });

  it('returns "" for null, undefined, and an unparseable value', () => {
    expect(formatAuditDateTime(null)).toBe('');
    expect(formatAuditDateTime(undefined)).toBe('');
    expect(formatAuditDateTime('not-a-date')).toBe('');
  });
});

describe('auditText', () => {
  const entry: AuditEntry = { at: BOUNDARY, by: 'Jane Doe' };

  it('defaults to the UTC date (withTime omitted)', () => {
    expect(auditText('Created', entry)).toBe('Created Sep 25, 2026 by Jane Doe');
  });

  it('shows the local date + time when withTime is true', () => {
    expect(auditText('Created', entry, true)).toBe('Created Sep 24, 2026, 7:00 PM by Jane Doe');
  });

  it('returns "" when there is no date, regardless of withTime', () => {
    const noDate: AuditEntry = { at: null, by: 'Jane Doe' };
    expect(auditText('Created', noDate)).toBe('');
    expect(auditText('Created', noDate, true)).toBe('');
  });
});
