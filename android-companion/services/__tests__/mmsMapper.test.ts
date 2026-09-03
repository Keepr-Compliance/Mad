/**
 * mmsMapper — getting the TEXT out of an MMS (BACKLOG-2974).
 *
 * The one defect this suite exists to prevent: **every MMS carries a SMIL
 * layout part**, so a mapper that takes "the first part" ingests XML markup as
 * the message. Selection is by content type, and the control for that is a
 * fixture where the SMIL part IS first and the text part is not.
 *
 * Four further properties are load-bearing, each because collapsing it has
 * already cost this product data:
 *
 *   1. **A message with no text is not an empty string.** `""` is a body the
 *      desktop will hash — `SHA-256(sender|timestamp|body)` — so two photo-only
 *      messages from one person in one second would hash identically and one
 *      would be discarded as a duplicate that never existed (BACKLOG-2202).
 *   2. **A text part we could not read is not an empty message.** That is the
 *      BACKLOG-1448 / 2206 collapse at part granularity, and it is exactly what
 *      `react-native-get-mms-android` does.
 *   3. **A partial body is worse than none.** Concatenating only the readable
 *      parts of a split message looks complete and is not.
 *   4. **`smsId` is namespaced.** `content://sms._id` and `content://mms._id`
 *      are separate autoincrements; un-namespaced, an MMS and an SMS sharing a
 *      row number collide on the queue de-dup key and one is dropped.
 *
 * Every "it did not do X" assertion is preceded by proof a record was ACTUALLY
 * produced — an assertion about a message that was never mapped passes
 * vacuously and guards nothing.
 *
 * Phone numbers are from the reserved `+1 <area> 555-01xx` range.
 */

// `mmsMapper` imports `mmsDateToMillis` from `mmsReader`, which reaches the
// Expo native-module surface. The mapper itself is pure — these two mocks exist
// only so the import graph resolves under jest, not to fake any behaviour the
// suite asserts on.
jest.mock('expo', () => ({
  requireOptionalNativeModule: () => null,
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  NativeModules: {},
}));

import { createHash } from 'crypto';
import {
  mapMmsRecord,
  mapMmsRecords,
  extractMmsBody,
  bodyTextForHash,
  normalizeContentType,
  partSeq,
  MMS_ID_NAMESPACE,
  MMS_TEXT_PART_SEPARATOR,
  type MmsBody,
} from '../mmsMapper';
import { rawToSyncMessage } from '../smsReader';
import type { RawMmsPart, RawMmsRecord } from '../mmsReader';

// ===========================================================================
// Fixtures — the part shapes are transcribed from what the provider returned on
// a live API-36 emulator (BACKLOG-2973 spike), including the `seq = -1` SMIL
// placement. Reserved 555-01xx numbers only.
// ===========================================================================

const part = (over: Partial<RawMmsPart> = {}): RawMmsPart => ({
  _id: '1',
  seq: '0',
  ct: 'text/plain',
  name: null,
  cl: null,
  chset: '106',
  text: null,
  _data: null,
  ...over,
});

/** The layout document every MMS carries. Never message text. */
const smilPart = (over: Partial<RawMmsPart> = {}): RawMmsPart =>
  part({
    _id: '3',
    seq: '-1',
    ct: 'application/smil',
    cl: 'smil.xml',
    chset: null,
    text: '<smil><head><layout/></head><body><par dur="5000ms"/></body></smil>',
    ...over,
  });

const textPart = (text: string, over: Partial<RawMmsPart> = {}): RawMmsPart =>
  part({ _id: '4', seq: '0', ct: 'text/plain', cl: 'text_0.txt', text, ...over });

/** An image part: bytes live in the provider's store, `text` is null. */
const imagePart = (over: Partial<RawMmsPart> = {}): RawMmsPart =>
  part({
    _id: '7',
    seq: '0',
    ct: 'image/jpeg',
    name: 'IMG_0001.jpg',
    cl: 'IMG_0001.jpg',
    chset: null,
    text: null,
    _data:
      '/data/user_de/0/com.android.providers.telephony/app_parts/PART_1_IMG_0001.jpg',
    ...over,
  });

