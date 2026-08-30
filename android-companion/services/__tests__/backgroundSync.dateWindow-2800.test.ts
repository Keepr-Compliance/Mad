/**
 * BACKLOG-2800 — the import window GOVERNS the Android sync, end to end.
 *
 * ## Why this suite exists separately from `backgroundSync.test.ts`
 *
 * That suite does `jest.mock('../smsReader', ...)` at its line 69. A control
 * written there would assert `minDate` against a MOCK of the very function
 * whose input this item changes — it would stay green even if `minDate` never
 * reached the provider at all. That is the "verification set omits the only
 * check that would fail" shape, and it is the reason this file mocks everything
 * EXCEPT `../smsReader`.
 *
 * ## The native module here is a transcription, not an invention
 *
 * `installPagingSms` reproduces the real `SmsModule.list` contract, verified
 * against the INSTALLED, POST-PATCH library source
 * (`node_modules/react-native-get-sms-android/android/src/main/java/com/react/
 * SmsModule.java`, v2.1.0 — `patches/react-native-get-sms-android+2.1.0.patch`
 * touches only `build.gradle` and `AndroidManifest.xml`, never the reader):
 *
 *   - line 106: `minDate <= cursor.getLong(...("date"))`  ->  `date >= minDate`
 *   - line 105: applied only when `minDate > -1`
 *   - lines 107-116: the `indexFrom` / `maxCount` window is taken against a
 *     counter that advances ONLY for rows passing the filter, i.e. paging is
 *     applied AFTER filtering — so the mock filters, then sorts, then slices.
 *
 * Assertions are exact ID SETS. "Fewer messages arrived" would pass on a
 * truncated read and prove nothing.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SyncMessage, SyncResult, PairingInfo } from '../../types/sync';
import type { SyncContact } from '../../types/contacts';

// --- react-native: Android platform + an installable fake native Sms module.
// Mirrors `smsReader.test.ts`, which drives the same real reader. ---
jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  NativeModules: {} as Record<string, unknown>,
}));

// --- Stateful in-memory AsyncStorage ---
jest.mock('@react-native-async-storage/async-storage', () => {
  let store: Record<string, string> = {};
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (k: string) => (k in store ? store[k] : null)),
      setItem: jest.fn(async (k: string, v: string) => {
        store[k] = v;
      }),
      removeItem: jest.fn(async (k: string) => {
        delete store[k];
      }),
      multiRemove: jest.fn(async (keys: string[]) => {
        keys.forEach((k) => delete store[k]);
      }),
      __reset: () => {
        store = {};
      },
    },
  };
});
const resetStore = (): void =>
  (AsyncStorage as unknown as { __reset: () => void }).__reset();

jest.mock('expo-task-manager', () => ({
  defineTask: jest.fn(),
  isTaskRegisteredAsync: jest.fn(async () => false),
}));
jest.mock('expo-background-fetch', () => ({
  BackgroundFetchResult: { NewData: 1, NoData: 2, Failed: 3 },
  registerTaskAsync: jest.fn(async () => undefined),
  unregisterTaskAsync: jest.fn(async () => undefined),
  getStatusAsync: jest.fn(async () => 3),
}));
jest.mock('@sentry/react-native', () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

// --- SMS permission gate: granted throughout (revocation is 2209's suite). ---
jest.mock('../permissions', () => ({
  checkSmsPermissions: async () => ({
    readSms: 'granted',
    receiveSms: 'granted',
    allGranted: true,
  }),
}));

jest.mock('../contactReader', () => ({ readContacts: async () => [] }));

const mockSendMessages =
  jest.fn<Promise<SyncResult>, [SyncMessage[], PairingInfo]>();
jest.mock('../syncService', () => ({
  sendMessages: (batch: SyncMessage[], pairing: PairingInfo) =>
    mockSendMessages(batch, pairing),
  sendContacts: async () => ({ success: true }),
  pingDesktop: async () => true,
}));
jest.mock('../connectivity', () => ({ isPhoneOnLocalNetwork: async () => true }));

// --- Supabase, which is what `syncWindow` reads BOTH the session and the
// setting through. It deliberately does NOT go via `authService`: that module
// evaluates `createURL(...)` at import time and expo-linking throws without the
// expo-constants manifest, which would break every suite that transitively
// imports smsQueueService. Mocking `supabase.auth` here mirrors that. ---
const mockGetSession = jest.fn<Promise<{ user: { id: string } } | null>, []>();

interface PrefRow {
  data: { preferences: unknown } | null;
  error: { code?: string; message: string } | null;
}
const mockPrefRow = jest.fn<Promise<PrefRow>, [string]>();
jest.mock('../supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: await mockGetSession() } }),
    },
    from: (_table: string) => ({
      select: () => ({
        eq: (_col: string, userId: string) => ({
          maybeSingle: () => mockPrefRow(userId),
        }),
      }),
    }),
  },
}));

import { NativeModules } from 'react-native';
import { performSync } from '../backgroundSync';
import {
  getLastSyncTimestamp,
  enqueueMessages,
  MAX_QUEUE_SIZE,
} from '../smsQueueService';

const PAIRING_STORAGE_KEY = '@keepr/pairing';
const USER = 'user-aaa';
const OTHER_USER = 'user-bbb';

// ---------------------------------------------------------------------------
// The provider transcription
// ---------------------------------------------------------------------------

interface RawSms {
  _id: string;
  thread_id: string;
  address: string;
  body: string;
  date: string;
  date_sent: string;
  type: string;
  read: string;
}

type SmsListFn = (
  filterJson: string,
  failCb: (msg: string) => void,
  successCb: (count: number, json: string) => void,
) => void;

interface PageCall {
  box: 'inbox' | 'sent';
  indexFrom: number;
  maxCount: number;
  minDate?: number;
}

/**
 * Install a native Sms module honouring the real SmsModule.list contract:
 * filter by `date >= minDate` (only when present and > -1), sort date ASC, then
 * return the `[indexFrom, indexFrom + maxCount)` slice OF THE FILTERED rows.
 */
