/**
 * BACKLOG-3904 row design B: the street / "City, ST ZIP" split.
 *
 * SHAPES transcribed from production (read-only counts, 2026-10-12): all 7 stored
 * rows are "<street>, <city>, <ST> <zip>, USA" (4 comma segments, ends ", USA",
 * ends in a 5-digit zip, city column equals the 2nd-from-last segment before the
 * state, property_zip is also inside the string). VALUES are invented.
 */
import { formatUsAddress } from '@/lib/submissions/formatUsAddress';

describe('parses the stored shape', () => {
  const cases: Array<[string, string, string, string, { street: string; cityLine: string | null }]> = [
    ['stored shape', '33 Example Rd, Riverton, FL 33023, USA', 'Riverton', 'FL', { street: '33 Example Rd', cityLine: 'Riverton, FL 33023' }],
    ['unit stays on line 1', '5120 Sample Ave, Unit 2, Eastgate, FL 33027, USA', 'Eastgate', 'FL', { street: '5120 Sample Ave, Unit 2', cityLine: 'Eastgate, FL 33027' }],
    ['no country suffix', '901 Placeholder Blvd, Lakeside, FL 33021', 'Lakeside', 'FL', { street: '901 Placeholder Blvd', cityLine: 'Lakeside, FL 33021' }],
    ['zip+4', '1400 Demo Ct, Brookfield, FL 33029-1234, USA', 'Brookfield', 'FL', { street: '1400 Demo Ct', cityLine: 'Brookfield, FL 33029-1234' }],
    ['no zip', '1400 Demo Ct, Brookfield, FL, USA', 'Brookfield', 'FL', { street: '1400 Demo Ct', cityLine: 'Brookfield, FL' }],
    ['city case differs', '7 Sample St, riverton, FL 33023, USA', 'Riverton', 'FL', { street: '7 Sample St', cityLine: 'Riverton, FL 33023' }],
    ['state column wins', '7 Sample St, Riverton, fl 33023, USA', 'Riverton', 'FL', { street: '7 Sample St', cityLine: 'Riverton, FL 33023' }],
    ['state column missing', '7 Sample St, Riverton, FL 33023, USA', 'Riverton', '', { street: '7 Sample St', cityLine: 'Riverton, FL 33023' }],
  ];
  it.each(cases)('%s', (_n, address, city, state, expected) => {
    expect(formatUsAddress(address, city, state)).toEqual(expected);
  });

  it('never leaves "USA" or the unit out of place', () => {
    const r = formatUsAddress('5120 Sample Ave, Unit 2, Eastgate, FL 33027, USA', 'Eastgate', 'FL');
    expect(r.street).toContain('Unit 2');
    expect(r.cityLine).not.toContain('Unit');
    expect(`${r.street}|${r.cityLine}`).not.toMatch(/USA/);
  });
});

describe('falls back to the whole address and the existing city, state', () => {
  const cases: Array<[string, string | null | undefined, string | null | undefined, string | null | undefined, { street: string; cityLine: string | null }]> = [
    ['no comma', '1234 Invented Boulevard', 'Eastgate', 'FL', { street: '1234 Invented Boulevard', cityLine: 'Eastgate, FL' }],
    ['too few segments', '1234 Invented Boulevard, Eastgate', 'Eastgate', 'FL', { street: '1234 Invented Boulevard, Eastgate', cityLine: 'Eastgate, FL' }],
    ['two segments that look like city + state (no street)', 'Eastgate, FL 33027, USA', 'Eastgate', 'FL', { street: 'Eastgate, FL 33027, USA', cityLine: 'Eastgate, FL' }],
    ['non-US (no state/zip tail)', '12 Fictional Street, Toronto, Ontario M5V 2T6, Canada', 'Toronto', 'ON', { street: '12 Fictional Street, Toronto, Ontario M5V 2T6, Canada', cityLine: 'Toronto, ON' }],
    ['city column missing', '33 Example Rd, Riverton, FL 33023, USA', null, 'FL', { street: '33 Example Rd, Riverton, FL 33023, USA', cityLine: 'FL' }],
    ['city column differs', '33 Example Rd, Riverton, FL 33023, USA', 'Eastgate', 'FL', { street: '33 Example Rd, Riverton, FL 33023, USA', cityLine: 'Eastgate, FL' }],
    ['city and state both missing', '1234 Invented Boulevard', null, null, { street: '1234 Invented Boulevard', cityLine: null }],
    ['address missing', null, 'Eastgate', 'FL', { street: 'Eastgate, FL', cityLine: null }],
    ['address blank, nothing else', '   ', '', '', { street: 'Address unavailable', cityLine: null }],
    ['undefined input', undefined, undefined, undefined, { street: 'Address unavailable', cityLine: null }],
  ];
  it.each(cases)('%s', (_n, address, city, state, expected) => {
    expect(formatUsAddress(address, city, state)).toEqual(expected);
  });

  it('never returns an empty line or the word undefined/null', () => {
    const inputs: Array<string | null | undefined> = [undefined, null, '', ' ', 'undefined', ',', ', ,', 'x', 'a, b', 'a, b, c', 'a, b, ZZ 1, USA'];
    for (const a of inputs) {
      for (const c of [undefined, null, '', 'b', 'undefined']) {
        for (const s of [undefined, null, '', 'FL']) {
          const r = formatUsAddress(a, c, s);
          expect(r.street.trim()).not.toBe('');
          if (r.cityLine !== null) expect(r.cityLine.trim()).not.toBe('');
          expect(`${r.street}|${r.cityLine ?? ''}`).not.toMatch(/undefined|null/);
        }
      }
    }
  });
});
