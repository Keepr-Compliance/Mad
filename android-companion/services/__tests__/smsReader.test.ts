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

import { rawToSyncMessage, type RawSmsRecord } from '../smsReader';

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
