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
  type RawSmsRecord,
} from '../smsReader';

/** Build a raw SMS row, overriding only the fields a case cares about. */
const rawRecord = (overrides: Partial<RawSmsRecord> = {}): RawSmsRecord => ({
  _id: '1',
  thread_id: '10',
  address: '+15551234567',
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
    const msg = rawToSyncMessage(rawRecord({ address: '5551234567' }), 'inbox');
    expect(msg.sender).toBe('+15551234567');
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
