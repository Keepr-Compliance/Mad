/**
 * Analytics query attribution tests (BACKLOG-3201).
 *
 * The defect these pin: getVersionDistribution and getPlatformBreakdown bucketed
 * per DEVICE row, so a user with two active devices on different versions (or
 * different platforms) landed in two buckets while the denominator stayed
 * "distinct users" — and the Adoption column summed above 100%.
 *
 * ALL FIXTURES ARE SYNTHETIC. This repository is public; every user id, email,
 * display name and device version below is invented for these tests and
 * corresponds to nothing in any live system.
 *
 * The stub client is a small in-memory Postgres stand-in rather than a
 * canned-response mock. That matters for the period boundary sweep: the cutoff
 * is applied by `.gte('last_seen_at', daysAgo(days))` inside the query function,
 * so a stub that ignored filters would let a broken cutoff pass. This one
 * records eq/gte/in and applies them, which means the sweep exercises the real
 * daysAgo() + .gte wiring.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getVersionDistribution,
  getPlatformBreakdown,
  pickMostRecentDevicePerUser,
} from '../analytics-queries';

// ─── Synthetic fixtures ───────────────────────────────────────────

const ACCOUNT_A = '00000000-0000-4000-8000-000000000001'; // pii-allow-uuid: an all-zero counter, invented for this file; matches no live row
const ACCOUNT_B = '00000000-0000-4000-8000-000000000002'; // pii-allow-uuid: an all-zero counter, invented for this file; matches no live row
const ACCOUNT_C = '00000000-0000-4000-8000-000000000003'; // pii-allow-uuid: an all-zero counter, invented for this file; matches no live row

// Display names are deliberately NOT person-shaped. A first-plus-last name on a
// line that also carries an id is the identity-row shape the repo's fixture-PII
// gate blocks, and this repository is public.
const USERS = [
  { id: ACCOUNT_A, email: 'account-a@example.test', display_name: 'Fixture Account A' },
  { id: ACCOUNT_B, email: 'account-b@example.test', display_name: 'Fixture Account B' },
  { id: ACCOUNT_C, email: 'account-c@example.test', display_name: 'Fixture Account C' },
];

interface DeviceRow {
  user_id: string;
  app_version: string | null;
  platform: string | null;
  last_seen_at: string | null;
  is_active: boolean;
}

function device(over: Partial<DeviceRow> & { user_id: string }): DeviceRow {
  return {
    app_version: '2.9.1',
    platform: 'darwin',
    last_seen_at: '2026-09-06T12:00:00.000Z',
    is_active: true,
    ...over,
  };
}

// ─── In-memory stub client ────────────────────────────────────────

type Filter = (row: Record<string, unknown>) => boolean;

/**
 * Minimal thenable query builder. `getVersionDistribution` awaits the builder
 * itself (there is no terminal `.single()`), so `then` is where the filters are
 * applied and `{ data, error }` is produced.
 */
function stubClient(tables: {
  devices: DeviceRow[];
  users: typeof USERS;
}): SupabaseClient {
  const from = (table: string) => {
    // The two fixture shapes are structurally fine as row bags; the cast is
    // only to satisfy the index-signature requirement of Record.
    const rows = (
      table === 'devices' ? [...tables.devices] : [...tables.users]
    ) as unknown as Record<string, unknown>[];
    const filters: Filter[] = [];

    const builder = {
      select: () => builder,
      eq: (col: string, value: unknown) => {
        filters.push((r) => r[col] === value);
        return builder;
      },
      gte: (col: string, value: string) => {
        // Mirrors Postgres timestamptz >=: inclusive at the bound, and a NULL
        // never satisfies a comparison.
        filters.push((r) => {
          const v = r[col];
          return typeof v === 'string' && Date.parse(v) >= Date.parse(value);
        });
        return builder;
      },
      // Implemented purely so that mutating the query's `.gte` to `.gt` is
      // measurable as a failing boundary assertion rather than as a TypeError
      // that reds the whole file and tells you nothing.
      gt: (col: string, value: string) => {
        filters.push((r) => {
          const v = r[col];
          return typeof v === 'string' && Date.parse(v) > Date.parse(value);
        });
        return builder;
      },
      in: (col: string, values: unknown[]) => {
        filters.push((r) => values.includes(r[col]));
        return builder;
      },
      then: (
        resolve: (v: { data: Record<string, unknown>[]; error: null }) => unknown
      ) => resolve({ data: rows.filter((r) => filters.every((f) => f(r))), error: null }),
    };
    return builder;
  };

  return { from } as unknown as SupabaseClient;
}

