/**
 * Staleness threshold + relative-time logic (BACKLOG-2204).
 *
 * Pure functions — no mocks. Pins the fresh/stale boundary (the signal that
 * makes a silently-killed background sync visible) and the age computation.
 */

import {
  getSyncFreshness,
  formatRelativeTime,
  STALE_THRESHOLD_MS,
} from '../syncStaleness';

const NOW = Date.parse('2026-07-28T12:00:00.000Z');
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

describe('getSyncFreshness', () => {
  it('returns "never" for a null / undefined / empty timestamp', () => {
    expect(getSyncFreshness(null, { now: NOW })).toEqual({
      status: 'never',
      ageMs: null,
    });
    expect(getSyncFreshness(undefined, { now: NOW })).toEqual({
      status: 'never',
      ageMs: null,
    });
    expect(getSyncFreshness('', { now: NOW })).toEqual({
      status: 'never',
      ageMs: null,
    });
  });

  it('returns "never" for an unparseable timestamp', () => {
    expect(getSyncFreshness('not-a-date', { now: NOW })).toEqual({
      status: 'never',
      ageMs: null,
    });
  });

  it('is "fresh" when the last sync is younger than the threshold', () => {
    const r = getSyncFreshness(iso(STALE_THRESHOLD_MS - 1), { now: NOW });
    expect(r.status).toBe('fresh');
    expect(r.ageMs).toBe(STALE_THRESHOLD_MS - 1);
  });

  it('is "stale" at exactly the threshold boundary (>=)', () => {
    const r = getSyncFreshness(iso(STALE_THRESHOLD_MS), { now: NOW });
    expect(r.status).toBe('stale');
    expect(r.ageMs).toBe(STALE_THRESHOLD_MS);
  });

  it('is "stale" when the last sync is older than the threshold', () => {
    const r = getSyncFreshness(iso(STALE_THRESHOLD_MS + 60_000), { now: NOW });
    expect(r.status).toBe('stale');
    expect(r.ageMs).toBe(STALE_THRESHOLD_MS + 60_000);
  });

  it('computes ageMs correctly for a recent sync', () => {
    expect(getSyncFreshness(iso(5 * 60_000), { now: NOW }).ageMs).toBe(
      5 * 60_000,
    );
  });

  it('clamps a future timestamp (clock skew) to ageMs 0 and treats it as fresh', () => {
    const future = new Date(NOW + 10_000).toISOString();
    expect(getSyncFreshness(future, { now: NOW })).toEqual({
      status: 'fresh',
      ageMs: 0,
    });
  });

  it('honours a custom threshold override', () => {
    const custom = 60_000; // 1 minute
    expect(getSyncFreshness(iso(30_000), { now: NOW, thresholdMs: custom }).status).toBe(
      'fresh',
    );
    expect(getSyncFreshness(iso(90_000), { now: NOW, thresholdMs: custom }).status).toBe(
      'stale',
    );
  });
});

describe('formatRelativeTime', () => {
  it('returns "Never" for a missing / unparseable value', () => {
    expect(formatRelativeTime(null, NOW)).toBe('Never');
    expect(formatRelativeTime(undefined, NOW)).toBe('Never');
    expect(formatRelativeTime('nope', NOW)).toBe('Never');
  });

  it('formats sub-minute / minute / hour ranges', () => {
    expect(formatRelativeTime(iso(30_000), NOW)).toBe('Just now');
    expect(formatRelativeTime(iso(5 * 60_000), NOW)).toBe('5 min ago');
    expect(formatRelativeTime(iso(2 * 3_600_000), NOW)).toBe('2 hr ago');
  });

  it('falls back to an absolute date beyond 24h', () => {
    // Beyond a day it uses toLocaleDateString; assert it is NOT a relative phrase.
    const out = formatRelativeTime(iso(2 * 86_400_000), NOW);
    expect(out).not.toMatch(/ago|Just now|Never/);
  });
});
