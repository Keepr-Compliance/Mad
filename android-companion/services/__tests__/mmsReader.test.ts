/**
 * mmsReader — the MMS read path (BACKLOG-2973).
 *
 * Two properties are load-bearing here, and both exist because breaking them
 * has already cost this product real data:
 *
 *   1. **A failed read is never an empty read** (BACKLOG-1448 / 2206). A wrong
 *      native-module name once returned zero messages for an entire release,
 *      invisibly, because every failure collapsed to `[]`. Every failure mode
 *      below therefore asserts an EXPLICIT reason, and the genuinely-empty case
 *      asserts `{ ok: true, messages: [] }` so the two stay distinguishable.
 *
 *   2. **The read is bounded and oldest-first** (BACKLOG-2199 / 2207): a
 *      `minDate` floor, a max count, and an advancing offset. This is the whole
 *      reason `react-native-get-mms-android` was rejected — its `getAllMMS()`
 *      has none of them. A reader that drops `minDate` silently re-reads all
 *      history every cycle; one that never advances the offset re-reads page 0
 *      forever. Both are asserted on the ARGUMENTS the native module actually
 *      received, not on the shape of the result.
 *
 * Every "it did not do X" assertion is paired with proof the read ACTUALLY RAN
 * and returned rows — an assertion about a call that never happened passes
 * vacuously and proves nothing.
 *
 * Phone numbers are from the reserved `+1 <area> 555-01xx` range.
 */

// The native module is looked up through `requireOptionalNativeModule`, so the
// "module is absent" case (the BACKLOG-1448 class) is reachable by returning
// null from this mock — exactly what an APK built without autolinking does.
let mockNativeModule: unknown = null;
jest.mock('expo', () => ({
  requireOptionalNativeModule: () => mockNativeModule,
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
}));

import { Platform } from 'react-native';
import {
  readMmsMessages,
  mmsDateToMillis,
  mmsReadErrorMessage,
  MMS_READ_PAGE_SIZE,
  MMS_MILLIS_MAGNITUDE_THRESHOLD,
  type RawMmsRecord,
} from '../mmsReader';

// ===========================================================================
// Fixtures — transcribed from the shape the provider returned on a live API-36
// emulator (BACKLOG-2973 spike). Reserved 555-01xx numbers only.
// ===========================================================================

/** One received MMS with a SMIL layout part, an image part and a text part. */
const receivedMms = (overrides: Partial<RawMmsRecord> = {}): RawMmsRecord => ({
  _id: '2',
  thread_id: '11',
  date: '1756600000',
  date_sent: '1756600000',
  msg_box: '1',
  m_type: '132',
  parts: [
    {
      _id: '3',
      seq: '-1',
      ct: 'application/smil',
      name: null,
      cl: '0.smil',
      chset: null,
      text: '<smil><body/></smil>',
      _data: null,
    },
    {
      _id: '7',
      seq: '0',
      ct: 'image/jpeg',
      name: 'IMG_0001.jpg',
      cl: 'IMG_0001.jpg',
      chset: null,
      text: null,
      _data: '/data/user_de/0/com.android.providers.telephony/app_parts/PART_1_IMG_0001.jpg',
    },
    {
      _id: '4',
      seq: '1',
      ct: 'text/plain',
      name: 'text_0.txt',
      cl: 'text_0.txt',
      chset: '106',
      text: 'Photo of the signed addendum',
      _data: null,
    },
  ],
  addrs: [
    { _id: '1', address: '+12065550111', type: '137', charset: '106' },
    { _id: '2', address: '+12065550100', type: '151', charset: '106' },
  ],
  ...overrides,
});

/** A minimal row, for cases that only care about identity/ordering. */
const row = (id: number, date: string): RawMmsRecord => ({
  _id: String(id),
  thread_id: '11',
  date,
  date_sent: date,
  msg_box: '1',
  m_type: '132',
  parts: [],
  addrs: [],
});

// ===========================================================================
// Fake native module
// ===========================================================================

type ListArgs = [minDate: number, indexFrom: number, maxCount: number];

/** Args of every native `list()` call, in order. */
let listCalls: ListArgs[] = [];