/** Sum of a distribution's user_count column. */
function totalCounted(rows: { user_count: number }[]): number {
  return rows.reduce((sum, r) => sum + r.user_count, 0);
}

function userIdsOn(
  rows: { app_version: string; users: { id: string }[] }[],
  version: string
): string[] {
  return (rows.find((r) => r.app_version === version)?.users ?? [])
    .map((u) => u.id)
    .sort();
}

// ─── 1. Version dedup ─────────────────────────────────────────────

describe('getVersionDistribution — recent mode attributes a user to one version', () => {
  // Account A upgraded: its newer device reports 2.11.0, its older one 2.10.0.
  // Account B has a single device on 2.10.0.
  const devices = [
    device({ user_id: ACCOUNT_A, app_version: '2.10.0', last_seen_at: '2026-09-01T09:00:00.000Z' }),
    device({ user_id: ACCOUNT_A, app_version: '2.11.0', last_seen_at: '2026-09-04T09:00:00.000Z' }),
    device({ user_id: ACCOUNT_B, app_version: '2.10.0', last_seen_at: '2026-09-05T09:00:00.000Z' }),
  ];

  it('places the user only under the version of their newest device', async () => {
    const result = await getVersionDistribution(stubClient({ devices, users: USERS }), 30);

    // Identity, not counts: Account A must be absent from 2.10.0 entirely.
    expect(userIdsOn(result, '2.10.0')).toEqual([ACCOUNT_B]);
    expect(userIdsOn(result, '2.11.0')).toEqual([ACCOUNT_A]);
  });

  it('sums user_count to the distinct active-user count', async () => {
    const result = await getVersionDistribution(stubClient({ devices, users: USERS }), 30);
    const distinctUsers = new Set(devices.map((d) => d.user_id)).size;

    expect(distinctUsers).toBe(2);
    expect(totalCounted(result)).toBe(distinctUsers);
  });

  it('sums adoption to 100%', async () => {
    const result = await getVersionDistribution(stubClient({ devices, users: USERS }), 30);
    const adoption = result.reduce((sum, r) => sum + r.adoption_pct, 0);
    expect(adoption).toBeGreaterThanOrEqual(99);
    expect(adoption).toBeLessThanOrEqual(101);
  });
});

// ─── 2. Semver tie-break ──────────────────────────────────────────