function installPagingSms(fixture: {
  inbox?: RawSms[];
  sent?: RawSms[];
}): { calls: PageCall[] } {
  const store = { inbox: fixture.inbox ?? [], sent: fixture.sent ?? [] };
  const calls: PageCall[] = [];

  const list: SmsListFn = (filterJson, _failCb, successCb) => {
    const raw = JSON.parse(filterJson) as {
      box: 'inbox' | 'sent';
      indexFrom?: number;
      maxCount: number;
      minDate?: number;
    };
    const call: PageCall = {
      box: raw.box,
      indexFrom: raw.indexFrom ?? 0,
      maxCount: raw.maxCount,
      minDate: raw.minDate,
    };
    calls.push(call);

    const source = call.box === 'sent' ? store.sent : store.inbox;
    const matched = (
      call.minDate !== undefined
        ? source.filter((r) => Number(r.date) >= (call.minDate as number))
        : source.slice()
    ).sort((a, b) => Number(a.date) - Number(b.date));

    const page =
      call.maxCount > 0
        ? matched.slice(call.indexFrom, call.indexFrom + call.maxCount)
        : matched.slice(call.indexFrom);

    successCb(matched.length, JSON.stringify(page));
  };

  (NativeModules as unknown as { Sms?: { list: SmsListFn } }).Sms = { list };
  return { calls };
}

/** A raw provider row at a given id/date. Numbers are +1 <area> 555-01xx. */
function row(id: number, date: number, box: 'inbox' | 'sent' = 'inbox'): RawSms {
  return {
    _id: String(id),
    thread_id: 't1',
    address: `+1206555${String(100 + (id % 90)).padStart(4, '0')}`,
    body: `message ${id}`,
    date: String(date),
    date_sent: String(date),
    type: box === 'sent' ? '2' : '1',
    read: '1',
  };
}

const DAY = 24 * 60 * 60 * 1000;

/** Fixed clock. All window arithmetic in these tests is relative to it. */
const NOW = new Date(2026, 7, 30, 12, 0, 0).getTime();
/** The 3-month edge for NOW, computed the way the implementation does. */
const THREE_MONTHS_AGO = new Date(2026, 4, 30, 12, 0, 0).getTime();

async function setPaired(): Promise<void> {
  await AsyncStorage.setItem(
    PAIRING_STORAGE_KEY,
    JSON.stringify({
      ip: '10.0.0.2',
      port: 8765,
      secret: 'x'.repeat(64),
      deviceName: 'desk',
    }),
  );
}