const record = (over: Partial<RawMmsRecord> = {}): RawMmsRecord => ({
  _id: '2',
  thread_id: '11',
  date: '1756600000',
  date_sent: '0',
  msg_box: '1',
  m_type: '132',
  parts: [],
  addrs: [{ _id: '1', address: '+12065550111', type: '137', charset: '106' }],
  ...over,
});

/** Assert a mapping succeeded and hand back the message. */
function mapped(raw: RawMmsRecord) {
  const outcome = mapMmsRecord(raw);
  if (!outcome.ok) {
    throw new Error(
      `expected a mapped message, got skip: ${outcome.skip.reason}`
    );
  }
  return outcome.message;
}

/** Assert a mapping was skipped and hand back the skip. */
function skipOf(raw: RawMmsRecord) {
  const outcome = mapMmsRecord(raw);
  if (outcome.ok) {
    throw new Error('expected a skip, got a mapped message');
  }
  return outcome.skip;
}

/**
 * The desktop's de-duplication key, verbatim from
 * `electron/services/localSyncService.ts` `generateExternalId`.
 */
function externalId(sender: string, timestamp: number, body: string): string {
  return createHash('sha256').update(`${sender}|${timestamp}|${body}`).digest('hex');
}

const SENDER = '+12065550111';

// ===========================================================================
// CONTROL 1 — the SMIL part never becomes the message text
// ===========================================================================

describe('the SMIL layout part is never the message body', () => {
  it('takes the text/plain part even when the SMIL part is first', () => {
    const message = mapped(
      record({
        parts: [smilPart(), imagePart(), textPart('Photo of the signed addendum')],
      })
    );

    // Proof a record was produced before asserting what it is not.
    expect(message.smsId).toBe('mms:2');
    expect(message.body.kind).toBe('text');
    expect(bodyTextForHash(message.body)).toBe('Photo of the signed addendum');
    expect(bodyTextForHash(message.body)).not.toContain('<smil');
  });

  it('takes the text/plain part when it is first AND when it is last', () => {
    const textFirst = mapped(
      record({ parts: [textPart('Closing moved to Friday'), smilPart()] })
    );
    const textLast = mapped(
      record({ parts: [smilPart(), textPart('Closing moved to Friday')] })
    );

    expect(textFirst.body).toEqual({ kind: 'text', text: 'Closing moved to Friday' });
    expect(textLast.body).toEqual(textFirst.body);
  });

  it('a SMIL-only message has no text at all, rather than XML for text', () => {
    const message = mapped(record({ parts: [smilPart()] }));

    expect(message.smsId).toBe('mms:2');
    expect(message.body.kind).toBe('no_text_part');
    expect(bodyTextForHash(message.body)).toBeNull();
  });

  it('selects IN by text/plain rather than filtering OUT smil — a vCard is not body text', () => {
    // `ct !== 'application/smil'` would concatenate this attached contact card
    // into the message as if somebody had typed it.
    const message = mapped(
      record({
        parts: [
          smilPart(),
          part({ _id: '9', seq: '0', ct: 'text/x-vCard', text: 'BEGIN:VCARD' }),
        ],
      })
    );

    expect(message.body).toEqual({
      kind: 'no_text_part',
      attachmentContentTypes: ['text/x-vcard'],
    });
  });

  it('matches text/plain even when the ct carries a charset parameter', () => {
    const message = mapped(
      record({
        parts: [smilPart(), textPart('On my way', { ct: 'text/plain; charset=utf-8' })],
      })
    );

    expect(message.body).toEqual({ kind: 'text', text: 'On my way' });
  });
});

// ===========================================================================
// CONTROL 2 — a message with no text part is not an empty string
// ===========================================================================