type ListImpl = (...args: ListArgs) => Promise<string>;

/** Install a fake KeeprMms module whose `list` behaves per the test. */
function installMms(impl: ListImpl): void {
  mockNativeModule = {
    list: (...args: ListArgs) => {
      listCalls.push(args);
      return impl(...args);
    },
  };
}

/** Simulate the native module being absent (the BACKLOG-1448 class). */
function removeMms(): void {
  mockNativeModule = null;
}

/** A `list` that always returns the given page payload. */
const listReturnsPage =
  (rows: RawMmsRecord[]): ListImpl =>
  async () =>
    JSON.stringify({ rawCount: rows.length, rows });

/** A `list` that always returns a verbatim string (valid JSON or not). */
const listReturnsRaw =
  (payload: string): ListImpl =>
  async () =>
    payload;

/** A `list` that always rejects with the given error. */
const listRejects =
  (err: unknown): ListImpl =>
  async () => {
    throw err;
  };

/** A native rejection shaped like Expo's — an Error carrying a `code`. */
function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

beforeEach(() => {
  (Platform as unknown as { OS: string }).OS = 'android';
  listCalls = [];
  removeMms();
});

// ===========================================================================
// Failure vs zero-results (BACKLOG-1448 / 2206)
// ===========================================================================

describe('readMmsMessages — a failed read is never an empty read', () => {
  it('a missing native module is module_unavailable, NOT 0 messages', async () => {
    removeMms();
    const result = await readMmsMessages(0, 100);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a read failure');
    expect(result.error.reason).toBe('module_unavailable');
  });

  it('a denied READ_SMS classifies as permission_denied (by native error CODE)', async () => {
    installMms(
      listRejects(
        codedError(
          'ERR_MMS_PERMISSION_DENIED',
          'READ_SMS permission is not granted, so the MMS store cannot be read'
        )
      )
    );
    const result = await readMmsMessages(0, 100);
    if (result.ok) throw new Error('expected a read failure');
    expect(result.error.reason).toBe('permission_denied');
    // The read was genuinely attempted — otherwise this asserts nothing.
    expect(listCalls.length).toBe(1);
  });

  it('a refused query (null cursor) classifies as query_failed', async () => {
    installMms(
      listRejects(
        codedError(
          'ERR_MMS_QUERY_FAILED',
          'content resolver returned a NULL cursor for content://mms (provider refused the query)'
        )
      )
    );
    const result = await readMmsMessages(0, 100);
    if (result.ok) throw new Error('expected a read failure');
    expect(result.error.reason).toBe('query_failed');
    expect(result.error.message).toContain('NULL cursor');
  });

  it('an UNRECOGNISED native error is query_failed — never treated as benign', async () => {
    // e.g. a lost React context, or a converter failure: no known code at all.
    installMms(listRejects(new Error('React Context has been lost')));
    const result = await readMmsMessages(0, 100);
    if (result.ok) throw new Error('expected a read failure');
    expect(result.error.reason).toBe('query_failed');
  });

  it('an unparseable native payload classifies as parse_failed', async () => {
    installMms(listReturnsRaw('this is not json'));
    const result = await readMmsMessages(0, 100);
    if (result.ok) throw new Error('expected a read failure');
    expect(result.error.reason).toBe('parse_failed');
  });

  it('a payload of the WRONG SHAPE is parse_failed, not a successful empty read', async () => {
    // Valid JSON, no `rows` array. Read naively this reports zero messages —
    // a failure wearing a successful read's clothes.
    installMms(listReturnsRaw('{"unexpected":true}'));
    const result = await readMmsMessages(0, 100);
    if (result.ok) throw new Error('expected a read failure');
    expect(result.error.reason).toBe('parse_failed');
  });

  it('a genuinely empty store is an explicit empty-SUCCESS', async () => {
    installMms(listReturnsPage([]));
    const result = await readMmsMessages(0, 100);
    expect(result).toEqual({ ok: true, messages: [] });
    // Proof the empty result came from a read that RAN, not from a short-circuit.
    expect(listCalls.length).toBe(1);
  });

  it('back-pressure (maxCount<=0) is an intentional empty-SUCCESS, not a failure', async () => {
    installMms(listReturnsPage([receivedMms()]));
    const result = await readMmsMessages(0, 0);
    expect(result).toEqual({ ok: true, messages: [] });
    // Deliberately did NOT query the provider — the cursor must not advance.
    expect(listCalls.length).toBe(0);
  });

  it('off-Android is an empty-SUCCESS and never touches the provider', async () => {
    (Platform as unknown as { OS: string }).OS = 'ios';
    installMms(listReturnsPage([receivedMms()]));
    const result = await readMmsMessages(0, 100);
    expect(result).toEqual({ ok: true, messages: [] });
    expect(listCalls.length).toBe(0);
  });

  it('the four failure reasons are DISTINCT — they never collapse into one', async () => {
    const reasons: string[] = [];

    removeMms();
    let r = await readMmsMessages(0, 100);
    if (!r.ok) reasons.push(r.error.reason);

    installMms(listRejects(codedError('ERR_MMS_PERMISSION_DENIED', 'denied')));
    r = await readMmsMessages(0, 100);
    if (!r.ok) reasons.push(r.error.reason);

    installMms(listRejects(codedError('ERR_MMS_QUERY_FAILED', 'boom')));
    r = await readMmsMessages(0, 100);
    if (!r.ok) reasons.push(r.error.reason);

    installMms(listReturnsRaw('nope'));
    r = await readMmsMessages(0, 100);
    if (!r.ok) reasons.push(r.error.reason);

    // Exact SET, not a count: a wrong reason with the right cardinality fails.
    expect(reasons).toEqual([
      'module_unavailable',
      'permission_denied',
      'query_failed',
      'parse_failed',
    ]);
  });
});

