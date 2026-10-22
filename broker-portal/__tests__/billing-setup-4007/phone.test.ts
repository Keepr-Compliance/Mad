/**
 * BACKLOG-4007: the client phone rule equals the database rule. Every expected value below was
 * transcribed from `select public._billing_normalize_phone(v)` run on keepr-test on 2026-10-20
 * (not invented). Boundaries are swept: 9/10/11/12 digits, leading 1, area code 0/1, letters,
 * a pasted "+1 (206) 555-0123", international length 7/8/15/16, empty.
 */
import { formatBillingPhoneInput, isValidBillingPhone, normalizeBillingPhone } from '@/lib/billing/phone';

const DB: Array<[string, string | null]> = [
  ['206555012', null], // 9 digits
  ['2065550123', '+12065550123'], // 10
  ['(206) 555-0123', '+12065550123'],
  ['206.555.0123', '+12065550123'],
  ['12065550123', '+12065550123'], // 11, leading 1
  ['1 (206) 555-0123', '+12065550123'],
  ['206555012345', null], // 12 digits
  ['1206555012', null], // 1 + 9
  ['0065550123', null], // area code starts 0
  ['1265550123', null], // 10 digits starting 1
  ['206abc0123', null], // letters
  ['206555abcd0123', null], // letters inside an otherwise valid 10 digits
  ['206555012a', null], // letter after 9 digits
  ['+1 (206) 555-0123', '+12065550123'], // pasted
  ['+12065550123', '+12065550123'],
  ['+4420712345', '+4420712345'], // 10 digits intl
  ['+44 20 7946 0958', '+442079460958'],
  ['+1234567', null], // 7 digits intl
  ['+123456789012345', '+123456789012345'], // 15
  ['+1234567890123456', null], // 16
  ['+0123456789', null], // country code 0
  ['', null],
  ['   ', null],
  ['206-555-0123 x12', null],
  ['+1-206-555-0123', '+12065550123'],
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
    ['206', '206'],
    ['2065', '(206) 5'],
    ['206555', '(206) 555'],
    ['2065550', '(206) 555-0'],
    ['2065550123', '(206) 555-0123'],
    ['(206) 555-0123', '(206) 555-0123'],
    ['12065550123', '1 (206) 555-0123'],
    ['+1 (206) 555-0123', '+1 (206) 555-0123'], // pasted international form untouched
    ['206abc0123', '206abc0123'], // letters untouched so validation sees them
  ])('%j -> %j', (input, out) => expect(formatBillingPhoneInput(input)).toBe(out));

  it('formatting never changes validity', () => {
    for (const [input] of DB) {
      expect(isValidBillingPhone(formatBillingPhoneInput(input))).toBe(isValidBillingPhone(input));
    }
  });
});
