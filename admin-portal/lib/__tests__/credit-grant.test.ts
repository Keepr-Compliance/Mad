/**
 * Credit-grant validation tests (BACKLOG-2016).
 *
 * Covers the pure input-validation/shaping helper that fronts the
 * `admin_adjust_credits` grant/clawback flow. The RPC call itself (network +
 * auth) is not tested here — it is exercised via the authenticated browser
 * supabase client at runtime (see CreditGrantAction.tsx).
 */

import { describe, it, expect } from 'vitest';
import {
  validateGrantInput,
  directionVerb,
  MAX_GRANT_MAGNITUDE,
} from '../credit-grant';

describe('validateGrantInput — reason (required)', () => {
  it('rejects an empty reason', () => {
    const r = validateGrantInput({ amountRaw: '5', reason: '', direction: 'grant' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.reason).toBeTruthy();
  });

  it('rejects a whitespace-only reason', () => {
    const r = validateGrantInput({ amountRaw: '5', reason: '   ', direction: 'grant' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.reason).toBeTruthy();
  });

  it('trims the reason on success', () => {
    const r = validateGrantInput({
      amountRaw: '5',
      reason: '  goodwill credit  ',
      direction: 'grant',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.reason).toBe('goodwill credit');
  });
});

describe('validateGrantInput — amount', () => {
  it('rejects zero', () => {
    const r = validateGrantInput({ amountRaw: '0', reason: 'x', direction: 'grant' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.amount).toBeTruthy();
  });

  it('rejects non-numeric input', () => {
    const r = validateGrantInput({ amountRaw: 'abc', reason: 'x', direction: 'grant' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.amount).toBeTruthy();
  });

  it('rejects fractional input', () => {
    const r = validateGrantInput({ amountRaw: '1.5', reason: 'x', direction: 'grant' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.amount).toBeTruthy();
  });

  it('rejects scientific notation', () => {
    const r = validateGrantInput({ amountRaw: '1e3', reason: 'x', direction: 'grant' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.amount).toBeTruthy();
  });

  it('rejects a typed negative (sign comes from direction, not the field)', () => {
    const r = validateGrantInput({ amountRaw: '-5', reason: 'x', direction: 'grant' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.amount).toBeTruthy();
  });

  it('rejects an empty amount', () => {
    const r = validateGrantInput({ amountRaw: '', reason: 'x', direction: 'grant' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.amount).toBeTruthy();
  });

  it('rejects an amount over the magnitude cap', () => {
    const r = validateGrantInput({
      amountRaw: String(MAX_GRANT_MAGNITUDE + 1),
      reason: 'x',
      direction: 'grant',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.amount).toBeTruthy();
  });

  it('accepts the magnitude cap exactly', () => {
    const r = validateGrantInput({
      amountRaw: String(MAX_GRANT_MAGNITUDE),
      reason: 'x',
      direction: 'grant',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.amount).toBe(MAX_GRANT_MAGNITUDE);
  });

  it('trims surrounding whitespace on the amount', () => {
    const r = validateGrantInput({ amountRaw: '  7 ', reason: 'x', direction: 'grant' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.amount).toBe(7);
  });
});

describe('validateGrantInput — direction / sign', () => {
  it('grant yields a positive amount', () => {
    const r = validateGrantInput({ amountRaw: '5', reason: 'x', direction: 'grant' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.amount).toBe(5);
  });

  it('clawback yields a negative amount', () => {
    const r = validateGrantInput({ amountRaw: '5', reason: 'x', direction: 'clawback' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.amount).toBe(-5);
  });
});

describe('validateGrantInput — combined errors', () => {
  it('reports both amount and reason errors at once', () => {
    const r = validateGrantInput({ amountRaw: '0', reason: '', direction: 'grant' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.amount).toBeTruthy();
      expect(r.errors.reason).toBeTruthy();
    }
  });
});

describe('directionVerb', () => {
  it('labels grant and clawback', () => {
    expect(directionVerb('grant')).toBe('Grant');
    expect(directionVerb('clawback')).toBe('Claw back');
  });
});
