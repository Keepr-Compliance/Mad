/**
 * Reports index summary helpers (pure) — BACKLOG-3513 PR-3g.
 * Inputs are parseShareState output (share_list shape: migration 20261112200000).
 */

import { formatUpdated, myReportSummary, sharedWithMeSummary, sortByUpdated } from '@/lib/reports/definitions/summary';
import type { ShareState } from '@/lib/reports/definitions/parse';

const NOW = new Date('2026-11-14T15:00:00Z');
const person = (id: string) => ({ kind: 'person' as const, id, name: `P ${id}`, level: 'viewer' as const });
const role = (id: string, name: string) => ({ kind: 'role' as const, id, name, level: 'viewer' as const });
const s = (generalAccess: ShareState['generalAccess'], rowScope: ShareState['rowScope'], entries: ShareState['entries']) => ({
  generalAccess,
  rowScope,
  entries,
});

describe('myReportSummary', () => {
  it('unknown sharing -> null (never "Only you")', () => {
    expect(myReportSummary(null, 'Maple Realty')).toBeNull();
  });
  it('restricted, no entries -> "Only you", whatever the row scope', () => {
    expect(myReportSummary(s('restricted', 'all', []), 'Maple Realty')).toBe('Only you');
    expect(myReportSummary(s('restricted', 'own', []), 'Maple Realty')).toBe('Only you');
  });
  it('roles in reply order, then the people count', () => {
    expect(myReportSummary(s('restricted', 'all', [role('agent', 'All agents'), role('broker', 'All brokers'), person('a'), person('b'), person('c')]), 'X')).toBe(
      'Shared with All agents and All brokers and 3 people'
    );
  });
  it('row scope own is appended only when shared', () => {
    expect(myReportSummary(s('restricted', 'own', [person('a')]), 'X')).toBe('Shared with 1 person · Each sees their own');
  });
  it('organization ignores the entries', () => {
    expect(myReportSummary(s('organization', 'all', [person('a'), role('agent', 'All agents')]), 'Maple Realty')).toBe(
      'Shared with everyone in Maple Realty'
    );
  });
});

describe('sharedWithMeSummary', () => {
  it('owner name, level and owner state', () => {
    expect(sharedWithMeSummary({ ownerName: 'Jordan Lee', level: 'editor', ownerState: null })).toBe('From Jordan Lee · Can edit');
    expect(sharedWithMeSummary({ ownerName: '  ', level: 'viewer', ownerState: 'gone' })).toBe(
      "From a former member · Can view · Owner's account removed"
    );
    expect(sharedWithMeSummary({ ownerName: 'Dana Pike', level: 'viewer', ownerState: 'deactivated' })).toBe(
      'From Dana Pike · Can view · Owner deactivated'
    );
  });
});

describe('formatUpdated', () => {
  it.each([[undefined], [null], [''], ['x'], ['2026-13-45'], [42]])('%p -> null', (v) => {
    expect(formatUpdated(v, NOW)).toBeNull();
  });
  it('today (UTC), another day, another year', () => {
    expect(formatUpdated('2026-11-14T00:00:01Z', NOW)).toBe('Updated today');
    expect(formatUpdated('2026-11-13T23:59:59Z', NOW)).toBe('Updated Nov 13');
    expect(formatUpdated('2026-11-10T10:00:00.123456+00:00', NOW)).toBe('Updated Nov 10');
    expect(formatUpdated('2025-11-14T10:00:00Z', NOW)).toBe('Updated Nov 14, 2025');
  });
});

describe('sortByUpdated', () => {
  it('newest first, unreadable or missing last in their original order', () => {
    const rows = [
      { id: 'garbage', updatedAt: 'x' },
      { id: 'old', updatedAt: '2026-11-01T00:00:00Z' },
      { id: 'none' },
      { id: 'new', updatedAt: '2026-11-14T00:00:00Z' },
      { id: 'mid', updatedAt: '2026-11-08T00:00:00Z' },
    ];
    expect(sortByUpdated(rows).map((r) => r.id)).toEqual(['new', 'mid', 'old', 'garbage', 'none']);
  });
});