// ===========================================================================
// Bounding — the requirement the rejected library could not express
// (BACKLOG-2199 cursor / 2207 paging)
// ===========================================================================

describe('readMmsMessages — bounding: minDate floor', () => {
  it('passes the caller cursor to the provider as the minDate floor', async () => {
    const since = 1756600250000;
    installMms(listReturnsPage([row(3, '1756600500')]));

    const result = await readMmsMessages(since, 100);

    if (!result.ok) throw new Error('expected a successful read');
    // The read ran and returned a row — so the argument assertion is not vacuous.
    expect(result.messages.map((m) => m._id)).toEqual(['3']);
    expect(listCalls.length).toBe(1);
    expect(listCalls[0][0]).toBe(since);
  });

  it('carries the floor unchanged onto EVERY page, not just the first', async () => {
    const since = 1700000000000;
    const page0 = Array.from({ length: MMS_READ_PAGE_SIZE }, (_, i) =>
      row(i + 1, '1756600000')
    );
    let call = 0;
    installMms(async () => {
      call += 1;
      const rows = call === 1 ? page0 : [row(999, '1756600900')];
      return JSON.stringify({ rawCount: rows.length, rows });
    });

    const result = await readMmsMessages(since, MMS_READ_PAGE_SIZE + 50);

    if (!result.ok) throw new Error('expected a successful read');
    expect(result.messages.length).toBe(MMS_READ_PAGE_SIZE + 1);
    expect(listCalls.length).toBe(2);
    expect(listCalls.map((c) => c[0])).toEqual([since, since]);
  });
});

