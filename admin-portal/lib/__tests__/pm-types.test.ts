import {
  ALLOWED_TRANSITIONS,
  STATUS_LABELS,
  STATUS_COLORS,
  PRIORITY_LABELS,
  PRIORITY_COLORS,
  TYPE_LABELS,
  TYPE_COLORS,
  SPRINT_STATUS_LABELS,
  SPRINT_STATUS_COLORS,
} from '../pm-types';
import type { ItemStatus, ItemPriority, ItemType, SprintStatus } from '../pm-types';

// ---------------------------------------------------------------------------
// Canonical enum values (source of truth for completeness checks)
// ---------------------------------------------------------------------------

const ALL_ITEM_STATUSES: ItemStatus[] = [
  'pending',
  'in_progress',
  'testing',
  'pending_uat',
  'completed',
  'blocked',
  'deferred',
  'obsolete',
  'reopened',
  'waiting_for_user',
];

const ALL_PRIORITIES: ItemPriority[] = ['low', 'medium', 'high', 'critical'];

const ALL_ITEM_TYPES: ItemType[] = ['feature', 'bug', 'chore', 'spike', 'epic'];

const ALL_SPRINT_STATUSES: SprintStatus[] = [
  'planned',
  'active',
  'completed',
  'cancelled',
];

// ---------------------------------------------------------------------------
// ALLOWED_TRANSITIONS
// ---------------------------------------------------------------------------

describe('ALLOWED_TRANSITIONS', () => {
  it('has an entry for every ItemStatus', () => {
    for (const status of ALL_ITEM_STATUSES) {
      expect(ALLOWED_TRANSITIONS).toHaveProperty(status);
    }
  });

  it('has exactly the expected set of keys (no extra statuses)', () => {
    const keys = Object.keys(ALLOWED_TRANSITIONS).sort();
    expect(keys).toEqual([...ALL_ITEM_STATUSES].sort());
  });

  it('every transition target is itself a valid ItemStatus', () => {
    for (const [source, targets] of Object.entries(ALLOWED_TRANSITIONS)) {
      for (const target of targets) {
        expect(ALL_ITEM_STATUSES).toContain(target);
      }
      // A status should never transition to itself
      expect(targets).not.toContain(source);
    }
  });

  it('obsolete has no allowed transitions', () => {
    expect(ALLOWED_TRANSITIONS.obsolete).toEqual([]);
  });

  it('completed can only transition to reopened', () => {
    expect(ALLOWED_TRANSITIONS.completed).toEqual(['reopened']);
  });
});

// ---------------------------------------------------------------------------
// STATUS_LABELS / STATUS_COLORS
// ---------------------------------------------------------------------------

describe('STATUS_LABELS', () => {
  it('has an entry for every ItemStatus', () => {
    for (const status of ALL_ITEM_STATUSES) {
      expect(STATUS_LABELS).toHaveProperty(status);
      expect(typeof STATUS_LABELS[status]).toBe('string');
      expect(STATUS_LABELS[status].length).toBeGreaterThan(0);
    }
  });

  it('has no extra keys', () => {
    expect(Object.keys(STATUS_LABELS).sort()).toEqual([...ALL_ITEM_STATUSES].sort());
  });
});

describe('STATUS_COLORS', () => {
  it('has an entry for every ItemStatus', () => {
    for (const status of ALL_ITEM_STATUSES) {
      expect(STATUS_COLORS).toHaveProperty(status);
      expect(typeof STATUS_COLORS[status]).toBe('string');
      expect(STATUS_COLORS[status].length).toBeGreaterThan(0);
    }
  });

  it('has no extra keys', () => {
    expect(Object.keys(STATUS_COLORS).sort()).toEqual([...ALL_ITEM_STATUSES].sort());
  });

  it('each color value looks like a Tailwind class string', () => {
    for (const color of Object.values(STATUS_COLORS)) {
      expect(color).toMatch(/^bg-\w+-\d+/);
    }
  });
});

// ---------------------------------------------------------------------------
// PRIORITY_LABELS / PRIORITY_COLORS
// ---------------------------------------------------------------------------

describe('PRIORITY_LABELS', () => {
  it('has an entry for every ItemPriority', () => {
    for (const p of ALL_PRIORITIES) {
      expect(PRIORITY_LABELS).toHaveProperty(p);
      expect(typeof PRIORITY_LABELS[p]).toBe('string');
      expect(PRIORITY_LABELS[p].length).toBeGreaterThan(0);
    }
  });

  it('has no extra keys', () => {
    expect(Object.keys(PRIORITY_LABELS).sort()).toEqual([...ALL_PRIORITIES].sort());
  });
});

describe('PRIORITY_COLORS', () => {
  it('has an entry for every ItemPriority', () => {
    for (const p of ALL_PRIORITIES) {
      expect(PRIORITY_COLORS).toHaveProperty(p);
      expect(typeof PRIORITY_COLORS[p]).toBe('string');
    }
  });

  it('has no extra keys', () => {
    expect(Object.keys(PRIORITY_COLORS).sort()).toEqual([...ALL_PRIORITIES].sort());
  });
});

// ---------------------------------------------------------------------------
// TYPE_LABELS / TYPE_COLORS
// ---------------------------------------------------------------------------

describe('TYPE_LABELS', () => {
  it('has an entry for every ItemType', () => {
    for (const t of ALL_ITEM_TYPES) {
      expect(TYPE_LABELS).toHaveProperty(t);
      expect(typeof TYPE_LABELS[t]).toBe('string');
      expect(TYPE_LABELS[t].length).toBeGreaterThan(0);
    }
  });

  it('has no extra keys', () => {
    expect(Object.keys(TYPE_LABELS).sort()).toEqual([...ALL_ITEM_TYPES].sort());
  });
});

describe('TYPE_COLORS', () => {
  it('has an entry for every ItemType', () => {
    for (const t of ALL_ITEM_TYPES) {
      expect(TYPE_COLORS).toHaveProperty(t);
      expect(typeof TYPE_COLORS[t]).toBe('string');
    }
  });

  it('has no extra keys', () => {
    expect(Object.keys(TYPE_COLORS).sort()).toEqual([...ALL_ITEM_TYPES].sort());
  });
});

// ---------------------------------------------------------------------------
// SPRINT_STATUS_LABELS / SPRINT_STATUS_COLORS
// ---------------------------------------------------------------------------

describe('SPRINT_STATUS_LABELS', () => {
  it('has an entry for every SprintStatus', () => {
    for (const s of ALL_SPRINT_STATUSES) {
      expect(SPRINT_STATUS_LABELS).toHaveProperty(s);
      expect(typeof SPRINT_STATUS_LABELS[s]).toBe('string');
    }
  });

  it('has no extra keys', () => {
    expect(Object.keys(SPRINT_STATUS_LABELS).sort()).toEqual(
      [...ALL_SPRINT_STATUSES].sort(),
    );
  });
});

describe('SPRINT_STATUS_COLORS', () => {
  it('has an entry for every SprintStatus', () => {
    for (const s of ALL_SPRINT_STATUSES) {
      expect(SPRINT_STATUS_COLORS).toHaveProperty(s);
      expect(typeof SPRINT_STATUS_COLORS[s]).toBe('string');
    }
  });

  it('has no extra keys', () => {
    expect(Object.keys(SPRINT_STATUS_COLORS).sort()).toEqual(
      [...ALL_SPRINT_STATUSES].sort(),
    );
  });
});
