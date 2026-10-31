/**
 * Paywall Funnel fixtures (BACKLOG-3722). Synthetic rows, no production ids.
 *
 * The SHAPE is transcribed from production, counts only (2026-10-30, Supabase
 * project Keepr, SELECT only):
 *
 *   select event_name, count(*) as rows_all, count(distinct user_id) as users_all,
 *          count(*) filter (where created_at >= now()-interval '30 days') as rows_30d,
 *          count(distinct user_id) filter (where created_at >= now()-interval '30 days') as users_30d,
 *          count(*) filter (where user_id is null) as null_users
 *   from analytics_events
 *   where event_name in ('paywall-viewed','unlock-clicked','payment-succeeded','export-completed')
 *   group by event_name;
 *
 *   event_name          rows_all users_all rows_30d users_30d null_users
 *   paywall-viewed            95        14       18         5          0
 *   unlock-clicked             5         2        0         0          0
 *   payment-succeeded          3         2        0         0          0
 *   export-completed         105        14       24         6          0
 *
 * Columns of analytics_events: id uuid, user_id uuid (nullable), event_name
 * text, event_data jsonb, device_id text, app_version text, created_at
 * timestamptz. The funnel selects only id, event_name, user_id.
 *
 * Ids are all-zero UUIDs: users 1..99, events from 1000 up.
 */

export const NOW = new Date('2026-10-30T12:00:00.000Z');

export interface FixtureRow {
  id: string;
  user_id: string | null;
  event_name: string;
  created_at: string;
  [key: string]: unknown;
}

export const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

interface Spec {
  event: string;
  rows: number;
  users: number;
}

/** Rows for each spec, users cycling 1..users, timestamps one minute apart from `start`. */
function build(specs: Spec[], start: string, firstId: number): FixtureRow[] {
  const base = Date.parse(start);
  const out: FixtureRow[] = [];
  let n = firstId;
  for (const spec of specs) {
    for (let i = 0; i < spec.rows; i += 1) {
      out.push({
        id: uuid(n),
        user_id: uuid((i % spec.users) + 1),
        event_name: spec.event,
        created_at: new Date(base + (n - firstId) * 60_000).toISOString(),
        event_data: { synthetic: true },
      });
      n += 1;
    }
  }
  return out;
}

/** Production's ALL-TIME shape: 14 / 2 / 2 / 14 distinct users. */
export const ALL_TIME_ROWS = build(
  [
    { event: 'paywall-viewed', rows: 95, users: 14 },
    { event: 'unlock-clicked', rows: 5, users: 2 },
    { event: 'payment-succeeded', rows: 3, users: 2 },
    { event: 'export-completed', rows: 105, users: 14 },
  ],
  '2026-03-01T00:00:00.000Z',
  1000
);

/** Production's LAST-30-DAYS shape: 5 / 0 / 0 / 6 — the >100% case. */
export const LAST_30_ROWS = build(
  [
    { event: 'paywall-viewed', rows: 18, users: 5 },
    { event: 'export-completed', rows: 24, users: 6 },
  ],
  '2026-10-10T00:00:00.000Z',
  2000
);

/** Rows the server filters must drop: other event names, and rows outside the period. */
export const NOISE_ROWS: FixtureRow[] = [
  ...build([{ event: 'app-opened', rows: 7, users: 3 }], '2026-10-12T00:00:00.000Z', 3000),
  ...build([{ event: 'paywall-viewed', rows: 4, users: 4 }], '2026-09-01T00:00:00.000Z', 3100).map((r, i) => ({
    ...r,
    user_id: uuid(50 + i),
  })),
  // At exactly the exclusive upper bound — belongs to the next period.
  { id: uuid(3200), user_id: uuid(60), event_name: 'unlock-clicked', created_at: NOW.toISOString() },
];

/** What computeFunnel gives for each shape (counts from the SQL above; maths from funnel-analytics.ts). */
export const ALL_TIME_EXPECTED = {
  userCounts: [14, 2, 2, 14],
  conversionFromPrev: [100, 14.3, 100, 700],
  conversionFromTop: [100, 14.3, 14.3, 100],
  exceedsPrevious: [false, false, false, true],
};

export const LAST_30_EXPECTED = {
  userCounts: [5, 0, 0, 6],
  conversionFromPrev: [100, 0, 0, 0],
  conversionFromTop: [100, 0, 0, 120],
  exceedsPrevious: [false, false, false, true],
};
