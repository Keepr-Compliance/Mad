/**
 * BACKLOG-2800 — the companion's copy of the import-filter resolver, and the
 * calendar arithmetic that turns it into a timestamp.
 *
 * ## Why this suite is load-bearing
 *
 * `android-companion/services/syncWindow.ts` RESTATES
 * `resolveAndroidImportFilters` + `resolveStoredLookbackMonths` from
 * `src/components/settings/messageImportPreferences.ts`. It has to: the
 * companion is a separate npm package with its own lockfile, and
 * `android-companion/metro.config.js` roots Metro at that directory with no
 * `watchFolders`, so `src/` is unreachable at bundle time. A cross-package
 * import would pass jest and fail the bundler.
 *
 * Nothing in the type system holds the two copies together. THIS SUITE DOES.
 * Its cases are the BACKLOG-2561 cases restated against the companion resolver;
 * the renderer side is pinned by
 * `src/components/settings/__tests__/AndroidMessagesSettings.allTime-2561.test.tsx`.
 *
 * Assertions are on VALUES, and the clamp boundaries are SWEPT rather than
 * sampled — one input per branch cannot catch an off-by-one, and the month-end
 * cases are exactly where naive `setMonth` goes wrong.
 */

// syncWindow imports these at module load; none of them is exercised by the
// pure functions under test here.
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
    multiRemove: jest.fn(async () => undefined),
  },
}));
jest.mock('@sentry/react-native', () => ({
  captureMessage: jest.fn(),
  captureException: jest.fn(),
  addBreadcrumb: jest.fn(),
}));
jest.mock('../supabaseClient', () => ({
  supabase: {
    auth: { getSession: jest.fn(async () => ({ data: { session: null } })) },
    from: jest.fn(),
  },
}));

import {
  resolveLookbackMonths,
  computeWindowStart,
  DEFAULT_LOOKBACK_MONTHS,
} from '../syncWindow';

describe('resolveLookbackMonths — absent vs explicit null (BACKLOG-2561 rules)', () => {
  it('ABSENT lookbackMonths is "no preference" and resolves to the default, NOT All time', () => {
    // The exact shape the app writes when only the message CAP has ever been
    // changed: `android.filters` exists, `lookbackMonths` never set.
    const prefs = { messageImport: { android: { filters: { maxMessages: 10000 } } } };
    expect(resolveLookbackMonths(prefs)).toBe(DEFAULT_LOOKBACK_MONTHS);
    expect(resolveLookbackMonths(prefs)).not.toBeNull();
  });

  it('EXPLICIT null is All time — no lower bound', () => {
    const prefs = {
      messageImport: { android: { filters: { lookbackMonths: null } } },
    };
    expect(resolveLookbackMonths(prefs)).toBeNull();
  });

  it('an explicit number is taken as-is', () => {
    for (const months of [3, 6, 9, 12, 18, 24]) {
      expect(
        resolveLookbackMonths({
          messageImport: { android: { filters: { lookbackMonths: months } } },
        }),
      ).toBe(months);
    }
  });

  it('`?? DEFAULT` and `?? null` would BOTH be wrong — only `=== undefined` separates the two', () => {
    const absent = { messageImport: { android: { filters: {} } } };
    const explicitNull = {
      messageImport: { android: { filters: { lookbackMonths: null } } },
    };
    // If the resolver used `?? DEFAULT`, explicitNull would wrongly read 3.
    // If it used `?? null`, absent would wrongly read null.
    expect(resolveLookbackMonths(absent)).toBe(DEFAULT_LOOKBACK_MONTHS);
    expect(resolveLookbackMonths(explicitNull)).toBeNull();
  });
});

describe('resolveLookbackMonths — legacy fallback when the android namespace is absent', () => {
  /**
   * The desktop panel seeds `messageImport.android` only the first time somebody
   * OPENS it. A user who chose "All time" before BACKLOG-2734 and has never
   * opened the Android panel still has that choice ONLY under the legacy shared
   * key. Reading `android` alone would silently narrow them to 3 months — which
   * is the whole harm this fallback exists to prevent.
   */
  it('a legacy "All time" choice survives when `android` has never been seeded', () => {
    const prefs = { messageImport: { filters: { lookbackMonths: null } } };
    expect(resolveLookbackMonths(prefs)).toBeNull();
  });

  it('a legacy month choice survives when `android` has never been seeded', () => {
    const prefs = { messageImport: { filters: { lookbackMonths: 18 } } };
    expect(resolveLookbackMonths(prefs)).toBe(18);
  });

  it('once `android` EXISTS it wins outright, and the legacy key is ignored', () => {
    const prefs = {
      messageImport: {
        filters: { lookbackMonths: 24 },
        android: { filters: { lookbackMonths: 3 } },
      },
    };
    expect(resolveLookbackMonths(prefs)).toBe(3);
  });

  it('an EXISTING android namespace with an absent lookback takes the default, not the legacy value', () => {
    // Once seeded, the namespaces are independent — this is the BACKLOG-2734
    // separation. Falling back to the legacy 24 here would re-link them.
    const prefs = {
      messageImport: {
        filters: { lookbackMonths: 24 },
        android: { filters: { maxMessages: 50000 } },
      },
    };
    expect(resolveLookbackMonths(prefs)).toBe(DEFAULT_LOOKBACK_MONTHS);
  });
});

