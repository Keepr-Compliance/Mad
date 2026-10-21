/** Admin post-login path validator — BACKLOG-3705. */
import { describe, expect, it } from 'vitest';
import { isSafeNextPath, safeNextPath } from '@/lib/auth/safeNextPath';
import { REFUSED } from './cases';

describe('refused -> /dashboard', () => {
  it.each(REFUSED)('%s', (raw) => {
    expect(isSafeNextPath(raw)).toBe(false);
    expect(safeNextPath(raw)).toBe('/dashboard');
  });
  it.each([null, undefined, 42, {}, ''])('non-path %p', (raw) => {
    expect(safeNextPath(raw)).toBe('/dashboard');
  });
  it('a value still changing after the decode cap is refused, one inside it is not', () => {
    const nested = (rounds: number): string => {
      let v = '%78';
      for (let i = 1; i < rounds; i++) v = v.replace(/%/g, '%25');
      return `/dashboard/${v}`;
    };
    expect(isSafeNextPath(nested(2))).toBe(true);
    expect(isSafeNextPath(nested(9))).toBe(false);
  });
});

describe('kept', () => {
  it.each(['/dashboard', '/dashboard/users', '/dashboard/audit-log?page=2', '/dashboard?tab=1', '/dashboard#top'])('%s', (raw) => {
    expect(safeNextPath(raw)).toBe(raw);
  });
  it.each(['/dashboard', '/dashboard/users', '/dashboard?x=//evil.test'])('%s resolves on this origin', (raw) => {
    expect(new URL(safeNextPath(raw), 'https://admin.test').origin).toBe('https://admin.test');
  });
});
