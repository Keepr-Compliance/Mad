/**
 * Unit tests for the DELETE-EMAILS cell core (BACKLOG-1982). Pure Node — no app launch, DB, or
 * keychain; runs under the harness jest config (npm run qa:test).
 *
 * Proves the thread-aware expected-unlink oracle is correct (singleton vs. thread expansion vs. bulk
 * union) and that the duplicated DELETE_EMAILS_THREAD_MAP stays byte-identical to the seeder's map (the
 * writer runs in a separate Electron-main process, so the value is mirrored and cross-checked here —
 * the users-roles QA_SEED_CONTACT_IDS precedent).
 */
import {
  DELETE_EMAILS_THREAD_MAP,
  SEEDED_LINKED_EMAIL_IDS,
  expectedUnlinkForThread,
  expectedUnlinkForBulk,
} from '../delete-emails-core';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const seed = require('../seed-fixture.js') as {
  DELETE_EMAILS_THREAD_MAP: Record<string, string>;
};

describe('delete-emails-core thread map fidelity (BACKLOG-1982)', () => {
  it('the core DELETE_EMAILS_THREAD_MAP is byte-identical to the seeder map', () => {
    // The seeder (Electron-main) is the WRITER; this core (Node cell) mirrors it. If they drift, the
    // expected-unlink oracle would compute against a thread structure the DB does not have.
    expect(DELETE_EMAILS_THREAD_MAP).toEqual(seed.DELETE_EMAILS_THREAD_MAP);
  });

  it('match-4 is intentionally NOT in the thread map (a NULL-thread singleton)', () => {
    expect(DELETE_EMAILS_THREAD_MAP['qa-seed-email-match-4']).toBeUndefined();
    expect(SEEDED_LINKED_EMAIL_IDS).toContain('qa-seed-email-match-4');
  });

  it('THREAD A groups match-1 + match-2 under one thread_id', () => {
    expect(DELETE_EMAILS_THREAD_MAP['qa-seed-email-match-1']).toBe('qa-seed-thread-A');
    expect(DELETE_EMAILS_THREAD_MAP['qa-seed-email-match-2']).toBe('qa-seed-thread-A');
    expect(DELETE_EMAILS_THREAD_MAP['qa-seed-email-match-3']).toBe('qa-seed-thread-B');
  });
});

describe('expectedUnlinkForThread (BACKLOG-1982)', () => {
  const linked = SEEDED_LINKED_EMAIL_IDS;

  it('SINGLETON: unlinking a NULL-thread email removes ONLY that email', () => {
    expect(expectedUnlinkForThread('qa-seed-email-match-4', DELETE_EMAILS_THREAD_MAP, linked)).toEqual([
      'qa-seed-email-match-4',
    ]);
    // A nomatch email is also a NULL-thread singleton.
    expect(expectedUnlinkForThread('qa-seed-email-nomatch-1', DELETE_EMAILS_THREAD_MAP, linked)).toEqual([
      'qa-seed-email-nomatch-1',
    ]);
  });

  it('THREAD EXPANSION: unlinking one of THREAD A removes BOTH siblings (thread-aware, not 1)', () => {
    expect(expectedUnlinkForThread('qa-seed-email-match-1', DELETE_EMAILS_THREAD_MAP, linked)).toEqual([
      'qa-seed-email-match-1',
      'qa-seed-email-match-2',
    ]);
    // Symmetric: clicking the OTHER sibling yields the same set.
    expect(expectedUnlinkForThread('qa-seed-email-match-2', DELETE_EMAILS_THREAD_MAP, linked)).toEqual([
      'qa-seed-email-match-1',
      'qa-seed-email-match-2',
    ]);
  });

  it('THREAD B (1 email but a thread_id) removes only itself', () => {
    expect(expectedUnlinkForThread('qa-seed-email-match-3', DELETE_EMAILS_THREAD_MAP, linked)).toEqual([
      'qa-seed-email-match-3',
    ]);
  });

  it('a thread sibling that is NOT currently linked is not included in the expansion', () => {
    // If match-2 were somehow not linked, unlinking match-1 removes only match-1.
    const partialLinked = linked.filter((id) => id !== 'qa-seed-email-match-2');
    expect(expectedUnlinkForThread('qa-seed-email-match-1', DELETE_EMAILS_THREAD_MAP, partialLinked)).toEqual([
      'qa-seed-email-match-1',
    ]);
  });

  it('unlinking an email that is not linked yields the empty set', () => {
    expect(expectedUnlinkForThread('qa-seed-email-decoy-1', DELETE_EMAILS_THREAD_MAP, linked)).toEqual([]);
  });
});

describe('expectedUnlinkForBulk (BACKLOG-1982)', () => {
  const linked = SEEDED_LINKED_EMAIL_IDS;

  it('bulk = the UNION of per-representative expansions (thread A + a singleton)', () => {
    // Select THREAD A (rep match-1) + the match-4 singleton → 3 emails removed.
    const removed = expectedUnlinkForBulk(['qa-seed-email-match-1', 'qa-seed-email-match-4'], DELETE_EMAILS_THREAD_MAP, linked);
    expect(removed).toEqual(['qa-seed-email-match-1', 'qa-seed-email-match-2', 'qa-seed-email-match-4']);
  });

  it('bulk dedups when two representatives resolve to the same thread', () => {
    // Both reps are in THREAD A → the union is still just the 2 thread-A emails.
    const removed = expectedUnlinkForBulk(['qa-seed-email-match-1', 'qa-seed-email-match-2'], DELETE_EMAILS_THREAD_MAP, linked);
    expect(removed).toEqual(['qa-seed-email-match-1', 'qa-seed-email-match-2']);
  });

  it('bulk over THREAD A + THREAD B + two singletons = 5 emails', () => {
    const removed = expectedUnlinkForBulk(
      ['qa-seed-email-match-1', 'qa-seed-email-match-3', 'qa-seed-email-match-4', 'qa-seed-email-nomatch-1'],
      DELETE_EMAILS_THREAD_MAP,
      linked,
    );
    expect(removed).toEqual([
      'qa-seed-email-match-1',
      'qa-seed-email-match-2',
      'qa-seed-email-match-3',
      'qa-seed-email-match-4',
      'qa-seed-email-nomatch-1',
    ]);
  });
});