/** Every smsId the sync actually handed to the transport, across all calls. */
function sentIds(): Set<string> {
  const ids = new Set<string>();
  for (const [batch] of mockSendMessages.mock.calls) {
    batch.forEach((m) => ids.add(m.smsId as string));
  }
  return ids;
}

beforeEach(async () => {
  resetStore();
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  mockSendMessages.mockResolvedValue({ success: true });
  mockGetSession.mockResolvedValue({ user: { id: USER } });
  // Default: the user has explicitly chosen "Last 3 months".
  mockPrefRow.mockResolvedValue({
    data: { preferences: { messageImport: { android: { filters: { lookbackMonths: 3 } } } } },
    error: null,
  });
  await setPaired();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. THE ITEM'S OWN CONTROL — identity, not counts
// ---------------------------------------------------------------------------

describe('the configured window governs what the phone reads (identity)', () => {
  /**
   * 18 months of history, panel set to "Last 3 months".
   *
   * MUTATION that must go red: drop the `max(lastTimestamp, windowStart)` in
   * backgroundSync and feed the cursor alone — every out-of-window id arrives.
   */
  it('reads ONLY messages inside the window, and the message one day outside is ABSENT', async () => {
    const inWindow = [
      row(101, THREE_MONTHS_AGO + DAY),
      row(102, THREE_MONTHS_AGO + 30 * DAY),
      row(103, NOW - DAY),
    ];
    // One day OUTSIDE the edge — the single most important row in this suite.
    const justOutside = row(200, THREE_MONTHS_AGO - DAY);
    const wellOutside = [
      row(201, THREE_MONTHS_AGO - 200 * DAY),
      row(202, THREE_MONTHS_AGO - 400 * DAY),
    ];

    installPagingSms({ inbox: [...wellOutside, justOutside, ...inWindow] });

    await performSync();

    expect(sentIds()).toEqual(new Set(['101', '102', '103']));
    expect(sentIds().has('200')).toBe(false);
  });

  it('hands the native query the window edge as minDate, not the bare cursor', async () => {
    const { calls } = installPagingSms({ inbox: [row(1, NOW - DAY)] });

    await performSync();

    // The cursor is 0 on a fresh pair, so any minDate at all proves the window
    // reached the provider — and its VALUE proves it was the right window.
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.minDate).toBe(THREE_MONTHS_AGO);
    }
  });

  it('a wider setting admits what the narrower one excluded (the window is what decides)', async () => {
    mockPrefRow.mockResolvedValue({
      data: { preferences: { messageImport: { android: { filters: { lookbackMonths: 24 } } } } },
      error: null,
    });
    const old = row(300, THREE_MONTHS_AGO - 200 * DAY);
    const recent = row(301, NOW - DAY);
    installPagingSms({ inbox: [old, recent] });

    await performSync();

    expect(sentIds()).toEqual(new Set(['300', '301']));
  });
});

// ---------------------------------------------------------------------------
// 2. "ALL TIME" STAYS EXPRESSIBLE
// ---------------------------------------------------------------------------

