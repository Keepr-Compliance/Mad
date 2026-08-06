/**
 * smsReader.rawToSyncMessage — direction + sender mapping guards.
 *
 * This pure mapper turns a raw `content://sms` row into a SyncMessage. It has
 * TWO prior regressions worth pinning:
 *
 *   BACKLOG-1459 (direction): raw.type was undefined/null for some sent-box
 *     queries, so the old `?? SMS_TYPE_INBOX` fallback mislabelled everything
 *     inbound. The fix makes the EXPLICIT `box` argument authoritative; raw.type
 *     is a secondary signal only when no box is provided.
 *
 *   BACKLOG-1493 (empty sender): the Android provider can return an empty/null
 *     address (carrier alerts, voicemail). An empty sender would let the message
 *     be silently dropped, so it must fall back to "unknown".
 *
 * Assertions check exact field VALUES (direction/sender/body/timestamp), not
 * shapes — a wrong direction with the right shape must fail.
 */

// Minimal react-native mock so we can flip Platform.OS and install a fake
// native Sms module (BACKLOG-2206 read-path tests). phoneNormalization has no
// react-native dependency, so the pure rawToSyncMessage tests are unaffected.
jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  NativeModules: {} as Record<string, unknown>,
}));

import { NativeModules, Platform } from 'react-native';
import {
  rawToSyncMessage,
  readSmsMessages,
  smsReadErrorMessage,
  smsPermissionBannerCopy,
  SMS_READ_PAGE_SIZE,
  type RawSmsRecord,
} from '../smsReader';

/** Build a raw SMS row, overriding only the fields a case cares about. */
const rawRecord = (overrides: Partial<RawSmsRecord> = {}): RawSmsRecord => ({
  _id: '1',
  thread_id: '10',
  address: '+15555550112',
  body: 'hello',
  date: '1700000000000',
  date_sent: '1700000000000',
  type: '1',
  read: '1',
  ...overrides,
});

describe('rawToSyncMessage — direction mapping', () => {
  // box + expected direction (box is authoritative — BACKLOG-1459).
  const boxCases: Array<['inbox' | 'sent', 'inbound' | 'outbound']> = [
    ['inbox', 'inbound'],
    ['sent', 'outbound'],
  ];

  it.each(boxCases)(
    'box=%s => direction=%s (box is authoritative over raw.type)',
    (box, expected) => {
      // Deliberately give a CONFLICTING raw.type to prove box wins.
      const conflictingType = box === 'sent' ? '1' /* inbox */ : '2'; /* sent */
      const msg = rawToSyncMessage(rawRecord({ type: conflictingType }), box);
      expect(msg.direction).toBe(expected);
    }
  );

  // Fallback path: no box provided -> use raw.type ("2" = sent, else inbound).
  const typeCases: Array<[string | undefined | null, 'inbound' | 'outbound']> = [
    ['2', 'outbound'], // MESSAGE_TYPE_SENT
    ['1', 'inbound'], // MESSAGE_TYPE_INBOX
    [undefined, 'inbound'], // BACKLOG-1459: missing type -> inbound (not crash)
    [null, 'inbound'], // null type -> inbound
    ['5', 'inbound'], // FAILED -> not sent -> inbound
  ];

  it.each(typeCases)(
    'no box, raw.type=%s => direction=%s',
    (type, expected) => {
      const msg = rawToSyncMessage(
        rawRecord({ type: type as unknown as string }),
        undefined
      );
      expect(msg.direction).toBe(expected);
    }
  );
});

describe('rawToSyncMessage — sender / address handling (BACKLOG-1493)', () => {
  it('empty address falls back to "unknown" (message never dropped)', () => {
    const msg = rawToSyncMessage(rawRecord({ address: '' }), 'inbox');
    expect(msg.sender).toBe('unknown');
  });

  it('whitespace-only address falls back to "unknown"', () => {
    const msg = rawToSyncMessage(rawRecord({ address: '   ' }), 'inbox');
    expect(msg.sender).toBe('unknown');
  });

  it('null address falls back to "unknown"', () => {
    const msg = rawToSyncMessage(
      rawRecord({ address: null as unknown as string }),
      'inbox'
    );
    expect(msg.sender).toBe('unknown');
  });

  it('numeric address is normalized to E.164', () => {
    const msg = rawToSyncMessage(rawRecord({ address: '5555550112' }), 'inbox');
    expect(msg.sender).toBe('+15555550112');
  });

  it('alphanumeric sender is preserved (carrier alert not hidden)', () => {
    const msg = rawToSyncMessage(rawRecord({ address: 'T-Mobile' }), 'inbox');
    expect(msg.sender).toBe('T-Mobile');
  });
});

