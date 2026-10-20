/**
 * BACKLOG-4007: the client phone rule equals the database rule. Every expected value below was
 * transcribed from `select public._billing_normalize_phone(v)` run on keepr-test on 2026-10-20
 * (not invented). Boundaries are swept: 9/10/11/12 digits, leading 1, area code 0/1, letters,
 * a pasted "+1 (555) 123-4567", international length 7/8/15/16, empty.
 */
import { formatBillingPhoneInput, isValidBillingPhone, normalizeBillingPhone } from '@/lib/billing/phone';

const DB: Array<[string, string | null]> = [
  ['555123456', null], // 9 digits
  ['5551234567', '+15551234567'], // 10
  ['(555) 123-4567', '+15551234567'],
  ['555.123.4567', '+15551234567'],
  ['15551234567', '+15551234567'], // 11, leading 1
  ['1 (555) 123-4567', '+15551234567'],
  ['255512345678', null], // 12 digits
  ['1555123456', null], // 1 + 9
  ['0551234567', null], // area code starts 0
  ['1551234567', null], // 10 digits starting 1
  ['555abc4567', null], // letters
  ['555123abcd4567', null], // letters inside an otherwise valid 10 digits
  ['555123456a', null], // letter after 9 digits
  ['+1 (555) 123-4567', '+15551234567'], // pasted
  ['+15551234567', '+15551234567'],
  ['+4420712345', '+4420712345'], // 10 digits intl
  ['+44 20 7946 0958', '+442079460958'],
  ['+1234567', null], // 7 digits intl
  ['+123456789012345', '+123456789012345'], // 15
  ['+1234567890123456', null], // 16
  ['+0123456789', null], // country code 0
  ['', null],
  ['   ', null],
  ['555-123-4567 x12', null],
  ['+1-555-123-4567', '+15551234567'],
];

describe('normalizeBillingPhone equals _billing_normalize_phone (keepr-test)', () => {
  it.each(DB)('%j -> %j', (input, expected) => {
    expect(normalizeBillingPhone(input)).toBe(expected);
    expect(isValidBillingPhone(input)).toBe(expected !== null);
  });
  it('the table is not vacuous', () => {
    expect(DB.length).toBeGreaterThan(20);
    expect(DB.filter(([, e]) => e === null).length).toBeGreaterThan(8);
    expect(DB.filter(([, e]) => e !== null).length).toBeGreaterThan(8);
  });
});

describe('formatBillingPhoneInput', () => {
  it.each([
    ['', ''],
    ['5', '5'],
    ['555', '555'],
    ['5551', '(555) 1'],
    ['555123', '(555) 123'],
    ['5551234', '(555) 123-4'],
    ['5551234567', '(555) 123-4567'],
    ['(555) 123-4567', '(555) 123-4567'],
    ['15551234567', '1 (555) 123-4567'],
    ['+1 (555) 123-4567', '+1 (555) 123-4567'], // pasted international form untouched
    ['555abc4567', '555abc4567'], // letters untouched so validation sees them
  ])('%j -> %j', (input, out) => expect(formatBillingPhoneInput(input)).toBe(out));

  it('formatting never changes validity', () => {
    for (const [input] of DB) {
      expect(isValidBillingPhone(formatBillingPhoneInput(input))).toBe(isValidBillingPhone(input));
    }
  });
});
