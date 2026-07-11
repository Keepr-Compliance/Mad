/**
 * Live-validation DEFECT 1 regression guard (BACKLOG-1850) — identity-key
 * equality between the DB-measure side and the canonical checklist.
 *
 * The founder's live run reported filter-OFF rows that did not match canonical
 * keys. Root cause: the app stores `sent_at` as UTC (`new Date(x).toISOString()`)
 * but the canonical "shifted date" is the corpus author's LOCAL (Pacific) date.
 * A naive UTC `slice(0,10)` lands the 4 evening emails +1 day.
 *
 * These fixtures are REAL rows read from the founder's encrypted DB (mad.db) +
 * their exact lines in docs/qa/tx1-canonical-list-v2.20.0.md. The test asserts
 * H1's `memberKey(rowToMember(dbRow, tz)) === memberKey(canonicalLine)` — and
 * that WITHOUT the source timezone the evening rows MIS-match (the bug).
 */
import { memberKey } from '../diff';
import type { EmailSetMember } from '../types';
// DB-measure helper is CommonJS JS; require returns `any`.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require('../db-set-diff-core');

const TZ = 'America/Los_Angeles';

interface Fixture {
  db: { subject: string; sent_at: string };
  canonical: EmailSetMember;
  offByOne: boolean;
}

// Real (subject, sent_at) pairs dumped from the founder's DB, with the exact
// canonical checklist line each must match.
const FIXTURES: Fixture[] = [
  {
    db: { subject: 'RE: 742 Birchwood Lane - MUTUAL ACCEPTANCE!', sent_at: '2026-02-09T22:30:00.000Z' },
    canonical: { subject: 'RE: 742 Birchwood Lane - MUTUAL ACCEPTANCE!', shiftedDate: '2026-02-09' },
    offByOne: false, // daytime Pacific — UTC date already equals local date
  },
  {
    db: { subject: '742 Birchwood Lane showing today - thoughts?', sent_at: '2026-02-08T00:30:00.000Z' },
    canonical: { subject: '742 Birchwood Lane showing today - thoughts?', shiftedDate: '2026-02-07' },
    offByOne: true, // 00:30Z = 2026-02-07 16:30 PST
  },
  {
    db: { subject: 'Re: 742 Birchwood Lane - Walkthrough Complete - All Good!', sent_at: '2026-04-15T01:30:00.000Z' },
    canonical: { subject: 'Re: 742 Birchwood Lane - Walkthrough Complete - All Good!', shiftedDate: '2026-04-14' },
    offByOne: true, // 01:30Z = 2026-04-14 18:30 PDT
  },
];

describe('identity-key equality vs canonical (live-validation defect 1)', () => {
  test.each(FIXTURES)('source-tz key matches canonical: %#', (f) => {
    const measured = core.rowToMember(f.db, TZ) as EmailSetMember;
    expect(memberKey(measured)).toBe(memberKey(f.canonical));
  });

  test('WITHOUT source timezone (raw UTC slice) the evening rows MIS-match — the bug', () => {
    for (const f of FIXTURES) {
      const utc = core.rowToMember(f.db) as EmailSetMember; // no tz
      if (f.offByOne) {
        expect(memberKey(utc)).not.toBe(memberKey(f.canonical));
      } else {
        expect(memberKey(utc)).toBe(memberKey(f.canonical));
      }
    }
  });
});