describe('rawToSyncMessage — timestamp + passthrough fields', () => {
  it('prefers date_sent when it is non-zero', () => {
    const msg = rawToSyncMessage(
      rawRecord({ date: '1700000000000', date_sent: '1699999999000' }),
      'inbox'
    );
    expect(msg.timestamp).toBe(1699999999000);
  });

  it('falls back to date when date_sent is zero', () => {
    const msg = rawToSyncMessage(
      rawRecord({ date: '1700000000000', date_sent: '0' }),
      'inbox'
    );
    expect(msg.timestamp).toBe(1700000000000);
  });

  it('carries body, threadId, and smsId through unchanged', () => {
    const msg = rawToSyncMessage(
      rawRecord({ _id: '42', thread_id: '7', body: 'the text' }),
      'inbox'
    );
    expect(msg.body).toBe('the text');
    expect(msg.threadId).toBe('7');
    expect(msg.smsId).toBe('42');
  });

  it('leaves smsId undefined when the native row has no _id', () => {
    const msg = rawToSyncMessage(
      rawRecord({ _id: '' as unknown as string }),
      'inbox'
    );
    expect(msg.smsId).toBeUndefined();
  });
});

describe('rawToSyncMessage — dedup id stability (BACKLOG-2202)', () => {
  // The desktop derives its uniqueness key as SHA-256(`sender|timestamp|body`)
  // (electron/services/localSyncService.ts generateExternalId). So the mapper
  // must emit the SAME `sender`, `timestamp`, and `body` for the SAME underlying
  // SMS on every independent read — otherwise the desktop hashes it twice and
  // stores a duplicate instead of an INSERT-OR-IGNORE no-op.

  /** The exact tuple the desktop hashes into external_id. */
  const desktopHashInput = (m: { sender: string; timestamp: number; body: string }) =>
    `${m.sender}|${m.timestamp}|${m.body}`;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('a date-less record yields a DETERMINISTIC timestamp across reads (never time-at-read)', () => {
    // Both date fields unparseable -> the fallback branch. Under the old
    // `Date.now()` fallback these two reads would get DIFFERENT timestamps;
    // the spy makes that failure mode explicit (increasing clock per call).
    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(2000);

    const dateless = rawRecord({ date: '', date_sent: '' });
    const read1 = rawToSyncMessage(dateless, 'inbox');
    const read2 = rawToSyncMessage(dateless, 'inbox');

    // Deterministic sentinel, not the mocked clock values.
    expect(read1.timestamp).toBe(0);
    expect(read2.timestamp).toBe(0);
    // The desktop hash input is identical -> same external_id -> dedup no-op.
    expect(desktopHashInput(read2)).toBe(desktopHashInput(read1));
    // Regression guard: the volatile clock must NOT have leaked into the id.
    expect(nowSpy).not.toHaveReturnedWith(read1.timestamp);
  });

  it('a normal record is stable across reads (timestamp is intrinsic, not read-time)', () => {
    const raw = rawRecord({ date: '1700000000000', date_sent: '0' });
    const a = rawToSyncMessage(raw, 'inbox');
    const b = rawToSyncMessage(raw, 'inbox');
    expect(b.timestamp).toBe(a.timestamp);
    expect(desktopHashInput(b)).toBe(desktopHashInput(a));
  });

  it('two genuinely different messages produce different desktop hash inputs (no collision)', () => {
    const base = rawRecord({ address: '+15551230000', body: 'same body', date: '1700000000000', date_sent: '0' });
    const differentBody = rawToSyncMessage(rawRecord({ ...base, body: 'other body' }), 'inbox');
    const differentSender = rawToSyncMessage(rawRecord({ ...base, address: '+15559990000' }), 'inbox');
    const differentTime = rawToSyncMessage(rawRecord({ ...base, date: '1700000009999' }), 'inbox');
    const original = rawToSyncMessage(base, 'inbox');

    const ids = new Set(
      [original, differentBody, differentSender, differentTime].map(desktopHashInput)
    );
    // Four genuinely-distinct messages -> four distinct dedup ids.
    expect(ids.size).toBe(4);
  });
});

