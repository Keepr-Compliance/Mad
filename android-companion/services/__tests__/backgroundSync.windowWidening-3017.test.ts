/**
 * BACKLOG-3017 (folded into BACKLOG-2800) — WIDENING the import window must
 * bring something older back.
 *
 * ## The defect, as observed on hardware
 *
 * BACKLOG-2800 set the read floor to `max(storedCursor, windowStart)`. That
 * governs NARROWING and is INERT for widening: after the first pair the cursor
 * sits above the window edge, so moving the edge further back changes nothing.
 * The desktop panel offers "All time" and the phone brings nothing older — the
 * setting APPEARS to work and does not.
 *
 * Founder's SM-A146U, 2026-08-30. `lookbackMonths` 3 -> 9 in the desktop panel
 * (Supabase `updated_at 2026-08-30 21:43:20`), then Sync Now with NO re-pair:
 *
 *     [SmsReader] Reading SMS since=1787771874011 (2026-08-26T19:17:54.011Z)
 *     [SmsReader] Found 0 inbox + 0 sent = 0 total
 *
 * No `Import window raised the read floor` line was emitted at all: the 9-month
 * floor (30 Nov 2025) lost to the 26-August cursor. The same device immediately
 * after a re-pair — which clears the cursor via BACKLOG-2995 — DID honour it:
 *
 *     [BackgroundSync] Import window raised the read floor: cursor=0 ->
 *     windowStart=1764539076663 (2025-11-30T21:44:36.663Z)
 *
 * These controls run 3 -> 9 months deliberately, so the fixture reproduces the
 * observed transition rather than a convenient one.
 *
 * ## Why this suite is separate from `backgroundSync.dateWindow-2800.test.ts`
 *
 * Same reason that suite is separate from `backgroundSync.test.ts`: it mocks
 * everything EXCEPT `../smsReader`, so `minDate` is asserted where it actually
 * reaches the (transcribed) native provider rather than against a mock of the
 * function under test. The harness below is duplicated from it ON PURPOSE — the
 * 2800 suite has been reviewed and must not be reshaped by this fold.
 *
 * ## Assertions are per-cycle, never cumulative
 *
 * `sentIds()` over every recorded call is a SET, so a control that re-reads and
 * re-sends the same message leaves it unchanged. Every multi-cycle control here
 * clears `mockSendMessages` between cycles and asserts what THAT cycle sent.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SyncMessage, SyncResult, PairingInfo } from '../../types/sync';

// --- react-native: Android platform + an installable fake native Sms module.
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
  resetMessageCursor,
} from '../smsQueueService';

const PAIRING_STORAGE_KEY = '@keepr/pairing';
const CURSOR_KEY = '@keepr/last-sync-timestamp';
const APPLIED_KEY = '@keepr/sync-window-applied';
const USER = 'user-aaa';

// ---------------------------------------------------------------------------
// The provider transcription (see the 2800 suite for the line-by-line citation
// of `SmsModule.list`: filter `date >= minDate` only when minDate > -1, sort
// date ASC, then slice [indexFrom, indexFrom + maxCount) OF THE FILTERED rows).
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

/** Fixed clock. All window arithmetic below is relative to it. */
const NOW = new Date(2026, 7, 30, 12, 0, 0).getTime();
/** Edges computed the way `computeWindowStart` computes them. */
const THREE_MONTHS_AGO = new Date(2026, 4, 30, 12, 0, 0).getTime();
const NINE_MONTHS_AGO = new Date(2025, 10, 30, 12, 0, 0).getTime();

function prefs(lookbackMonths: number | null): PrefRow {
  return {
    data: {
      preferences: { messageImport: { android: { filters: { lookbackMonths } } } },
    },
    error: null,
  };
}

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

/** Every smsId handed to the transport since the last `mockSendMessages` clear. */
function sentIds(): Set<string> {
  const ids = new Set<string>();
  for (const [batch] of mockSendMessages.mock.calls) {
    batch.forEach((m) => ids.add(m.smsId as string));
  }
  return ids;
}