describe('resolveLookbackMonths — malformed / empty input never throws', () => {
  // A brand-new user genuinely has `{}`; the rest are defensive, since this
  // parses a JSON blob that crossed a process and a network boundary.
  it.each([
    ['empty object', {}],
    ['undefined', undefined],
    ['null', null],
    ['a string', 'nonsense'],
    ['an array', []],
    ['messageImport not an object', { messageImport: 7 }],
    ['android not an object', { messageImport: { android: 'x' } }],
    ['filters not an object', { messageImport: { android: { filters: 5 } } }],
  ])('%s resolves to the default', (_label, input) => {
    expect(resolveLookbackMonths(input)).toBe(DEFAULT_LOOKBACK_MONTHS);
  });
});

describe('resolveLookbackMonths — a corrupt stored value must not disable the window', () => {
  /**
   * Found while investigating a mutation that did NOT go red (the never-throw
   * outer guard in `getSyncWindowStart`): a non-numeric `lookbackMonths` does
   * not throw, it POISONS. `setMonth(getMonth() - "abc")` is NaN, so the window
   * start is NaN, `Math.max(cursor, NaN)` is NaN, `JSON.stringify` writes it as
   * a literal `null`, and the native side reads that back as 0 — an unbounded
   * read reached silently, which is the exact defect BACKLOG-2800 exists to fix.
   *
   * MUTATION: remove the `Number.isFinite` guard in `resolveLookbackMonths` and
   * the first four cases go red.
   */
  it.each([
    ['a string', 'abc'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a negative month count', -6],
    ['zero', 0],
    ['a boolean', true],
    ['an object', { months: 3 }],
  ])('%s falls back to the default rather than producing an unbounded read', (_label, value) => {
    const prefs = {
      messageImport: { android: { filters: { lookbackMonths: value } } },
    };
    const resolved = resolveLookbackMonths(prefs);
    expect(resolved).toBe(DEFAULT_LOOKBACK_MONTHS);
    // The value that matters downstream: never NaN, never null-by-accident.
    expect(Number.isFinite(computeWindowStart(resolved, Date.now()) as number)).toBe(true);
  });

  it('a valid month count still produces a finite window start', () => {
    expect(
      Number.isFinite(computeWindowStart(resolveLookbackMonths({
        messageImport: { android: { filters: { lookbackMonths: 6 } } },
      }), Date.now()) as number),
    ).toBe(true);
  });
});

describe('computeWindowStart — All time', () => {
  it('null months means NO lower bound', () => {
    expect(computeWindowStart(null, Date.parse('2026-08-30T12:00:00Z'))).toBeNull();
  });
});

describe('computeWindowStart — month-end clamp, swept not sampled', () => {
  /**
   * Naive `setMonth` OVERFLOWS at month ends, and every overflow moves the edge
   * FORWARD — i.e. it silently NARROWS the window the user asked for:
   *
   *   31 Aug − 6mo -> 3 Mar   (should be 28 Feb)  — 3 days narrower
   *   31 Mar − 1mo -> 3 Mar   (should be 28 Feb)  — skips February outright
   *   29 Feb − 12mo -> 1 Mar  (should be 28 Feb)
   *
   * Expected values are built with LOCAL Date constructors, matching the
   * implementation, so the assertions hold in any timezone and across DST
   * without needing TZ pinned.
   *
   * MUTATION: drop the clamp (use a bare `setMonth`) and every case here goes
   * red except the non-month-end control at the end.
   */
  const cases: Array<[string, Date, number, Date]> = [
    // [label, now, months, expected window start]
    ['31 Aug minus 6 clamps to 28 Feb', new Date(2026, 7, 31, 12, 0, 0), 6, new Date(2026, 1, 28, 12, 0, 0)],
    ['31 Mar minus 1 clamps to 28 Feb (never skips February)', new Date(2026, 2, 31, 12, 0, 0), 1, new Date(2026, 1, 28, 12, 0, 0)],
    ['31 May minus 3 clamps to 28 Feb', new Date(2026, 4, 31, 12, 0, 0), 3, new Date(2026, 1, 28, 12, 0, 0)],
    ['31 Dec minus 1 clamps to 30 Nov', new Date(2026, 11, 31, 12, 0, 0), 1, new Date(2026, 10, 30, 12, 0, 0)],
    ['31 Mar minus 1 in a LEAP year clamps to 29 Feb', new Date(2024, 2, 31, 12, 0, 0), 1, new Date(2024, 1, 29, 12, 0, 0)],
    ['29 Feb minus 12 clamps to 28 Feb of the prior year', new Date(2024, 1, 29, 12, 0, 0), 12, new Date(2023, 1, 28, 12, 0, 0)],
    ['a mid-month date needs no clamp', new Date(2026, 7, 30, 12, 0, 0), 3, new Date(2026, 4, 30, 12, 0, 0)],
  ];

  it.each(cases)('%s', (_label, now, months, expected) => {
    expect(computeWindowStart(months, now.getTime())).toBe(expected.getTime());
  });

  it('the window start is always in the PAST and never after `now`', () => {
    for (const [, now, months] of cases) {
      const start = computeWindowStart(months, now.getTime());
      expect(start).not.toBeNull();
      expect(start as number).toBeLessThan(now.getTime());
    }
  });

  it('a larger lookback always reaches strictly further back', () => {
    const now = new Date(2026, 7, 31, 12, 0, 0).getTime();
    const months = [3, 6, 9, 12, 18, 24];
    const starts = months.map((m) => computeWindowStart(m, now) as number);
    for (let i = 1; i < starts.length; i += 1) {
      expect(starts[i]).toBeLessThan(starts[i - 1]);
    }
  });

  it('preserves the time of day, so the edge is not silently rounded to midnight', () => {
    const now = new Date(2026, 7, 30, 14, 37, 5);
    const start = new Date(computeWindowStart(3, now.getTime()) as number);
    expect([start.getHours(), start.getMinutes(), start.getSeconds()]).toEqual([14, 37, 5]);
  });
});