describe('getVersionDistribution — tie-break on identical last_seen_at', () => {
  const SAME_INSTANT = '2026-09-04T09:00:00.000Z';

  it('picks 2.10.1 over 2.9.1 (numeric compare, not lexicographic)', async () => {
    // A string compare would put "2.9.1" above "2.10.1"; this is the case that
    // separates the two.
    const devices = [
      device({ user_id: ACCOUNT_A, app_version: '2.9.1', last_seen_at: SAME_INSTANT }),
      device({ user_id: ACCOUNT_A, app_version: '2.10.1', last_seen_at: SAME_INSTANT }),
    ];
    const result = await getVersionDistribution(stubClient({ devices, users: USERS }), 30);

    expect(userIdsOn(result, '2.10.1')).toEqual([ACCOUNT_A]);
    expect(result.find((r) => r.app_version === '2.9.1')).toBeUndefined();
  });

  it('picks 2.10.1 regardless of the order the rows arrive in', async () => {
    const devices = [
      device({ user_id: ACCOUNT_A, app_version: '2.10.1', last_seen_at: SAME_INSTANT }),
      device({ user_id: ACCOUNT_A, app_version: '2.9.1', last_seen_at: SAME_INSTANT }),
    ];
    const result = await getVersionDistribution(stubClient({ devices, users: USERS }), 30);
    expect(userIdsOn(result, '2.10.1')).toEqual([ACCOUNT_A]);
    expect(result.find((r) => r.app_version === '2.9.1')).toBeUndefined();
  });

  it('prefers a reported version over a null one at the same instant', async () => {
    const devices = [
      device({ user_id: ACCOUNT_A, app_version: null, last_seen_at: SAME_INSTANT }),
      device({ user_id: ACCOUNT_A, app_version: '2.10.1', last_seen_at: SAME_INSTANT }),
    ];
    const result = await getVersionDistribution(stubClient({ devices, users: USERS }), 30);

    expect(userIdsOn(result, '2.10.1')).toEqual([ACCOUNT_A]);
    expect(result.find((r) => r.app_version === 'Unknown')).toBeUndefined();
  });
});

// ─── 3. Null version on the newest device wins ────────────────────

describe('getVersionDistribution — a null version on the newest device wins', () => {
  it('reports Unknown even though an older device of theirs has a version', async () => {
    // Documented, deliberate decision: the card answers "what is this user
    // running now", and when the newest device does not say, the answer is
    // "we do not know" — NOT the older device's version.
    const devices = [
      device({ user_id: ACCOUNT_A, app_version: '2.10.0', last_seen_at: '2026-09-01T09:00:00.000Z' }),
      device({ user_id: ACCOUNT_A, app_version: null, last_seen_at: '2026-09-04T09:00:00.000Z' }),
    ];
    const result = await getVersionDistribution(stubClient({ devices, users: USERS }), 30);

    expect(userIdsOn(result, 'Unknown')).toEqual([ACCOUNT_A]);
    expect(result.find((r) => r.app_version === '2.10.0')).toBeUndefined();
  });

  it('sorts Unknown to the end of the table', async () => {
    const devices = [
      device({ user_id: ACCOUNT_A, app_version: null }),
      device({ user_id: ACCOUNT_B, app_version: '2.10.0' }),
      device({ user_id: ACCOUNT_C, app_version: '2.9.1' }),
    ];
    const result = await getVersionDistribution(stubClient({ devices, users: USERS }), 30);
    expect(result.map((r) => r.app_version)).toEqual(['2.9.1', '2.10.0', 'Unknown']);
  });
});

// ─── 4. Period boundary sweep ─────────────────────────────────────