/** The applied-window record as stored, or `undefined` when absent. */
async function storedApplied(): Promise<
  { userId: string; windowStart: number | null } | undefined
> {
  const raw = await AsyncStorage.getItem(APPLIED_KEY);
  return raw === null ? undefined : JSON.parse(raw);
}

/** The ordered [key, value] pairs written since the last setItem clear. */
function setItemCalls(): [string, string][] {
  return (AsyncStorage.setItem as unknown as jest.Mock).mock.calls as [
    string,
    string,
  ][];
}

beforeEach(async () => {
  resetStore();
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  mockSendMessages.mockResolvedValue({ success: true });
  mockGetSession.mockResolvedValue({ user: { id: USER } });
  mockPrefRow.mockResolvedValue(prefs(3));
  await setPaired();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. THE HEADLINE — widening lowers the read floor (the founder's 3 -> 9)
// ---------------------------------------------------------------------------

describe('widening the window lowers the read floor', () => {
  /**
   * MUTATION that must go red: make `isWidening` return false for
   * `resolvedStart < applied.start` — i.e. restore `max(cursor, windowStart)`
   * as the only rule. The 6-month-old message never arrives.
   */
  it('a 3 -> 9 month change re-reads history the 3-month window excluded', async () => {
    // Inside 9 months, outside 3 — the founder's exact missing band.
    const older = row(801, NINE_MONTHS_AGO + 10 * DAY);
    const recent = row(802, NOW - DAY);
    const { calls } = installPagingSms({ inbox: [older, recent] });

    // Cycle 1 — "Last 3 months". The cursor advances past the recent message.
    await performSync();
    expect(sentIds()).toEqual(new Set(['802']));
    const cursorAfterNarrow = await getLastSyncTimestamp();
    expect(cursorAfterNarrow).toBeGreaterThan(THREE_MONTHS_AGO);

    // The user widens the panel to "Last 9 months" and taps Sync Now.
    mockPrefRow.mockResolvedValue(prefs(9));
    mockSendMessages.mockClear();
    const callsBefore = calls.length;

    await performSync({ userInitiated: true });

    // THE ASSERTION THIS ITEM EXISTS FOR: the older message arrives.
    expect(sentIds()).toEqual(new Set(['801', '802']));

    // And it arrives because the floor DROPPED to the new edge, not because
    // something else re-read the whole phone.
    const cycle2 = calls.slice(callsBefore);
    expect(cycle2.length).toBeGreaterThan(0);
    for (const call of cycle2) {
      expect(call.minDate).toBe(NINE_MONTHS_AGO);
    }
  });

  it('records the widened edge, so the rewind happens ONCE and not every cycle', async () => {
    const older = row(811, NINE_MONTHS_AGO + 10 * DAY);
    const recent = row(812, NOW - DAY);
    installPagingSms({ inbox: [older, recent] });

    await performSync();
    mockPrefRow.mockResolvedValue(prefs(9));
    await performSync({ userInitiated: true });

    expect(await storedApplied()).toEqual({
      userId: USER,
      windowStart: NINE_MONTHS_AGO,
    });

    // Cycle 3 — same setting. Nothing is re-read and the cursor holds.
    const cursorAfterWiden = await getLastSyncTimestamp();
    mockSendMessages.mockClear();
    await performSync({ userInitiated: true });

    expect(sentIds()).toEqual(new Set());
    expect(await getLastSyncTimestamp()).toBe(cursorAfterWiden);
  });
});

// ---------------------------------------------------------------------------
// 2. "All time" is the WIDEST case, not "no window information"
// ---------------------------------------------------------------------------

describe('widening to "All time" lowers the floor to the beginning', () => {
  /**
   * MUTATION that must go red: make `isWidening` return false when
   * `resolvedStart === null`. This is the likeliest place for a vacuously-green
   * control, so the assertion is an exact id SET including a 2018 message, plus
   * the absence of any `minDate` on the provider call.
   */
  it('an explicit null lookback re-reads everything, including pre-window history', async () => {
    const ancient = row(821, NOW - 3000 * DAY);
    const recent = row(822, NOW - DAY);
    const { calls } = installPagingSms({ inbox: [ancient, recent] });

    await performSync();
    expect(sentIds()).toEqual(new Set(['822']));

    mockPrefRow.mockResolvedValue(prefs(null)); // "All time"
    mockSendMessages.mockClear();
    const callsBefore = calls.length;

    await performSync({ userInitiated: true });

    expect(sentIds()).toEqual(new Set(['821', '822']));
    expect(await getLastSyncTimestamp()).toBeGreaterThan(0);

    // readFrom is 0, and smsReader only sets minDate when it is > 0.
    for (const call of calls.slice(callsBefore)) {
      expect(call.minDate).toBeUndefined();
    }

    // Stored as an EXPLICIT null, which must not read back as "absent".
    expect(await storedApplied()).toEqual({ userId: USER, windowStart: null });
  });

  /**
   * The anti-loop case, and it is REACHABLE: the widening fires while the
   * cursor is already at or below the new floor, so the min-guard skips the
   * cursor write. The record must still be written.
   *
   * MUTATION that must go red: record the applied window only on the branch
   * that actually lowered the cursor. Cycle 3 then re-detects the same widening
   * and rewinds the cursor to 0 forever.
   */
  it('records the widening even when the cursor needed no lowering', async () => {
    // Cycle 1 — "Last 3 months" over a history that is ENTIRELY older than 3
    // months. Nothing is read, so the cursor stays at 0.
    const ancient = row(831, NOW - 3000 * DAY);
    const alsoOld = row(832, THREE_MONTHS_AGO - 10 * DAY);
    installPagingSms({ inbox: [ancient, alsoOld] });

    await performSync();
    expect(sentIds()).toEqual(new Set());
    expect(await getLastSyncTimestamp()).toBe(0);

    // Cycle 2 — "All time". Widening fires; the floor is 0 and so is the
    // cursor, so nothing is lowered — but the record must be written.
    mockPrefRow.mockResolvedValue(prefs(null));
    mockSendMessages.mockClear();
    await performSync({ userInitiated: true });

    expect(sentIds()).toEqual(new Set(['831', '832']));
    expect(await storedApplied()).toEqual({ userId: USER, windowStart: null });
    const cursorAfterCycle2 = await getLastSyncTimestamp();
    expect(cursorAfterCycle2).toBeGreaterThan(0);

    // Cycle 3 — unchanged setting. The cursor must NOT be rewound to 0.
    mockSendMessages.mockClear();
    await performSync({ userInitiated: true });

    expect(sentIds()).toEqual(new Set());
    expect(await getLastSyncTimestamp()).toBe(cursorAfterCycle2);
  });
});

// ---------------------------------------------------------------------------
// 3. THE FIRST OBSERVATION MUST NOT RE-READ (constraint 4)
// ---------------------------------------------------------------------------

describe('an upgrading phone with no stored applied window', () => {
  /**
   * A pre-BACKLOG-3017 build wrote the cursor, the queue and the window cache,
   * and did not write the applied-window key — because it did not exist. This
   * removes exactly that one key after a real cycle, which is the state the
   * upgrade produces; everything else is genuine.
   *
   * MUTATION that must go red: make `isWidening` return true for an absent
   * record. Every installed phone re-reads its whole window on upgrade.
   */
  it('records the window without lowering the cursor', async () => {
    const older = row(841, NINE_MONTHS_AGO + 10 * DAY);
    const recent = row(842, NOW - DAY);
    installPagingSms({ inbox: [older, recent] });

    await performSync();
    const cursorBefore = await getLastSyncTimestamp();

    // The upgrade: the record this item introduces does not exist yet, while a
    // 9-month setting is already stored (widening WOULD fire if it did).
    await AsyncStorage.removeItem(APPLIED_KEY);
    mockPrefRow.mockResolvedValue(prefs(9));
    mockSendMessages.mockClear();

    await performSync({ userInitiated: true });

    // Nothing older was pulled back in, and the cursor did not move down.
    expect(sentIds()).toEqual(new Set());
    expect(await getLastSyncTimestamp()).toBe(cursorBefore);

    // The baseline is now recorded, so the NEXT widening is detectable.
    expect(await storedApplied()).toEqual({
      userId: USER,
      windowStart: NINE_MONTHS_AGO,
    });
  });
});

// ---------------------------------------------------------------------------
// 4. NARROWING STILL BEHAVES AS max(cursor, windowStart)
// ---------------------------------------------------------------------------

describe('narrowing the window is not a widening', () => {
  /**
   * The 2800 suite's narrowing test asserts a CUMULATIVE id set and a
   * monotonic cursor, so it stays green even if narrowing wrongly rewinds:
   * the re-sent ids are already in the set and the cursor re-advances to the
   * same value. This control asserts the cycle-2 sends and the provider's
   * `minDate` instead.
   *
   * MUTATION that must go red: weaken `resolvedStart < applied.start` to
   * `resolvedStart !== applied.start`.
   */
  it('9 -> 3 months re-reads nothing and leaves the cursor alone', async () => {
    mockPrefRow.mockResolvedValue(prefs(9));
    const older = row(851, NINE_MONTHS_AGO + 10 * DAY);
    const recent = row(852, NOW - DAY);
    const { calls } = installPagingSms({ inbox: [older, recent] });

    await performSync();
    expect(sentIds()).toEqual(new Set(['851', '852']));
    const cursorBefore = await getLastSyncTimestamp();

    mockPrefRow.mockResolvedValue(prefs(3));
    mockSendMessages.mockClear();
    const callsBefore = calls.length;

    await performSync({ userInitiated: true });

    expect(sentIds()).toEqual(new Set());
    expect(await getLastSyncTimestamp()).toBe(cursorBefore);

    // The floor is the CURSOR, which is above the 3-month edge — the narrowed
    // window trails harmlessly below it.
    const cycle2 = calls.slice(callsBefore);
    expect(cycle2.length).toBeGreaterThan(0);
    for (const call of cycle2) {
      expect(call.minDate).toBe(cursorBefore);
    }

    // The low-water mark stays at the widest edge ever applied, so widening
    // back to 9 months is correctly a no-op rather than a pointless re-read.
    expect(await storedApplied()).toEqual({
      userId: USER,
      windowStart: NINE_MONTHS_AGO,
    });
  });
});

// ---------------------------------------------------------------------------
// 5. AN OUTAGE IS NOT A USER DECISION (the null-vs-unknown discriminator)
// ---------------------------------------------------------------------------

describe('a window that could not be resolved never counts as a widening', () => {
  /**
   * The fail-open ladder returns "no lower bound" when Supabase is unreachable
   * and nothing is cached. If that collapses into the same `null` an explicit
   * "All time" produces, an OUTAGE rewinds the cursor to zero and — far worse —
   * records All-time coverage, which permanently blinds every future widening.
   *
   * MUTATION that must go red: drop the `resolution.kind === 'known'` guard in
   * backgroundSync (or make `reportUnwindowed` return `{ kind: 'known',
   * start: null }`).
   */
  it('a Supabase outage leaves the cursor and the applied record untouched', async () => {
    const ancient = row(861, NOW - 3000 * DAY);
    const recent = row(862, NOW - DAY);
    installPagingSms({ inbox: [ancient, recent] });

    await performSync();
    const cursorBefore = await getLastSyncTimestamp();
    expect(await storedApplied()).toEqual({
      userId: USER,
      windowStart: THREE_MONTHS_AGO,
    });

    // Nothing cached and the query fails: the ladder reaches its terminal rung.
    await AsyncStorage.removeItem('@keepr/sync-window');
    mockPrefRow.mockResolvedValue({
      data: null,
      error: { code: '500', message: 'boom' },
    });
    mockSendMessages.mockClear();

    await performSync({ userInitiated: true });

    // Unwindowed means "read from the cursor", exactly as before this item.
    expect(sentIds()).toEqual(new Set());
    expect(await getLastSyncTimestamp()).toBe(cursorBefore);
    expect(await storedApplied()).toEqual({
      userId: USER,
      windowStart: THREE_MONTHS_AGO,
    });
  });
});

// ---------------------------------------------------------------------------
// 6. ORDERING IS LOAD-BEARING (constraint 5)
// ---------------------------------------------------------------------------

describe('the cursor is lowered BEFORE the applied window is recorded', () => {
  /**
   * A crash between the two writes must cost a harmless repeat, never a lost
   * re-read. The opposite order records the claim first, so a crash leaves the
   * phone believing it has read from an edge it never reached.
   *
   * MUTATION that must go red: swap the two awaits in backgroundSync.
   */
  it('writes @keepr/last-sync-timestamp before @keepr/sync-window-applied', async () => {
    const older = row(871, NINE_MONTHS_AGO + 10 * DAY);
    const recent = row(872, NOW - DAY);
    installPagingSms({ inbox: [older, recent] });

    await performSync();

    mockPrefRow.mockResolvedValue(prefs(9));
    (AsyncStorage.setItem as unknown as jest.Mock).mockClear();

    await performSync({ userInitiated: true });

    const relevant = setItemCalls().filter(
      ([key]) => key === CURSOR_KEY || key === APPLIED_KEY,
    );
    // The lowering write, the record, then the post-read advance.
    expect(relevant[0]).toEqual([CURSOR_KEY, String(NINE_MONTHS_AGO)]);
    expect(relevant[1]?.[0]).toBe(APPLIED_KEY);
  });
});

// ---------------------------------------------------------------------------
// 7. THE USER MUST BE ABLE TO SEE THE CHANGE THEY JUST MADE
// ---------------------------------------------------------------------------

describe('a manual Sync Now re-reads the setting through a fresh cache', () => {
  /**
   * The founder's stated acceptance procedure is "change the setting, hit Sync
   * Now, no re-pair". The window cache has a one-hour TTL and the cursor is not
   * zero on that cycle, so without `userInitiated` the phone applies the OLD
   * cached value and the widening lands up to an hour late — the fix would be
   * correct and still look broken.
   *
   * MUTATION that must go red: drop `!userInitiated` from the fresh-cache guard
   * in `resolveWindowStart`.
   */
  it('a background cycle keeps the cached window; the manual tap picks up the change', async () => {
    const older = row(881, NINE_MONTHS_AGO + 10 * DAY);
    const recent = row(882, NOW - DAY);
    installPagingSms({ inbox: [older, recent] });

    await performSync(); // caches "3 months" at NOW
    expect(sentIds()).toEqual(new Set(['882']));

    mockPrefRow.mockResolvedValue(prefs(9));

    // A background cycle within the TTL still sees the cached 3 months.
    mockSendMessages.mockClear();
    await performSync();
    expect(sentIds()).toEqual(new Set());

    // The same clock, the same fresh cache — but the user tapped Sync Now.
    mockSendMessages.mockClear();
    await performSync({ userInitiated: true });
    expect(sentIds()).toEqual(new Set(['881', '882']));
  });
});

// ---------------------------------------------------------------------------
// 8. THE RECORD IS A PER-PAIRING CLAIM
// ---------------------------------------------------------------------------

describe('resetMessageCursor forgets the applied window with the cursor', () => {
  /**
   * "This phone has read from edge E" is only true of the pairing that received
   * it. BACKLOG-2995 resets the cursor precisely when the desktop database has
   * been wiped, and a surviving All-time record would then make the user's
   * "widen back to All time to recover my history" a no-op with no recourse.
   *
   * MUTATION that must go red: delete the `clearAppliedWindow()` call.
   */
  it('clears the record so the next cycle is a first observation', async () => {
    installPagingSms({ inbox: [row(891, NOW - DAY)] });
    await performSync();
    expect(await storedApplied()).toBeDefined();

    await resetMessageCursor();

    expect(await storedApplied()).toBeUndefined();
    expect(await getLastSyncTimestamp()).toBe(0);
  });
});