describe('a message with no text part', () => {
  it('a photo with no caption maps to a real record with no body', () => {
    const message = mapped(record({ parts: [smilPart(), imagePart()] }));

    // The record EXISTS — dropping it is how a photo-only thread vanishes.
    expect(message.smsId).toBe('mms:2');
    expect(message.threadId).toBe('11');
    expect(message.direction).toBe('inbound');
    // ...and its body is absent, not empty.
    expect(message.body).toEqual({
      kind: 'no_text_part',
      attachmentContentTypes: ['image/jpeg'],
    });
    expect(bodyTextForHash(message.body)).toBeNull();
  });

  it('a row with no parts at all also maps to a real record', () => {
    // Seed `_id=7` on the emulator: zero parts. Possibly an undownloaded stub,
    // which is a different fact from a photo with no caption — hence two cases.
    const message = mapped(record({ _id: '7', thread_id: '14', parts: [] }));

    expect(message.smsId).toBe('mms:7');
    expect(message.body).toEqual({ kind: 'no_text_part', attachmentContentTypes: [] });
    expect(bodyTextForHash(message.body)).toBeNull();
  });

  it('an empty-but-present text part is a body that IS empty — a different case', () => {
    // The provider said the text is "". That is an observation, not an
    // invention, so it is reported as text. BACKLOG-2977 still has to decide
    // what the desktop does with it, which is why it is named here.
    const message = mapped(record({ parts: [smilPart(), textPart('')] }));

    expect(message.body).toEqual({ kind: 'text', text: '' });
    expect(bodyTextForHash(message.body)).toBe('');
  });
});

// ===========================================================================
// CONTROL 3 — several text parts
// ===========================================================================

describe('several text parts', () => {
  it('concatenates every text part in ascending seq order', () => {
    const message = mapped(
      record({
        parts: [
          smilPart(),
          textPart('and the addendum is attached.', { _id: '6', seq: '1' }),
          textPart('The survey came back clean', { _id: '5', seq: '0' }),
        ],
      })
    );

    expect(message.body.kind).toBe('text');
    expect(bodyTextForHash(message.body)).toBe(
      `The survey came back clean${MMS_TEXT_PART_SEPARATOR}and the addendum is attached.`
    );
  });

  it('orders by seq, not by the order the provider returned the parts', () => {
    const body = extractMmsBody([
      textPart('third', { _id: '3', seq: '2' }),
      textPart('first', { _id: '1', seq: '0' }),
      textPart('second', { _id: '2', seq: '1' }),
    ]);

    expect(body).toEqual({
      kind: 'text',
      text: ['first', 'second', 'third'].join(MMS_TEXT_PART_SEPARATOR),
    });
  });

  it('a seq-less part sorts last and keeps provider order among its peers', () => {
    // `Number(null)` and `Number("")` are 0, not NaN — unguarded, these two
    // would claim slide zero and reorder the message.
    const body = extractMmsBody([
      textPart('no seq A', { _id: '1', seq: null }),
      textPart('slide one', { _id: '2', seq: '1' }),
      textPart('no seq B', { _id: '3', seq: '' }),
      textPart('slide zero', { _id: '4', seq: '0' }),
    ]);

    expect(body).toEqual({
      kind: 'text',
      text: ['slide zero', 'slide one', 'no seq A', 'no seq B'].join(
        MMS_TEXT_PART_SEPARATOR
      ),
    });
  });

  it('partSeq refuses a blank seq rather than reading it as zero', () => {
    expect(partSeq(part({ seq: '0' }))).toBe(0);
    expect(partSeq(part({ seq: '-1' }))).toBe(-1);
    expect(partSeq(part({ seq: null }))).toBeNull();
    expect(partSeq(part({ seq: '' }))).toBeNull();
    expect(partSeq(part({ seq: 'slide' }))).toBeNull();
  });
});

// ===========================================================================
// CONTROL 4 — the desktop de-dup hash is not poisoned
// ===========================================================================