describe('readMmsMessages — bounding: max count', () => {
  it('never asks the provider for more than the budget', async () => {
    installMms(listReturnsPage([row(1, '1756600000'), row(2, '1756600100')]));

    const result = await readMmsMessages(0, 3);

    if (!result.ok) throw new Error('expected a successful read');
    expect(result.messages.length).toBe(2);
    expect(listCalls[0][2]).toBe(3);
  });

  it('caps a page at MMS_READ_PAGE_SIZE even when the budget is larger', async () => {
    const page0 = Array.from({ length: MMS_READ_PAGE_SIZE }, (_, i) =>
      row(i + 1, '1756600000')
    );
    let call = 0;
    installMms(async () => {
      call += 1;
      const rows = call === 1 ? page0 : [];
      return JSON.stringify({ rawCount: rows.length, rows });
    });

    const result = await readMmsMessages(0, MMS_READ_PAGE_SIZE + 50);

    if (!result.ok) throw new Error('expected a successful read');
    expect(result.messages.length).toBe(MMS_READ_PAGE_SIZE);
    // First page capped at the page size; the second asks only for the remainder.
    expect(listCalls.map((c) => c[2])).toEqual([MMS_READ_PAGE_SIZE, 50]);
  });

  it('a backlog larger than the budget returns the OLDEST budget slice and stops', async () => {
    // 5 rows available, budget 3: the provider is asked for 3 and the read ends.
    const available = [1, 2, 3, 4, 5].map((i) => row(i, `17566000${i}0`));
    installMms(async (_minDate, indexFrom, maxCount) => {
      const rows = available.slice(indexFrom, indexFrom + maxCount);
      return JSON.stringify({ rawCount: rows.length, rows });
    });

    const result = await readMmsMessages(0, 3);

    if (!result.ok) throw new Error('expected a successful read');
    // Exact ID set — a truncation that kept the NEWEST three would pass a count
    // assertion and strand history forever (BACKLOG-2199).
    expect(result.messages.map((m) => m._id)).toEqual(['1', '2', '3']);
    expect(listCalls.length).toBe(1);
  });
});

describe('readMmsMessages — bounding: offset advances across pages', () => {
  it('advances indexFrom by the rows consumed, so page 2 is not page 1 again', async () => {
    const available = Array.from({ length: MMS_READ_PAGE_SIZE + 3 }, (_, i) =>
      row(i + 1, '1756600000')
    );
    installMms(async (_minDate, indexFrom, maxCount) => {
      const rows = available.slice(indexFrom, indexFrom + maxCount);
      return JSON.stringify({ rawCount: rows.length, rows });
    });

    const result = await readMmsMessages(0, 1000);

    if (!result.ok) throw new Error('expected a successful read');
    expect(listCalls.map((c) => c[1])).toEqual([0, MMS_READ_PAGE_SIZE]);
    // Exact ID SET: an offset that never advanced would re-read page 0 and
    // produce duplicates with the same cardinality on a lucky slice.
    expect(result.messages.map((m) => m._id)).toEqual(
      available.map((r) => r._id)
    );
    expect(new Set(result.messages.map((m) => m._id)).size).toBe(
      available.length
    );
  });

  it('a page shorter than requested ends the walk (backlog exhausted)', async () => {
    installMms(listReturnsPage([row(1, '1756600000')]));
    const result = await readMmsMessages(0, 1000);
    if (!result.ok) throw new Error('expected a successful read');
    expect(result.messages.length).toBe(1);
    expect(listCalls.length).toBe(1);
  });

  it('a page failure mid-walk fails the WHOLE read — no partial is returned', async () => {
    const page0 = Array.from({ length: MMS_READ_PAGE_SIZE }, (_, i) =>
      row(i + 1, '1756600000')
    );
    let call = 0;
    installMms(async () => {
      call += 1;
      if (call === 1) {
        return JSON.stringify({ rawCount: page0.length, rows: page0 });
      }
      throw codedError('ERR_MMS_QUERY_FAILED', 'cursor died mid-walk');
    });

    const result = await readMmsMessages(0, 1000);

    // A partial set here would let the caller advance the cursor past unread
    // history — the read must fail outright.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a read failure');
    expect(result.error.reason).toBe('query_failed');
    // Both pages were genuinely attempted.
    expect(listCalls.length).toBe(2);
  });
});

// ===========================================================================
// The raw shape 2974 and 2975 build on
// ===========================================================================