// ===========================================================================
// readSmsMessages — read FAILURE is never conflated with zero-results
// (BACKLOG-2206). A genuine empty inbox must be `{ ok:true, messages:[] }`;
// a failed read (permission revoked, provider/query error, missing module,
// unparseable payload) must be `{ ok:false, error }` — NEVER swallowed to `[]`.
// ===========================================================================

type SmsListFn = (
  filterJson: string,
  failCb: (fail: string) => void,
  successCb: (count: number, smsList: string) => void,
) => void;

/** Install a fake native Sms module whose `list` behaves per the test. */
function installSms(list: SmsListFn): void {
  (NativeModules as unknown as { Sms?: { list: SmsListFn } }).Sms = { list };
}
/** Simulate the native module being absent (the BACKLOG-1448 class). */
function removeSms(): void {
  (NativeModules as unknown as { Sms?: unknown }).Sms = undefined;
}

/** A native `list` that always fails via the failure callback. */
const listAlwaysFails =
  (fail: string): SmsListFn =>
  (_filter, failCb) =>
    failCb(fail);
/** A native `list` that returns the given raw JSON string via the success cb. */
const listReturnsJson =
  (json: string): SmsListFn =>
  (_filter, _failCb, successCb) =>
    successCb(0, json);

beforeEach(() => {
  (Platform as unknown as { OS: string }).OS = 'android';
  removeSms();
});

describe('readSmsMessages — failure vs zero-results (BACKLOG-2206)', () => {
  it('a native query failure resolves to a read ERROR (query_failed), never []', async () => {
    installSms(listAlwaysFails('content resolver blew up'));
    const result = await readSmsMessages(0, 100);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a read failure');
    expect(result.error.reason).toBe('query_failed');
    expect(result.error.message).toContain('content resolver');
  });

  it('a permission-denied failure classifies as permission_denied', async () => {
    installSms(listAlwaysFails('READ_SMS permission denied by user'));
    const result = await readSmsMessages(0, 100);
    if (result.ok) throw new Error('expected a read failure');
    expect(result.error.reason).toBe('permission_denied');
  });

  it('an unparseable native payload classifies as parse_failed', async () => {
    installSms(listReturnsJson('this is not json'));
    const result = await readSmsMessages(0, 100);
    if (result.ok) throw new Error('expected a read failure');
    expect(result.error.reason).toBe('parse_failed');
  });

  it('a missing native module is module_unavailable — a wrong/absent module can no longer read as 0', async () => {
    removeSms();
    const result = await readSmsMessages(0, 100);
    if (result.ok) throw new Error('expected a read failure');
    expect(result.error.reason).toBe('module_unavailable');
  });

  it('a genuinely empty inbox is an explicit empty-SUCCESS ({ ok:true, messages:[] })', async () => {
    installSms(listReturnsJson('[]'));
    const result = await readSmsMessages(0, 100);
    expect(result).toEqual({ ok: true, messages: [] });
  });

  it('a non-positive budget (back-pressure) is an intentional empty-SUCCESS, not a failure', async () => {
    // Even with a working module, maxCount<=0 means "read nothing on purpose".
    installSms(listReturnsJson('[]'));
    const result = await readSmsMessages(0, 0);
    expect(result).toEqual({ ok: true, messages: [] });
  });

  it('a successful read returns ok with the mapped messages', async () => {
    const rows = JSON.stringify([
      rawRecord({ _id: '7', address: '+15551230000', body: 'hi' }),
    ]);
    installSms(listReturnsJson(rows));
    const result = await readSmsMessages(0, 100);
    if (!result.ok) throw new Error('expected a successful read');
    // Both boxes read the same fake row -> inbox + sent = 2 mapped messages.
    expect(result.messages.length).toBe(2);
    expect(result.messages.every((m) => m.body === 'hi')).toBe(true);
  });

  it('if EITHER box fails, the whole read fails — an untrusted partial is not returned', async () => {
    // inbox (first list call) succeeds empty; sent (second) errors.
    let call = 0;
    installSms((_filter, failCb, successCb) => {
      call += 1;
      if (call === 1) successCb(0, '[]');
      else failCb('sent box cursor error');
    });
    const result = await readSmsMessages(0, 100);
    expect(result.ok).toBe(false);
  });
});