describe('the desktop de-duplication key', () => {
  it('two different photo-only messages cannot be reduced to one id', () => {
    // Same participant, same SECOND. MMS `date` can be seconds-granularity, so
    // this is the collision an invented `""` body produces in the field.
    const { messages, skipped } = mapMmsRecords([
      record({ _id: '20', date: '1756600000', parts: [smilPart(), imagePart()] }),
      record({
        _id: '21',
        date: '1756600000',
        parts: [smilPart(), imagePart({ _id: '8', cl: 'IMG_0002.jpg' })],
      }),
    ]);

    // Proof BOTH records were produced before asserting anything about them.
    expect(skipped).toEqual([]);
    expect(messages).toHaveLength(2);
    const [first, second] = messages;
    expect(first.smsId).not.toBe(second.smsId);

    // The precondition for the collision, read off the mapper's own output.
    expect(first.timestamp).toBe(second.timestamp);

    // The mapper refuses to supply a hashable body for either message...
    expect(bodyTextForHash(first.body)).toBeNull();
    expect(bodyTextForHash(second.body)).toBeNull();

    // ...which is what stops this from happening. Substituting `""` gives the
    // two distinct messages one desktop external_id, and one is discarded.
    expect(externalId(SENDER, first.timestamp, '')).toBe(
      externalId(SENDER, second.timestamp, '')
    );
  });

  it('two messages with real text keep distinct ids', () => {
    const a = mapped(record({ _id: '20', date: '1756600000', parts: [textPart('Yes')] }));
    const b = mapped(record({ _id: '21', date: '1756600000', parts: [textPart('No')] }));

    const textA = bodyTextForHash(a.body);
    const textB = bodyTextForHash(b.body);
    expect(textA).not.toBeNull();
    expect(textB).not.toBeNull();
    expect(externalId(SENDER, a.timestamp, textA as string)).not.toBe(
      externalId(SENDER, b.timestamp, textB as string)
    );
  });
});

// ===========================================================================
// CONTROL 5 — smsId namespacing across the two providers
// ===========================================================================

describe('smsId namespacing', () => {
  it('an MMS row id never collides with the SMS row id of the same number', () => {
    const mms = mapped(record({ _id: '5' }));
    const sms = rawToSyncMessage(
      {
        _id: '5',
        thread_id: '11',
        address: SENDER,
        body: 'A plain SMS that happens to be row 5',
        date: '1756600000000',
        date_sent: '1756600000000',
        read: '1',
        type: '1',
      },
      'inbox'
    );

    // Both queue keys exist — an absent key on either side would make the
    // inequality below pass without proving anything.
    expect(sms.smsId).toBe('5');
    expect(mms.smsId).toBe('mms:5');
    expect(mms.smsId).not.toBe(sms.smsId);
    expect(mms.smsId.startsWith(MMS_ID_NAMESPACE)).toBe(true);
  });
});

// ===========================================================================
// CONTROL 6 — a text part we could not read is not an empty message
// ===========================================================================

describe('an unreadable text part', () => {
  it('a text/plain part whose text is null is unreadable, not empty', () => {
    // `text` and `_data` are alternatives: the content is in the provider's own
    // file store and nothing in this chain streams it yet.
    const message = mapped(
      record({
        parts: [
          smilPart(),
          textPart('', {
            _id: '11',
            text: null,
            _data:
              '/data/user_de/0/com.android.providers.telephony/app_parts/PART_2_text.txt',
          }),
        ],
      })
    );

    expect(message.smsId).toBe('mms:2');
    expect(message.body).toEqual({ kind: 'unreadable', partIds: ['11'] });
    expect(bodyTextForHash(message.body)).toBeNull();
  });

  it('one unreadable part makes the WHOLE body unreadable, never a partial one', () => {
    // Returning just "The inspection report says" would look like a complete
    // message. Nothing downstream could tell it had been truncated.
    const body = extractMmsBody([
      smilPart(),
      textPart('The inspection report says', { _id: '5', seq: '0' }),
      textPart('', { _id: '6', seq: '1', text: null, _data: '/app_parts/PART_3.txt' }),
    ]);

    expect(body).toEqual({ kind: 'unreadable', partIds: ['6'] });
    expect(bodyTextForHash(body)).toBeNull();
    expect(JSON.stringify(body)).not.toContain('inspection report');
  });
});

// ===========================================================================
// Envelope: timestamp, direction, thread id, and what is skipped
// ===========================================================================