describe('readMmsMessages — carries the provider rows through RAW', () => {
  it('keeps parts and addresses on the record (no second provider round trip)', async () => {
    installMms(listReturnsPage([receivedMms()]));
    const result = await readMmsMessages(0, 100);
    if (!result.ok) throw new Error('expected a successful read');

    const [message] = result.messages;
    expect(message._id).toBe('2');
    expect(message.thread_id).toBe('11');
    // Exact ID sets, not counts.
    expect(message.parts.map((p) => p._id)).toEqual(['3', '7', '4']);
    expect(message.addrs.map((a) => a.address)).toEqual([
      '+12065550111',
      '+12065550100',
    ]);
  });

  it('does NOT filter the SMIL layout part — that decision belongs to 2974', async () => {
    installMms(listReturnsPage([receivedMms()]));
    const result = await readMmsMessages(0, 100);
    if (!result.ok) throw new Error('expected a successful read');

    const parts = result.messages[0].parts;
    // Every part is carried, SMIL included, with its content type intact so 2974
    // can discriminate on `ct` rather than on the layout convention `seq`.
    expect(parts.map((p) => p.ct)).toEqual([
      'application/smil',
      'image/jpeg',
      'text/plain',
    ]);
  });

  it('does not invent a sender or a body — the record has neither field', async () => {
    installMms(listReturnsPage([receivedMms()]));
    const result = await readMmsMessages(0, 100);
    if (!result.ok) throw new Error('expected a successful read');

    // `content://mms` has NO `address` column and no body column. Synthesising
    // either would poison the desktop dedup hash SHA-256(sender|timestamp|body).
    const record = result.messages[0] as unknown as Record<string, unknown>;
    expect('sender' in record).toBe(false);
    expect('body' in record).toBe(false);
    expect('address' in record).toBe(false);
  });

  it('keeps the raw provider date unparsed on the record', async () => {
    installMms(listReturnsPage([receivedMms()]));
    const result = await readMmsMessages(0, 100);
    if (!result.ok) throw new Error('expected a successful read');
    expect(result.messages[0].date).toBe('1756600000');
  });
});

// ===========================================================================
// date unit — normalised by MAGNITUDE, because the provider's unit is not yet
// observed from a real writer
// ===========================================================================

describe('mmsDateToMillis — magnitude, not assumption', () => {
  it('a seconds-magnitude value is scaled to milliseconds', () => {
    expect(mmsDateToMillis('1756600000')).toBe(1756600000000);
  });

  it('a milliseconds-magnitude value is left alone', () => {
    expect(mmsDateToMillis('1412109700000')).toBe(1412109700000);
  });

  it('the boundary is exact on both sides', () => {
    // 1e11 ms = 1973-03-03; 1e11 s = year 5138. No real message sits near it.
    expect(mmsDateToMillis(String(MMS_MILLIS_MAGNITUDE_THRESHOLD))).toBe(
      MMS_MILLIS_MAGNITUDE_THRESHOLD
    );
    expect(mmsDateToMillis(String(MMS_MILLIS_MAGNITUDE_THRESHOLD - 1))).toBe(
      (MMS_MILLIS_MAGNITUDE_THRESHOLD - 1) * 1000
    );
  });

  it('an unusable value is null, never a plausible-looking wrong number', () => {
    // BACKLOG-2202: a Date.now() fallback made re-reads of the same row hash
    // differently every cycle. Null forces the caller to decide.
    expect(mmsDateToMillis(null)).toBeNull();
    expect(mmsDateToMillis(undefined)).toBeNull();
    expect(mmsDateToMillis('')).toBeNull();
    expect(mmsDateToMillis('not-a-number')).toBeNull();
    expect(mmsDateToMillis('-5')).toBeNull();
  });

  it('zero is a real value, not an absence', () => {
    expect(mmsDateToMillis('0')).toBe(0);
  });
});

// ===========================================================================
// Failure copy
// ===========================================================================

describe('mmsReadErrorMessage', () => {
  it('permission_denied gets the actionable re-grant copy', () => {
    const copy = mmsReadErrorMessage({ reason: 'permission_denied', message: '' });
    expect(copy.body).toContain('Settings');
  });

  it('every reason renders non-empty copy (no reason falls through to blank)', () => {
    const reasons = [
      'module_unavailable',
      'permission_denied',
      'query_failed',
      'parse_failed',
    ] as const;
    for (const reason of reasons) {
      const copy = mmsReadErrorMessage({ reason, message: '' });
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.body.length).toBeGreaterThan(0);
    }
  });
});