// ===========================================================================
// readSmsMessages — PAGINATION (BACKLOG-2207).
//
// A single native list() capped at `maxCount` used to leave everything beyond
// the cap unread for the cycle (silent loss on a heavy day / large first sync).
// The read path now PAGES: it pulls SMS_READ_PAGE_SIZE-row batches via the
// content-provider `indexFrom` offset (oldest-first) and loops until the
// since-cursor backlog is exhausted OR the per-box budget is reached. Beyond the
// budget the remainder is RETAINED (cursor held upstream), never dropped.
//
// These tests drive a fixture-backed native module that honours the real
// SmsModule.list contract (box, minDate>=, sortOrder date ASC, indexFrom,
// maxCount) so pagination is exercised end-to-end. Per the repo rule, they
// assert exact ID SETS/sequences (identity), not just counts.
// ===========================================================================

/** Parsed view of the filter the reader passes to a native list() page call. */
interface PageCall {
  box: 'inbox' | 'sent';
  indexFrom: number;
  maxCount: number;
  minDate?: number;
}

/** Build `n` oldest-first raw rows with unique _id / address / body / date. */
function makeRows(
  n: number,
  opts: { startId?: number; startDate?: number } = {}
): RawSmsRecord[] {
  const startId = opts.startId ?? 1;
  const startDate = opts.startDate ?? 1_700_000_000_000;
  return Array.from({ length: n }, (_, i) =>
    rawRecord({
      _id: String(startId + i),
      address: `+1555${String(1_000_000 + startId + i)}`,
      body: `msg-${startId + i}`,
      date: String(startDate + i),
      date_sent: String(startDate + i),
    })
  );
}

/**
 * Install a native Sms module that serves fixtures with REAL offset paging,
 * emulating SmsModule.list: filter by minDate (date >= minDate), sort date ASC,
 * then return the `[indexFrom, indexFrom + maxCount)` slice. Records every page
 * call so tests can assert the paging walk (offsets / sizes / call counts).
 */
function installPagingSms(
  fixture: { inbox?: RawSmsRecord[]; sent?: RawSmsRecord[] },
  failOn?: (call: PageCall) => string | null
): { calls: PageCall[] } {
  const store = { inbox: fixture.inbox ?? [], sent: fixture.sent ?? [] };
  const calls: PageCall[] = [];

  installSms((filterJson, failCb, successCb) => {
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

    const failMsg = failOn?.(call);
    if (failMsg) {
      failCb(failMsg);
      return;
    }

    const source = call.box === 'sent' ? store.sent : store.inbox;
    const minDate = call.minDate;
    const matched = (
      minDate !== undefined
        ? source.filter((r) => Number(r.date) >= minDate)
        : source.slice()
    ).sort((a, b) => Number(a.date) - Number(b.date));

    const page =
      call.maxCount > 0
        ? matched.slice(call.indexFrom, call.indexFrom + call.maxCount)
        : matched.slice(call.indexFrom);

    // First cb arg (`_count`) is ignored by the reader; mirror the native
    // "matching rows iterated" value loosely — the reader keys off page length.
    successCb(matched.length, JSON.stringify(page));
  });

  return { calls };
}

const idsOf = (msgs: Array<{ smsId?: string }>): Array<string | undefined> =>
  msgs.map((m) => m.smsId);