describe('the message envelope', () => {
  it('takes the timestamp from date, not date_sent, and normalises the unit', () => {
    // `date` is the column the native query sorts by and the cursor floors on.
    // Reading date_sent would break the contiguous-prefix guarantee.
    const seconds = mapped(record({ date: '1756600000', date_sent: '1700000000' }));
    const millis = mapped(record({ date: '1756601500000', date_sent: '1700000000000' }));

    expect(seconds.timestamp).toBe(1756600000 * 1000);
    expect(millis.timestamp).toBe(1756601500000);
  });

  it('reads direction from msg_box', () => {
    expect(mapped(record({ msg_box: '1' })).direction).toBe('inbound');
    expect(mapped(record({ msg_box: '2' })).direction).toBe('outbound');
  });

  it('carries thread_id raw, and omits it when the row has none', () => {
    // Raw and un-namespaced: SMS and MMS reference the same `threads` table,
    // which is what lets one conversation contain both.
    expect(mapped(record({ thread_id: '11' })).threadId).toBe('11');
    const noThread = mapped(record({ thread_id: null }));
    expect(noThread.threadId).toBeUndefined();
    expect('threadId' in noThread).toBe(false);
  });

  it('skips — with a named reason — a row it cannot key, date or orient', () => {
    expect(skipOf(record({ _id: null }))).toEqual({
      reason: 'missing_id',
      id: null,
      detail: 'thread_id=11 date=1756600000',
    });
    expect(skipOf(record({ date: null }))).toEqual({
      reason: 'unusable_date',
      id: '2',
      detail: 'date=null',
    });
    // Not defaulted to inbound: that attributes an agent's own sent message to
    // the client, and a wrong record is worse than a counted absence.
    expect(skipOf(record({ msg_box: '3' }))).toEqual({
      reason: 'unsupported_msg_box',
      id: '2',
      detail: 'msg_box=3',
    });
    expect(skipOf(record({ msg_box: null })).reason).toBe('unsupported_msg_box');
  });

  it('a skip is reported alongside the messages, never silently omitted', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { messages, skipped } = mapMmsRecords([
      record({ _id: '2', parts: [textPart('kept')] }),
      record({ _id: '3', msg_box: '3' }),
      record({ _id: '4', parts: [imagePart()] }),
    ]);

    // The exact ID SET, not a count — a duplicate and a miss cancel out.
    expect(messages.map((m) => m.smsId)).toEqual(['mms:2', 'mms:4']);
    expect(skipped.map((s) => s.id)).toEqual(['3']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('preserves the oldest-first order the reader produced', () => {
    const { messages } = mapMmsRecords([
      record({ _id: '2', date: '1756600000' }),
      record({ _id: '5', date: '1756600250' }),
      record({ _id: '3', date: '1756600500' }),
    ]);

    expect(messages.map((m) => m.smsId)).toEqual(['mms:2', 'mms:5', 'mms:3']);
    expect(messages.map((m) => m.timestamp)).toEqual([
      1756600000000, 1756600250000, 1756600500000,
    ]);
  });
});

// ===========================================================================
// Content-type normalisation
// ===========================================================================

describe('normalizeContentType', () => {
  it('strips parameters, trims and lowercases', () => {
    expect(normalizeContentType('text/plain')).toBe('text/plain');
    expect(normalizeContentType(' TEXT/Plain ; charset=UTF-8')).toBe('text/plain');
    expect(normalizeContentType('APPLICATION/SMIL')).toBe('application/smil');
  });

  it('returns null when there is nothing to compare', () => {
    expect(normalizeContentType(null)).toBeNull();
    expect(normalizeContentType('')).toBeNull();
    expect(normalizeContentType('   ')).toBeNull();
  });

  it('a part with no declared content type is never treated as text', () => {
    const body: MmsBody = extractMmsBody([
      part({ _id: '1', ct: null, text: 'looks like text, declares nothing' }),
    ]);

    expect(body.kind).toBe('no_text_part');
    expect(JSON.stringify(body)).not.toContain('looks like text');
  });
});
