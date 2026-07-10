/**
 * Tests for sortProjects -- the pure, deterministic, stable project list sort
 * (BACKLOG-1902).
 *
 * Covers: every sort key in both directions, stability of equal-rank rows
 * (name-order tiebreaker survives direction toggles), non-mutation of input,
 * and graceful handling of a missing/unparseable created_at.
 */

import { describe, it, expect } from 'vitest';
import { sortProjects, type ProjectSortKey } from '../sortProjects';
import type { PmProject, ItemPriority, ProjectStatus } from '@/lib/pm-types';

/** Build a PmProject with sensible defaults; override only what a test cares about. */
function makeProject(overrides: Partial<PmProject> & { id: string }): PmProject {
  const base: PmProject = {
    id: overrides.id,
    name: overrides.id,
    description: null,
    status: 'active' as ProjectStatus,
    priority: 'medium' as ItemPriority,
    owner_id: null,
    sort_order: 0,
    deleted_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    item_count: 0,
    active_sprint_count: 0,
  };
  return { ...base, ...overrides };
}

const ids = (projects: PmProject[]) => projects.map((p) => p.id);

describe('sortProjects - name', () => {
  it('sorts case-insensitively A->Z ascending', () => {
    const input = [
      makeProject({ id: 'c', name: 'charlie' }),
      makeProject({ id: 'a', name: 'Alpha' }),
      makeProject({ id: 'b', name: 'bravo' }),
    ];
    expect(ids(sortProjects(input, 'name', 'asc'))).toEqual(['a', 'b', 'c']);
  });

  it('reverses to Z->A descending', () => {
    const input = [
      makeProject({ id: 'a', name: 'Alpha' }),
      makeProject({ id: 'b', name: 'bravo' }),
      makeProject({ id: 'c', name: 'charlie' }),
    ];
    expect(ids(sortProjects(input, 'name', 'desc'))).toEqual(['c', 'b', 'a']);
  });
});

describe('sortProjects - days_open', () => {
  // Older created_at => more days open.
  const older = makeProject({ id: 'older', name: 'z-older', created_at: '2020-01-01T00:00:00.000Z' });
  const newer = makeProject({ id: 'newer', name: 'a-newer', created_at: '2026-06-01T00:00:00.000Z' });

  it('asc = fewest days open first (newest created_at first)', () => {
    expect(ids(sortProjects([older, newer], 'days_open', 'asc'))).toEqual(['newer', 'older']);
  });

  it('desc = most days open first (oldest created_at first)', () => {
    expect(ids(sortProjects([newer, older], 'days_open', 'desc'))).toEqual(['older', 'newer']);
  });

  it('treats missing/unparseable created_at as fewest days open (asc-first)', () => {
    const bad = makeProject({ id: 'bad', name: 'bad', created_at: 'not-a-date' });
    const result = sortProjects([older, bad], 'days_open', 'asc');
    // bad -> ~0 days open, so it sorts before the genuinely old project.
    expect(ids(result)).toEqual(['bad', 'older']);
  });
});

describe('sortProjects - status', () => {
  it('asc follows lifecycle rank planned -> archived', () => {
    const input = [
      makeProject({ id: 'arch', name: 'a', status: 'archived' }),
      makeProject({ id: 'plan', name: 'b', status: 'planned' }),
      makeProject({ id: 'act', name: 'c', status: 'active' }),
      makeProject({ id: 'hold', name: 'd', status: 'on_hold' }),
      makeProject({ id: 'done', name: 'e', status: 'completed' }),
    ];
    expect(ids(sortProjects(input, 'status', 'asc'))).toEqual([
      'plan',
      'act',
      'hold',
      'done',
      'arch',
    ]);
  });

  it('desc reverses lifecycle rank', () => {
    const input = [
      makeProject({ id: 'plan', name: 'a', status: 'planned' }),
      makeProject({ id: 'arch', name: 'b', status: 'archived' }),
    ];
    expect(ids(sortProjects(input, 'status', 'desc'))).toEqual(['arch', 'plan']);
  });
});

describe('sortProjects - priority', () => {
  it('desc surfaces critical first', () => {
    const input = [
      makeProject({ id: 'low', name: 'a', priority: 'low' }),
      makeProject({ id: 'crit', name: 'b', priority: 'critical' }),
      makeProject({ id: 'med', name: 'c', priority: 'medium' }),
      makeProject({ id: 'high', name: 'd', priority: 'high' }),
    ];
    expect(ids(sortProjects(input, 'priority', 'desc'))).toEqual(['crit', 'high', 'med', 'low']);
  });

  it('asc surfaces lowest priority first', () => {
    const input = [
      makeProject({ id: 'crit', name: 'a', priority: 'critical' }),
      makeProject({ id: 'low', name: 'b', priority: 'low' }),
    ];
    expect(ids(sortProjects(input, 'priority', 'asc'))).toEqual(['low', 'crit']);
  });
});

describe('sortProjects - stability (equal-rank tiebreaker)', () => {
  // Three projects with the SAME priority but different names, given in a
  // scrambled input order. Equal-rank rows must fall back to name order and
  // that tiebreaker must NOT flip when the primary direction toggles.
  const equalRank = [
    makeProject({ id: 'z', name: 'Zeta', priority: 'high' }),
    makeProject({ id: 'a', name: 'Alpha', priority: 'high' }),
    makeProject({ id: 'm', name: 'Mike', priority: 'high' }),
  ];

  it('orders equal-priority rows by name regardless of input order (asc)', () => {
    expect(ids(sortProjects(equalRank, 'priority', 'asc'))).toEqual(['a', 'm', 'z']);
  });

  it('keeps the SAME name order for equal-priority rows when direction is desc', () => {
    // desc flips only the primary (priority) comparison; all rows are equal
    // rank here, so the name tiebreaker keeps A->Z -- no reshuffle.
    expect(ids(sortProjects(equalRank, 'priority', 'desc'))).toEqual(['a', 'm', 'z']);
  });

  it('breaks a name tie by id deterministically', () => {
    const sameName = [
      makeProject({ id: 'id-2', name: 'Same' }),
      makeProject({ id: 'id-1', name: 'Same' }),
    ];
    expect(ids(sortProjects(sameName, 'name', 'asc'))).toEqual(['id-1', 'id-2']);
    // Tiebreaker stays ascending even when the primary direction is desc.
    expect(ids(sortProjects(sameName, 'name', 'desc'))).toEqual(['id-1', 'id-2']);
  });
});

describe('sortProjects - purity', () => {
  it('does not mutate the input array', () => {
    const input = [
      makeProject({ id: 'b', name: 'bravo' }),
      makeProject({ id: 'a', name: 'alpha' }),
    ];
    const snapshot = ids(input);
    sortProjects(input, 'name', 'asc');
    expect(ids(input)).toEqual(snapshot);
  });

  it('returns an empty array unchanged', () => {
    expect(sortProjects([], 'name', 'asc')).toEqual([]);
  });
});

// Exhaustiveness guard: every key value is exercised above.
const ALL_KEYS: ProjectSortKey[] = ['name', 'days_open', 'status', 'priority'];
describe('sortProjects - key coverage', () => {
  it.each(ALL_KEYS)('handles a single-element list for key "%s"', (key) => {
    const one = [makeProject({ id: 'only', name: 'Only' })];
    expect(ids(sortProjects(one, key, 'asc'))).toEqual(['only']);
    expect(ids(sortProjects(one, key, 'desc'))).toEqual(['only']);
  });
});