describe('readSmsMessages — pagination (BACKLOG-2207)', () => {
  it('reads ALL messages across multiple pages when the backlog exceeds one page (no drop)', async () => {
    // 2.25 pages of inbox backlog, budget comfortably above it -> everything read.
    const total = SMS_READ_PAGE_SIZE * 2 + 50;
    const inbox = makeRows(total);
    const { calls } = installPagingSms({ inbox });

    const result = await readSmsMessages(0, total + 100);
    if (!result.ok) throw new Error('expected a successful read');

    // Exact identity: every backlog id, exactly once (no skip, no dup).
    expect(idsOf(result.messages).sort()).toEqual(
      inbox.map((r) => r._id).sort()
    );
    expect(result.messages.length).toBe(total);

    // Inbox was walked across 3 pages via advancing offsets (sent was empty).
    const inboxCalls = calls.filter((c) => c.box === 'inbox');
    expect(inboxCalls.map((c) => c.indexFrom)).toEqual([
      0,
      SMS_READ_PAGE_SIZE,
      SMS_READ_PAGE_SIZE * 2,
    ]);
  });

  it('exact-multiple of the page size reads a trailing empty page to confirm exhaustion', async () => {
    const total = SMS_READ_PAGE_SIZE * 2; // 2 full pages, nothing extra
    const inbox = makeRows(total);
    const { calls } = installPagingSms({ inbox });

    const result = await readSmsMessages(0, total + 100);
    if (!result.ok) throw new Error('expected a successful read');

    expect(result.messages.length).toBe(total);
    expect(idsOf(result.messages).sort()).toEqual(inbox.map((r) => r._id).sort());

    // page1 (200) + page2 (200, full -> maybe more) + page3 (empty -> exhausted).
    const inboxOffsets = calls
      .filter((c) => c.box === 'inbox')
      .map((c) => c.indexFrom);
    expect(inboxOffsets).toEqual([0, SMS_READ_PAGE_SIZE, SMS_READ_PAGE_SIZE * 2]);
  });

  it('a partial last page ends the walk (short page = exhausted)', async () => {
    const total = SMS_READ_PAGE_SIZE + 30; // 1 full + 1 partial page
    const inbox = makeRows(total);
    const { calls } = installPagingSms({ inbox });

    const result = await readSmsMessages(0, total + 100);
    if (!result.ok) throw new Error('expected a successful read');

    expect(result.messages.length).toBe(total);
    expect(idsOf(result.messages).sort()).toEqual(inbox.map((r) => r._id).sort());
    // Two pages only — the short second page signals exhaustion, no 3rd call.
    expect(calls.filter((c) => c.box === 'inbox').map((c) => c.indexFrom)).toEqual([
      0,
      SMS_READ_PAGE_SIZE,
    ]);
  });

  it('a single sub-page backlog is read in ONE call (behaviour unchanged)', async () => {
    const inbox = makeRows(50); // < SMS_READ_PAGE_SIZE
    const { calls } = installPagingSms({ inbox });

    const result = await readSmsMessages(0, 250);
    if (!result.ok) throw new Error('expected a successful read');

    expect(result.messages.length).toBe(50);
    // Exactly one native page per box (inbox has data, sent empty single page).
    expect(calls.filter((c) => c.box === 'inbox').length).toBe(1);
    expect(calls.filter((c) => c.box === 'inbox')[0].indexFrom).toBe(0);
  });

  it('a page failure mid-walk fails the WHOLE read (partial never returned, cursor held upstream)', async () => {
    const inbox = makeRows(SMS_READ_PAGE_SIZE * 2 + 10);
    // Fail the SECOND inbox page (offset = page size). Deterministic under the
    // concurrent inbox/sent reads because it keys off the filter, not call order.
    const { calls } = installPagingSms({ inbox }, (c) =>
      c.box === 'inbox' && c.indexFrom === SMS_READ_PAGE_SIZE
        ? 'content resolver cursor error on page 2'
        : null
    );

    const result = await readSmsMessages(0, 5000);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a read failure');
    expect(result.error.reason).toBe('query_failed');
    // Proof the first page WAS read before the failure aborted the walk.
    expect(
      calls.some((c) => c.box === 'inbox' && c.indexFrom === 0)
    ).toBe(true);
  });

  it('preserves ordering — merged result is strictly ascending with a gap-free id sequence', async () => {
    // Interleave inbox/sent by timestamp so the merge sort is actually exercised.
    const inbox = makeRows(SMS_READ_PAGE_SIZE + 20, {
      startId: 1,
      startDate: 1_700_000_000_000,
    }).map((r, i) => ({ ...r, date: String(1_700_000_000_000 + i * 2), date_sent: String(1_700_000_000_000 + i * 2) }));
    const sent = makeRows(30, { startId: 10_000, startDate: 1_700_000_000_001 }).map(
      (r, i) => ({ ...r, date: String(1_700_000_000_001 + i * 2), date_sent: String(1_700_000_000_001 + i * 2) })
    );
    installPagingSms({ inbox, sent });

    const result = await readSmsMessages(0, 5000);
    if (!result.ok) throw new Error('expected a successful read');

    // Strictly ascending timestamps (cursor stays monotonic; no reorder).
    for (let i = 1; i < result.messages.length; i++) {
      expect(result.messages[i].timestamp).toBeGreaterThanOrEqual(
        result.messages[i - 1].timestamp
      );
    }
    // Every id from both boxes present exactly once — no skip, no duplicate.
    const expected = [...inbox, ...sent].map((r) => r._id).sort();
    expect(idsOf(result.messages).sort()).toEqual(expected);
    // Within the inbox stream the ids are the contiguous 1..N prefix (gap-free).
    const inboxIds = result.messages
      .filter((m) => Number(m.smsId) < 10_000)
      .map((m) => Number(m.smsId))
      .sort((a, b) => a - b);
    expect(inboxIds).toEqual(inbox.map((r) => Number(r._id)).sort((a, b) => a - b));
  });

  it('back-pressure: a backlog larger than the budget reads the OLDEST budget slice and RETAINS the rest', async () => {
    const budget = 250; // per-box ceiling (e.g. remaining queue capacity / 2)
    const total = 400; // backlog exceeds the budget by 150
    const inbox = makeRows(total); // ids 1..400, oldest-first
    const { calls } = installPagingSms({ inbox });

    const result = await readSmsMessages(0, budget);
    if (!result.ok) throw new Error('expected a successful read');

    // Capped at the budget (so backgroundSync sees a truncated read -> holds cursor).
    expect(result.messages.length).toBe(budget);
    // The read is the OLDEST contiguous prefix (ids 1..250).
    const readIds = result.messages.map((m) => Number(m.smsId)).sort((a, b) => a - b);
    expect(readIds).toEqual(inbox.slice(0, budget).map((r) => Number(r._id)));
    // The remaining 150 (ids 251..400) were NOT read — retained for next cycle.
    const readSet = new Set(readIds);
    expect(inbox.slice(budget).every((r) => !readSet.has(Number(r._id)))).toBe(true);
    // And we never paged past the budget window (max offset < budget).
    const maxInboxOffset = Math.max(
      ...calls.filter((c) => c.box === 'inbox').map((c) => c.indexFrom)
    );
    expect(maxInboxOffset).toBeLessThan(budget);
  });

  it('respects minDate while paging (only messages at/after the cursor are read)', async () => {
    const base = 1_700_000_000_000;
    // 300 rows; cursor sits so only the newest 220 (>= cursor) are eligible.
    const inbox = makeRows(300, { startDate: base });
    const cursor = base + 80; // rows with date >= base+80 => ids 81..300 (220 rows)
    installPagingSms({ inbox });

    const result = await readSmsMessages(cursor, 5000);
    if (!result.ok) throw new Error('expected a successful read');

    const readIds = result.messages.map((m) => Number(m.smsId)).sort((a, b) => a - b);
    const eligible = inbox
      .filter((r) => Number(r.date) >= cursor)
      .map((r) => Number(r._id))
      .sort((a, b) => a - b);
    expect(readIds).toEqual(eligible);
    expect(readIds[0]).toBe(81); // first eligible id, nothing older leaked in
  });
});

describe('smsPermissionBannerCopy — adaptive "SMS access needed" copy (BACKLOG-2214)', () => {
  it('never_granted: uses grant-to-sync SETUP framing (not the revoked "no longer" wording)', () => {
    const copy = smsPermissionBannerCopy('never_granted');
    expect(copy.title).toBe('Grant SMS access to start syncing');
    // Actionable setup prompt — must NOT imply access was lost.
    expect(copy.body).toMatch(/needs permission to read your SMS/i);
    expect(copy.body).not.toMatch(/no longer/i);
  });

  it('revoked: reuses the EXACT shared permission_denied read-error copy (one surface, not a fork)', () => {
    const copy = smsPermissionBannerCopy('revoked');
    // Byte-identical to the 2206/2209 surface so the revoked banner is unified.
    expect(copy).toEqual(
      smsReadErrorMessage({ reason: 'permission_denied', message: '' }),
    );
    expect(copy.body).toMatch(/no longer has permission to read SMS/i);
  });

  it('the two causes render DIFFERENT copy from the SAME helper (adapts, stays one surface)', () => {
    expect(smsPermissionBannerCopy('never_granted')).not.toEqual(
      smsPermissionBannerCopy('revoked'),
    );
  });
});
