/**
 * phoneNormalization — table-driven guards for the BACKLOG-1495 data-parsing spec.
 *
 * normalizePhoneNumber is the phone-side sender normalizer. The five documented
 * categories each have a distinct, load-bearing behaviour, and one of them
 * (alphanumeric senders) is a REGRESSION guard: stripping non-digits from
 * "T-Mobile" yields "" — an empty sender would silently hide carrier alerts and
 * every other alphanumeric-sender message (BACKLOG-1493). These tests assert the
 * exact returned string, never a shape/length, so a wrong-but-same-length result
 * cannot pass.
 */

import { normalizePhoneNumber } from '../phoneNormalization';

describe('normalizePhoneNumber', () => {
  // Category 1 — International "+" format: kept as "+<digits>" (formatting stripped).
  describe('category 1: international (+CC) format', () => {
    const cases: Array<[string, string]> = [
      ['+15551234567', '+15551234567'],
      ['+1 (555) 123-4567', '+15551234567'],
      ['+44 20 7946 0958', '+442079460958'],
      ['+442079460958', '+442079460958'],
      ['+33 1 42 68 53 00', '+33142685300'],
    ];
    it.each(cases)('normalizes %s -> %s', (input, expected) => {
      expect(normalizePhoneNumber(input)).toBe(expected);
    });
  });

  // Category 2 — US/Canada 10-digit (no country code): prepend "+1".
  describe('category 2: US/Canada 10-digit', () => {
    const cases: Array<[string, string]> = [
      ['5551234567', '+15551234567'],
      ['(555) 123-4567', '+15551234567'],
      ['555-123-4567', '+15551234567'],
      ['555.123.4567', '+15551234567'],
    ];
    it.each(cases)('normalizes %s -> %s', (input, expected) => {
      expect(normalizePhoneNumber(input)).toBe(expected);
    });
  });

  // Category 3 — US/Canada 11-digit starting with 1: prepend "+".
  describe('category 3: US/Canada 11-digit (leading 1)', () => {
    const cases: Array<[string, string]> = [
      ['15551234567', '+15551234567'],
      ['1 (555) 123-4567', '+15551234567'],
      ['1-555-123-4567', '+15551234567'],
    ];
    it.each(cases)('normalizes %s -> %s', (input, expected) => {
      expect(normalizePhoneNumber(input)).toBe(expected);
    });
  });

  // Category 4 — Short codes (< 7 digits): digits-only, NO country code.
  // These are carrier/marketing SMS codes and MUST be preserved, not filtered.
  describe('category 4: short codes (digits only, no country code)', () => {
    const cases: Array<[string, string]> = [
      ['72645', '72645'],
      ['227263', '227263'],
      ['262-66', '26266'], // formatted short code -> digits only
      ['1234', '1234'],
    ];
    it.each(cases)('preserves %s -> %s', (input, expected) => {
      expect(normalizePhoneNumber(input)).toBe(expected);
    });

    it('never prepends a country code to a short code', () => {
      expect(normalizePhoneNumber('72645').startsWith('+')).toBe(false);
    });
  });

  // Category 5 — Alphanumeric senders: returned trimmed, verbatim.
  describe('category 5: alphanumeric senders (carrier / service IDs)', () => {
    const cases: Array<[string, string]> = [
      ['T-Mobile', 'T-Mobile'],
      ['BANK OF AMERICA', 'BANK OF AMERICA'],
      ['MyService', 'MyService'],
      ['  Verizon  ', 'Verizon'], // trimmed
      ['AT&T', 'AT&T'],
    ];
    it.each(cases)('preserves %s -> %s', (input, expected) => {
      expect(normalizePhoneNumber(input)).toBe(expected);
    });
  });

  // REGRESSION (BACKLOG-1493): an alphanumeric sender must NEVER collapse to "".
  // Stripping non-digits from "T-Mobile" is "", which would hide the message.
  describe('regression: empty string must not hide carrier alerts', () => {
    it('returns a non-empty sender for a purely-alphabetic carrier name', () => {
      const result = normalizePhoneNumber('T-Mobile');
      expect(result).not.toBe('');
      expect(result).toBe('T-Mobile');
    });

    it('returns the trimmed original when digit-stripping would empty it', () => {
      // "FREEMSG" has zero digits -> digit-strip = "" -> must fall back to original.
      expect(normalizePhoneNumber('FREEMSG')).toBe('FREEMSG');
    });

    // Empty/whitespace INPUT is passed through unchanged (caller decides fallback).
    it('passes empty / whitespace-only input through unchanged', () => {
      expect(normalizePhoneNumber('')).toBe('');
      expect(normalizePhoneNumber('   ')).toBe('   ');
    });
  });

  // 7-digit local numbers: cannot reliably add a country code -> digits only.
  describe('edge: 7-digit local numbers keep digits only', () => {
    it('returns digits without a country code for a 7-digit local number', () => {
      expect(normalizePhoneNumber('123-4567')).toBe('1234567');
    });
  });

  // Long international numbers WITHOUT a "+": >10 digits get a "+" prefix.
  describe('edge: long international without a plus', () => {
    it('prefixes "+" to a >10-digit international number lacking one', () => {
      expect(normalizePhoneNumber('442079460958')).toBe('+442079460958');
    });
  });
});