describe('getVersionDistribution — period cutoff boundary', () => {
  /**
   * The clock is frozen for this block. Without that, `daysAgo()` moves a few
   * milliseconds between building a fixture and running the query, so "exactly
   * at the cutoff" cannot be expressed — and the difference between `>=` and
   * `>` at the bound, which is the only thing an inclusive/exclusive mistake
   * shows up as, becomes untestable.
   */
  const FROZEN_NOW = new Date('2026-09-07T12:00:00.000Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** The cutoff the query computes, under the frozen clock. */
  function cutoff(days: number): number {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.getTime();
  }

  function at(offsetMs: number, days = 30): string {
    return new Date(cutoff(days) + offsetMs).toISOString();
  }

  it('includes a device exactly at the cutoff', async () => {
    const devices = [device({ user_id: ACCOUNT_A, app_version: '2.10.0', last_seen_at: at(0) })];
    const result = await getVersionDistribution(stubClient({ devices, users: USERS }), 30);
    expect(userIdsOn(result, '2.10.0')).toEqual([ACCOUNT_A]);
  });

  it('includes a device one millisecond inside the cutoff', async () => {
    const devices = [device({ user_id: ACCOUNT_A, app_version: '2.10.0', last_seen_at: at(1) })];
    const result = await getVersionDistribution(stubClient({ devices, users: USERS }), 30);
    expect(userIdsOn(result, '2.10.0')).toEqual([ACCOUNT_A]);
  });

  it('excludes a device one millisecond outside the cutoff', async () => {
    const devices = [device({ user_id: ACCOUNT_A, app_version: '2.10.0', last_seen_at: at(-1) })];
    const result = await getVersionDistribution(stubClient({ devices, users: USERS }), 30);
    expect(result).toEqual([]);
  });

  it('includes a device well inside the window', async () => {
    const devices = [
      device({ user_id: ACCOUNT_A, app_version: '2.10.0', last_seen_at: at(60 * 60 * 1000) }),
    ];
    const result = await getVersionDistribution(stubClient({ devices, users: USERS }), 30);
    expect(userIdsOn(result, '2.10.0')).toEqual([ACCOUNT_A]);
  });

  it('excludes a device well outside the window', async () => {
    const devices = [
      device({ user_id: ACCOUNT_A, app_version: '2.10.0', last_seen_at: at(-60 * 60 * 1000) }),
    ];
    const result = await getVersionDistribution(stubClient({ devices, users: USERS }), 30);
    expect(result).toEqual([]);
  });

  it('sweeps the boundary for every selectable period', async () => {
    // The card offers 24h / 7d / 30d / 90d. One sampled period cannot catch a
    // cutoff that is right for 30 and wrong for 1.
    for (const days of [1, 7, 30, 90]) {
      const inside = [
        device({ user_id: ACCOUNT_A, app_version: '2.10.0', last_seen_at: at(0, days) }),
      ];
      const outside = [
        device({ user_id: ACCOUNT_A, app_version: '2.10.0', last_seen_at: at(-1, days) }),
      ];

      expect(
        userIdsOn(
          await getVersionDistribution(stubClient({ devices: inside, users: USERS }), days),
          '2.10.0'
        )
      ).toEqual([ACCOUNT_A]);
      expect(
        await getVersionDistribution(stubClient({ devices: outside, users: USERS }), days)
      ).toEqual([]);
    }
  });

  it('narrowing the period drops a device that a wider period keeps', async () => {
    // Seen 10 days ago: inside 30d, outside 7d. Proves `days` is actually used
    // and not pinned to a constant.
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const devices = [
      device({ user_id: ACCOUNT_A, app_version: '2.10.0', last_seen_at: tenDaysAgo }),
    ];

    const wide = await getVersionDistribution(stubClient({ devices, users: USERS }), 30);
    const narrow = await getVersionDistribution(stubClient({ devices, users: USERS }), 7);

    expect(userIdsOn(wide, '2.10.0')).toEqual([ACCOUNT_A]);
    expect(narrow).toEqual([]);
  });

  it('excludes inactive devices in both modes', async () => {
    const devices = [
      device({ user_id: ACCOUNT_A, app_version: '2.10.0', is_active: false }),
      device({ user_id: ACCOUNT_B, app_version: '2.10.0' }),
    ];
    for (const mode of ['recent', 'cumulative'] as const) {
      const result = await getVersionDistribution(
        stubClient({ devices, users: USERS }),
        30,
        mode
      );
      expect(userIdsOn(result, '2.10.0')).toEqual([ACCOUNT_B]);
    }
  });
});

// ─── 5. The two modes must produce different numbers ──────────────

describe('getVersionDistribution — recent vs cumulative on one fixture', () => {
  // Account A spans two versions; Account B is on one. Cumulative counts A twice.
  const devices = [
    device({ user_id: ACCOUNT_A, app_version: '2.10.0', last_seen_at: '2026-09-01T09:00:00.000Z' }),
    device({ user_id: ACCOUNT_A, app_version: '2.11.0', last_seen_at: '2026-09-04T09:00:00.000Z' }),
    device({ user_id: ACCOUNT_B, app_version: '2.10.0', last_seen_at: '2026-09-05T09:00:00.000Z' }),
  ];

  it('cumulative returns the spanning user under BOTH versions', async () => {
    const result = await getVersionDistribution(
      stubClient({ devices, users: USERS }),
      30,
      'cumulative'
    );
    expect(userIdsOn(result, '2.10.0')).toEqual([ACCOUNT_A, ACCOUNT_B].sort());
    expect(userIdsOn(result, '2.11.0')).toEqual([ACCOUNT_A]);
  });

  it('cumulative totals exceed the distinct-user count', async () => {
    const result = await getVersionDistribution(
      stubClient({ devices, users: USERS }),
      30,
      'cumulative'
    );
    const distinctUsers = new Set(devices.map((d) => d.user_id)).size;
    expect(totalCounted(result)).toBe(3);
    expect(totalCounted(result)).toBeGreaterThan(distinctUsers);
    expect(result.reduce((s, r) => s + r.adoption_pct, 0)).toBeGreaterThan(100);
  });

  it('the two modes disagree on the same fixture', async () => {
    // Without this, the cumulative assertions above would still pass if the
    // toggle did nothing at all and both modes rendered identical numbers.
    const recent = await getVersionDistribution(
      stubClient({ devices, users: USERS }),
      30,
      'recent'
    );
    const cumulative = await getVersionDistribution(
      stubClient({ devices, users: USERS }),
      30,
      'cumulative'
    );

    expect(totalCounted(recent)).toBe(2);
    expect(totalCounted(cumulative)).toBe(3);
    expect(totalCounted(recent)).not.toBe(totalCounted(cumulative));
  });

  it('defaults to recent when no mode is given', async () => {
    const explicit = await getVersionDistribution(
      stubClient({ devices, users: USERS }),
      30,
      'recent'
    );
    const implicit = await getVersionDistribution(stubClient({ devices, users: USERS }), 30);
    expect(implicit).toEqual(explicit);
  });

  it('counts a user once when both their devices are on the same version', async () => {
    // Cumulative is per-bucket-distinct-users, not per-device: two machines on
    // the same version are still one user on that version.
    const sameVersion = [
      device({ user_id: ACCOUNT_A, app_version: '2.11.0', last_seen_at: '2026-09-01T09:00:00.000Z' }),
      device({ user_id: ACCOUNT_A, app_version: '2.11.0', last_seen_at: '2026-09-04T09:00:00.000Z' }),
    ];
    const result = await getVersionDistribution(
      stubClient({ devices: sameVersion, users: USERS }),
      30,
      'cumulative'
    );
    expect(totalCounted(result)).toBe(1);
  });
});

// ─── 6. Platform card, same pair ──────────────────────────────────

function platformCount(rows: { platform: string; user_count: number }[], platform: string) {
  return rows.find((r) => r.platform === platform)?.user_count ?? 0;
}

describe('getPlatformBreakdown — mode toggle', () => {
  // Account A runs a Mac and a PC; the PC is the more recently seen.
  const devices = [
    device({
      user_id: ACCOUNT_A,
      platform: 'darwin',
      app_version: '2.10.0',
      last_seen_at: '2026-09-01T09:00:00.000Z',
    }),
    device({
      user_id: ACCOUNT_A,
      platform: 'win32',
      app_version: '2.11.0',
      last_seen_at: '2026-09-04T09:00:00.000Z',
    }),
    device({
      user_id: ACCOUNT_B,
      platform: 'darwin',
      app_version: '2.10.0',
      last_seen_at: '2026-09-05T09:00:00.000Z',
    }),
  ];

  it('recent mode counts the spanning user only on their newest platform', async () => {
    const result = await getPlatformBreakdown(stubClient({ devices, users: USERS }));
    expect(platformCount(result, 'win32')).toBe(1); // Account A
    expect(platformCount(result, 'darwin')).toBe(1); // Account B only
    expect(totalCounted(result)).toBe(2);
    expect(result.reduce((s, r) => s + r.pct, 0)).toBeLessThanOrEqual(101);
  });

  it('cumulative mode counts the spanning user on both platforms', async () => {
    const result = await getPlatformBreakdown(
      stubClient({ devices, users: USERS }),
      'cumulative'
    );
    expect(platformCount(result, 'win32')).toBe(1);
    expect(platformCount(result, 'darwin')).toBe(2); // Account A AND Account B
    expect(totalCounted(result)).toBe(3);
    expect(result.reduce((s, r) => s + r.pct, 0)).toBeGreaterThan(100);
  });

  it('the two modes disagree on the same fixture', async () => {
    const recent = await getPlatformBreakdown(stubClient({ devices, users: USERS }), 'recent');
    const cumulative = await getPlatformBreakdown(
      stubClient({ devices, users: USERS }),
      'cumulative'
    );
    expect(totalCounted(recent)).not.toBe(totalCounted(cumulative));
    expect(platformCount(recent, 'darwin')).not.toBe(platformCount(cumulative, 'darwin'));
  });

  it('breaks a platform tie by semver, the same rule as the version card', async () => {
    const SAME_INSTANT = '2026-09-04T09:00:00.000Z';
    const tied = [
      device({
        user_id: ACCOUNT_C,
        platform: 'darwin',
        app_version: '2.9.1',
        last_seen_at: SAME_INSTANT,
      }),
      device({
        user_id: ACCOUNT_C,
        platform: 'win32',
        app_version: '2.10.1',
        last_seen_at: SAME_INSTANT,
      }),
    ];
    const result = await getPlatformBreakdown(stubClient({ devices: tied, users: USERS }));
    expect(platformCount(result, 'win32')).toBe(1);
    expect(platformCount(result, 'darwin')).toBe(0);
  });

  it('labels a missing platform Unknown', async () => {
    const unlabelled = [device({ user_id: ACCOUNT_A, platform: null })];
    const result = await getPlatformBreakdown(stubClient({ devices: unlabelled, users: USERS }));
    expect(platformCount(result, 'Unknown')).toBe(1);
  });
});

// ─── 7. The attribution helper directly ───────────────────────────

describe('pickMostRecentDevicePerUser', () => {
  it('returns one row per user', () => {
    const rows = [
      { user_id: ACCOUNT_A, last_seen_at: '2026-09-01T00:00:00.000Z', app_version: '2.10.0' },
      { user_id: ACCOUNT_A, last_seen_at: '2026-09-02T00:00:00.000Z', app_version: '2.11.0' },
      { user_id: ACCOUNT_B, last_seen_at: '2026-09-03T00:00:00.000Z', app_version: '2.10.0' },
    ];
    const picked = pickMostRecentDevicePerUser(rows);
    expect(picked).toHaveLength(2);
    expect(picked.find((r) => r.user_id === ACCOUNT_A)?.app_version).toBe('2.11.0');
  });

  it('treats a null last_seen_at as the oldest possible', () => {
    const rows = [
      { user_id: ACCOUNT_A, last_seen_at: null, app_version: '2.11.0' },
      { user_id: ACCOUNT_A, last_seen_at: '2026-01-01T00:00:00.000Z', app_version: '2.10.0' },
    ];
    expect(pickMostRecentDevicePerUser(rows)[0].app_version).toBe('2.10.0');
  });

  it('keeps a null-last_seen_at row when it is the only one', () => {
    const rows = [{ user_id: ACCOUNT_A, last_seen_at: null, app_version: '2.11.0' }];
    expect(pickMostRecentDevicePerUser(rows)).toHaveLength(1);
  });

  it('returns an empty array for no rows', () => {
    expect(pickMostRecentDevicePerUser([])).toEqual([]);
  });
});
