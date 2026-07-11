/**
 * SR review C1 regression guard (BACKLOG-1850) — MULTISET set identity.
 *
 * The canonical TX1 list contains a genuine (subject, shifted-date) collision:
 * rows 20 & 21 are two DISTINCT emails ("Re: 742 Birchwood Lane - Inspection
 * Results - My Recommendations", 2026-02-14, both ON-subset). The original H3
 * implementation de-duplicated by identity key (`dedupeMembers`) and diffed via
 * `Set`, so it silently collapsed the pair → measured 68/36 instead of 69/37
 * while reporting 0 missing / 0 extra (the deviation was MASKED).
 *
 * This test locks in the fix: H3's measurement (`rowToMember`, no dedupe) feeds
 * H1's MULTISET diff (`diff.ts`), which preserves the collision and catches a
 * dropped collision row by multiplicity. It FAILS against the old dedupe/Set
 * behaviour and passes now.
 */
import { readFileSync } from 'fs';
import * as path from 'path';
import { parseCanonicalList } from '../canonicalList';
import { diffMembers } from '../diff';
import type { EmailSetMember } from '../types';
// The DB-side measurement helper is CommonJS JS; require returns `any`.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require('../db-set-diff-core');

const MANIFEST = path.join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'docs',
  'qa',
  'tx1-canonical-list-v2.20.0.md',
);
const COLLISION_SUBJECT =
  'Re: 742 Birchwood Lane - Inspection Results - My Recommendations';
const COLLISION_DATE = '2026-02-14';

const parsed = parseCanonicalList(readFileSync(MANIFEST, 'utf-8'));
const keyOf = (m: EmailSetMember): string => `${m.subject}::${m.shiftedDate}`;

describe('multiset identity — SR C1 regression guard', () => {
  test('canonical list exposes the rows-20/21 (subject, shifted-date) collision', () => {
    expect(parsed.filterOff).toHaveLength(69);
    expect(parsed.filterOn).toHaveLength(37);
    expect(parsed.collisions.length).toBeGreaterThanOrEqual(1);
    const pair = parsed.collisions.find(
      (bucket) => keyOf(bucket[0]) === `${COLLISION_SUBJECT}::${COLLISION_DATE}`,
    );
    expect(pair).toBeDefined();
    expect(pair).toHaveLength(2);
    // Two DISTINCT emails (different .eml files) share one identity key.
    expect(pair![0].emlFile).not.toBe(pair![1].emlFile);
  });

  test('rowToMember does NOT collapse the collision (measures 2, not 1)', () => {
    // Two distinct DB rows with the SAME (subject, shifted-date) key.
    const dbRows = [
      { subject: COLLISION_SUBJECT, sent_at: `${COLLISION_DATE}T20:00:00.000Z` },
      { subject: COLLISION_SUBJECT, sent_at: `${COLLISION_DATE}T22:30:00.000Z` },
    ];
    const members: EmailSetMember[] = dbRows.map((r) => core.rowToMember(r));
    // Old dedupeMembers() returned length 1 here → the 68-not-69 bug.
    expect(members).toHaveLength(2);
    expect(members.every((m) => keyOf(m) === `${COLLISION_SUBJECT}::${COLLISION_DATE}`)).toBe(true);
  });

  test('a complete measurement (all 69) diffs clean under multiset semantics', () => {
    const expected: EmailSetMember[] = parsed.filterOff.map((e) => ({
      subject: e.subject,
      shiftedDate: e.shiftedDate,
    }));
    const actual = expected; // measured exactly the 69, collision preserved
    const { missing, extra } = diffMembers(expected, actual);
    expect(expected).toHaveLength(69);
    expect(missing).toHaveLength(0);
    expect(extra).toHaveLength(0);
  });

  test('dropping ONE collision row is caught by multiplicity (a Set diff would MASK it)', () => {
    const expected: EmailSetMember[] = parsed.filterOff.map((e) => ({
      subject: e.subject,
      shiftedDate: e.shiftedDate,
    }));
    // Actual is missing exactly ONE of the two 2026-02-14 collision rows.
    let dropped = false;
    const actual = expected.filter((m) => {
      if (!dropped && keyOf(m) === `${COLLISION_SUBJECT}::${COLLISION_DATE}`) {
        dropped = true;
        return false;
      }
      return true;
    });
    expect(actual).toHaveLength(68);

    const { missing, extra } = diffMembers(expected, actual);
    // MULTISET: exactly ONE missing. A Set-based diff would report 0 missing
    // (the key still appears once in `actual`) — the exact masking bug from C1.
    expect(missing).toHaveLength(1);
    expect(missing[0]).toEqual({ subject: COLLISION_SUBJECT, shiftedDate: COLLISION_DATE });
    expect(extra).toHaveLength(0);
  });
});