describe('"All time" means no lower bound', () => {
  it('an EXPLICIT null lookback reads the whole history and sends no minDate', async () => {
    mockPrefRow.mockResolvedValue({
      data: { preferences: { messageImport: { android: { filters: { lookbackMonths: null } } } } },
      error: null,
    });
    const ancient = row(400, NOW - 3000 * DAY);
    const recent = row(401, NOW - DAY);
    const { calls } = installPagingSms({ inbox: [ancient, recent] });

    await performSync();

    expect(sentIds()).toEqual(new Set(['400', '401']));
    // Cursor is 0 and there is no window, so no minDate is sent at all
    // (smsReader only sets it when > 0).
    for (const call of calls) {
      expect(call.minDate).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. THE R1 BOUNDARY — fetch FAILED vs fetched EMPTY
// ---------------------------------------------------------------------------

describe('a successful EMPTY read is a real new-user state, not a failure', () => {
  it('signed in with NO preferences row applies the 3-month default (not unwindowed)', async () => {
    // `maybeSingle()` yields data: null with no error when the row is absent.
    mockPrefRow.mockResolvedValue({ data: null, error: null });

    const inWindow = row(500, NOW - DAY);
    const outOfWindow = row(501, THREE_MONTHS_AGO - DAY);
    installPagingSms({ inbox: [outOfWindow, inWindow] });

    await performSync();

    // The panel shows "Last 3 months" for this same input; the run must agree.
    expect(sentIds()).toEqual(new Set(['500']));
  });

  it('NOT signed in takes the fail-open ladder and runs UNWINDOWED (never the resolver)', async () => {
    mockGetSession.mockResolvedValue(null);

    const ancient = row(600, NOW - 3000 * DAY);
    const recent = row(601, NOW - DAY);
    installPagingSms({ inbox: [ancient, recent] });

    await performSync();

    // Crucially NOT {'601'}: defaulting a signed-out user to 3 months would
    // silently narrow a legacy "All time" user.
    expect(sentIds()).toEqual(new Set(['600', '601']));
  });

  it('a query ERROR takes the ladder and runs unwindowed rather than defaulting', async () => {
    mockPrefRow.mockResolvedValue({
      data: null,
      error: { code: '500', message: 'boom' },
    });
    const ancient = row(700, NOW - 3000 * DAY);
    installPagingSms({ inbox: [ancient] });

    await performSync();

    expect(sentIds()).toEqual(new Set(['700']));
  });
});

// ---------------------------------------------------------------------------
// 4. THE WINDOW LOOKUP MUST NEVER FAIL THE CYCLE (R2)
// ---------------------------------------------------------------------------

describe('a Supabase failure is never reported as an SMS read failure', () => {
  it('a THROWN error from the preferences read leaves readError undefined and the cycle healthy', async () => {
    mockPrefRow.mockImplementation(() => {
      throw new Error('network exploded');
    });
    installPagingSms({ inbox: [row(800, NOW - DAY)] });

    const result = await performSync();

    // Without the guard this lands in performSync's outer catch as
    // `query_failed`, holding lastSuccessfulSyncAt and showing the user a
    // read-error banner because Supabase was slow.
    expect(result.readError).toBeUndefined();
    expect(sentIds()).toEqual(new Set(['800']));
  });

  it('a session lookup that throws does not fail the cycle', async () => {
    mockGetSession.mockRejectedValue(new Error('keystore locked'));
    installPagingSms({ inbox: [row(801, NOW - DAY)] });

    const result = await performSync();

    expect(result.readError).toBeUndefined();
    expect(sentIds()).toEqual(new Set(['801']));
  });
});

// ---------------------------------------------------------------------------
// 5. CACHING, forceRefresh, AND THE ACCOUNT SWITCH (R3 / R12)
// ---------------------------------------------------------------------------

describe('caching', () => {
  it('a cursor of 0 forces a fresh fetch even when the cache is fresh', async () => {
    // Seed a FRESH cache claiming All time...
    await AsyncStorage.setItem(
      '@keepr/sync-window',
      JSON.stringify({ userId: USER, lookbackMonths: null, fetchedAt: NOW }),
    );
    // ...while Supabase says 3 months.
    installPagingSms({
      inbox: [row(900, THREE_MONTHS_AGO - DAY), row(901, NOW - DAY)],
    });

    await performSync();

    // The cursor is 0 (fresh pair / force re-import), so the fresh cache is
    // deliberately bypassed and the live 3-month setting wins.
    expect(mockPrefRow).toHaveBeenCalled();
    expect(sentIds()).toEqual(new Set(['901']));
  });

  it('a cache stamped with ANOTHER user is ignored, not applied', async () => {
    // The foreign cache carries a NARROW window (3 months) while this user's
    // own fetch fails. The two branches are then observably different:
    //   - stamp honoured  -> no usable value -> fail open -> the old message ARRIVES
    //   - stamp ignored   -> the other account's 3-month window applies -> it is DROPPED
    //
    // An earlier version of this test used a foreign "All time" cache and
    // asserted only that a fetch was attempted. Both branches then produced an
    // unbounded read, so it stayed green with the stamp check removed — it
    // could not tell the two apart. This shape can.
    await AsyncStorage.setItem(
      '@keepr/sync-window',
      JSON.stringify({ userId: OTHER_USER, lookbackMonths: 3, fetchedAt: NOW }),
    );
    mockPrefRow.mockResolvedValue({
      data: null,
      error: { code: '500', message: 'offline' },
    });

    const oldMessage = row(1000, THREE_MONTHS_AGO - 100 * DAY);
    const recent = row(1001, NOW - DAY);
    installPagingSms({ inbox: [oldMessage, recent] });

    await performSync();

    expect(mockPrefRow).toHaveBeenCalledWith(USER);
    // Falls open rather than adopting the other account's window.
    expect(sentIds()).toEqual(new Set(['1000', '1001']));
  });
});

// ---------------------------------------------------------------------------
// 6. RETENTION — narrowing changes what is READ, never what is KEPT
// ---------------------------------------------------------------------------

describe('narrowing the window never deletes or rewinds anything', () => {
  it('does not move the cursor backwards and does not drop already-queued history', async () => {
    // Cycle 1 under "All time" ingests old history.
    mockPrefRow.mockResolvedValue({
      data: { preferences: { messageImport: { android: { filters: { lookbackMonths: null } } } } },
      error: null,
    });
    installPagingSms({
      inbox: [row(1100, NOW - 3000 * DAY), row(1101, NOW - 2 * DAY)],
    });
    await performSync();

    const cursorAfterWide = await getLastSyncTimestamp();
    const idsAfterWide = new Set(sentIds());
    expect(idsAfterWide).toEqual(new Set(['1100', '1101']));

    // The user now narrows to 3 months. Nothing already synced may be undone.
    mockPrefRow.mockResolvedValue({
      data: { preferences: { messageImport: { android: { filters: { lookbackMonths: 3 } } } } },
      error: null,
    });
    await AsyncStorage.removeItem('@keepr/sync-window'); // force a re-read
    await performSync();

    const cursorAfterNarrow = await getLastSyncTimestamp();
    expect(cursorAfterNarrow).toBeGreaterThanOrEqual(cursorAfterWide);
    // The old message was already delivered and is not re-sent or retracted.
    expect(sentIds()).toEqual(idsAfterWide);
  });
});

// ---------------------------------------------------------------------------
// 6b. THE BACK-PRESSURE RATCHET — INTENDED, and pinned so nobody files it
// ---------------------------------------------------------------------------

describe('a message can age out of the window while back-pressure holds the cursor', () => {
  /**
   * THIS IS INTENDED BEHAVIOUR, NOT A BUG. Recording it as a control so the
   * next reader finds a decision rather than a surprise.
   *
   * The window is ROLLING. If the queue stays at capacity long enough for the
   * window edge to move past a message the phone had not yet reached, that
   * message is never read. "Last 3 months" is a rolling request: a message
   * older than three months is outside what the user asked for, so declining to
   * read it is the setting working, not data loss.
   *
   * What must remain true — and is asserted below — is that the cursor never
   * advances past an unread message that IS in window. `max()` only ever raises
   * the floor to the window edge; it never moves the cursor.
   *
   * The walk-through, with a fixed clock advanced between two real cycles:
   *   - NOW  = 30 Aug 2026, window edge E0 = 30 May 2026
   *   - cycle 1: queue at capacity -> back-pressure -> NOTHING is read, cursor 0
   *   - clock advances 10 days; the edge moves with it to E1 = 9 Jun 2026
   *   - cycle 2: capacity has freed -> the read floor is now E1
   *   - a message dated 4 Jun 2026 was inside the window during cycle 1 and is
   *     outside it during cycle 2. It is ABSENT, deliberately.
   */
  it('the aged-out message is absent and the still-in-window one arrives (exact ids)', async () => {
    const NOW2 = new Date(2026, 8, 9, 12, 0, 0).getTime(); // NOW + 10 days

    // Between E0 (30 May) and E1 (9 Jun): in window at NOW, out of it at NOW2.
    const agesOut = row(1200, new Date(2026, 5, 4, 12, 0, 0).getTime());
    // Comfortably inside the window at BOTH clocks.
    const survivor = row(1201, new Date(2026, 7, 29, 12, 0, 0).getTime());
    installPagingSms({ inbox: [agesOut, survivor] });

    // Fill the queue so the cycle-1 read is refused for back-pressure. The
    // cursor must not move while the phone declines to read.
    await enqueueMessages(
      Array.from({ length: MAX_QUEUE_SIZE }, (_, i) => ({
        smsId: `filler-${i}`,
        sender: '+12065550199',
        body: `filler ${i}`,
        timestamp: 1_000 + i,
        direction: 'inbound' as const,
      })),
    );

    await performSync();

    // Back-pressure held: nothing new was read and the cursor is untouched.
    expect(await getLastSyncTimestamp()).toBe(0);
    const readInCycle1 = [...sentIds()].filter((id) => id === '1200' || id === '1201');
    expect(readInCycle1).toEqual([]);

    // The clock advances while the backlog drains, carrying the window edge.
    jest.spyOn(Date, 'now').mockReturnValue(NOW2);
    mockSendMessages.mockClear();

    // Drain the rest of the queue so cycle 2 has capacity to read with.
    await AsyncStorage.removeItem('@keepr/sms-queue');
    await AsyncStorage.removeItem('@keepr/sync-window'); // force a fresh window

    await performSync();

    // The 4 June message aged out of the rolling window between the two cycles.
    expect(sentIds()).toEqual(new Set(['1201']));
    expect(sentIds().has('1200')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. THE UNION-CURSOR SKIP — the invariant BACKLOG-3005 inherits
// ---------------------------------------------------------------------------

describe('INVARIANT: the advanced cursor is <= the max of every truncated box', () => {
  /**
   * The defect this fixes, as a walk-through: each box is read with its own
   * ceiling, but ONE cursor is advanced from the newest message across both. A
   * truncated inbox (newest: old) plus a sparse-but-recent sent box (newest:
   * recent) moved the cursor to the recent value, and every unread inbox
   * message in between was skipped permanently.
   *
   * The fix is the combined TRIM: each box is read with the full capacity as
   * its ceiling, the union is sorted ascending and cut back to that capacity,
   * so the kept set's newest element is <= the max of every truncated box.
   *
   * BACKLOG-3005 chains pages for throughput and MUST KEEP THIS GREEN: whatever
   * it advances the cursor to has to be a timestamp below which BOTH boxes are
   * known complete.
   *
   * MUTATION that must go red: compute `newestTimestamp` from the raw union
   * (`readResult.messages`) instead of the trimmed set.
   */
  it('a lopsided history never advances the cursor past unread inbox messages', async () => {
    mockPrefRow.mockResolvedValue({
      data: { preferences: { messageImport: { android: { filters: { lookbackMonths: null } } } } },
      error: null,
    });

    // Far more inbox than capacity, all OLD; a handful of RECENT sent messages.
    const base = NOW - 900 * DAY;
    const inbox = Array.from({ length: MAX_QUEUE_SIZE + 200 }, (_, i) =>
      row(10_000 + i, base + i * 1000),
    );
    const sent = Array.from({ length: 6 }, (_, i) =>
      row(90_000 + i, NOW - (10 - i) * DAY, 'sent'),
    );
    installPagingSms({ inbox, sent });

    await performSync();

    const cursor = await getLastSyncTimestamp();
    const newestInboxRead = Math.max(
      ...[...sentIds()]
        .filter((id) => Number(id) >= 10_000 && Number(id) < 90_000)
        .map((id) => Number(inbox[Number(id) - 10_000].date)),
    );

    // The cursor must not have jumped to the recent SENT timestamps, which
    // would strand every inbox message in between.
    expect(cursor).toBeLessThanOrEqual(newestInboxRead + 1);
    expect(cursor).toBeLessThan(NOW - 10 * DAY);
  });

  it('uses the full remaining capacity rather than halving it per box', async () => {
    mockPrefRow.mockResolvedValue({
      data: { preferences: { messageImport: { android: { filters: { lookbackMonths: null } } } } },
      error: null,
    });
    const base = NOW - 900 * DAY;
    // Lopsided: plenty of inbox, almost no sent. The old 50/50 split capped the
    // cycle at capacity/2 + 3; the trim lets it use the whole budget.
    const inbox = Array.from({ length: MAX_QUEUE_SIZE + 100 }, (_, i) =>
      row(20_000 + i, base + i * 1000),
    );
    const sent = Array.from({ length: 3 }, (_, i) =>
      row(80_000 + i, base + 10 + i, 'sent'),
    );
    installPagingSms({ inbox, sent });

    await performSync();

    // Under the old floor(capacity/2) split this could not exceed 253.
    expect(sentIds().size).toBeGreaterThan(MAX_QUEUE_SIZE / 2 + 10);
  });
});
