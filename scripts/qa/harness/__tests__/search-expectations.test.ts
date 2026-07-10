/**
 * QA-H6 search-expectation derivation (BACKLOG-1853), against the REAL committed
 * canonical checklist. These assertions lock the exact corpus-derived expected
 * sets the live DB measurement is diffed against.
 */
import * as path from 'path';
import {
  loadCanonicalList,
  contactShorthand,
  expectedForContact,
  expectedForSubjectToken,
  expectedAddressMention,
  expectedSubjectFamilies,
  stripReplyPrefixes,
  toMembers,
  type ParsedCanonicalList,
} from '../search-expectations';

const MANIFEST = path.join(__dirname, '..', '..', '..', '..', 'docs', 'qa', 'tx1-canonical-list-v2.20.0.md');
const parsed: ParsedCanonicalList = loadCanonicalList(MANIFEST);

describe('canonical sanity', () => {
  test('parses the committed 69/37 checklist', () => {
    expect(parsed.filterOff).toHaveLength(69);
    expect(parsed.filterOn).toHaveLength(37);
  });
});

describe('contactShorthand', () => {
  test('local part before @', () => {
    expect(contactShorthand('amanda@cascadetitle.com')).toBe('amanda');
    expect(contactShorthand('David.Patterson@gmail.com')).toBe('david.patterson');
  });
});

describe('expectedForContact — participant search = canonical subset', () => {
  const amanda = expectedForContact(parsed, 'amanda@cascadetitle.com');

  test('every returned row names the contact and is within the 69', () => {
    expect(amanda.length).toBeGreaterThan(0);
    for (const e of amanda) {
      expect(e.matchedContacts.toLowerCase()).toContain('amanda');
      expect(parsed.filterOff).toContainEqual(e);
    }
  });

  test('exact expected set for amanda@cascadetitle.com (bounded shorthand match)', () => {
    // Rows whose "Matched contact(s)" column names amanda (Cc/From).
    expect(amanda).toHaveLength(8);
  });

  test('does not over-match unrelated shorthands (bounded)', () => {
    // "mark.sullivan" must not be matched by a search for "mark".
    const markShort = expectedForContact(parsed, 'mark@nowhere.com'); // shorthand "mark"
    for (const e of markShort) {
      expect(e.matchedContacts.toLowerCase()).toMatch(/(^|[:,;\s])mark(?=$|[,;\s])/);
    }
  });
});

describe('expectedForSubjectToken', () => {
  test('TX1-confined phrase "Final Walkthrough" → the two walkthrough-scheduling rows', () => {
    const rows = expectedForSubjectToken(parsed, 'Final Walkthrough');
    expect(rows).toHaveLength(2);
    for (const e of rows) expect(e.subject.toLowerCase()).toContain('final walkthrough');
  });

  test('"birchwood" subject subset is non-empty and every row contains it', () => {
    const rows = expectedForSubjectToken(parsed, 'birchwood');
    expect(rows.length).toBeGreaterThan(10);
    for (const e of rows) expect(e.subject.toLowerCase()).toContain('birchwood');
  });
});

describe('expectedAddressMention', () => {
  test('equals the committed filter-ON subset (37)', () => {
    expect(toMembers(expectedAddressMention(parsed))).toHaveLength(37);
  });
});

describe('stripReplyPrefixes / expectedSubjectFamilies', () => {
  test('strips repeated Re:/Fwd: prefixes', () => {
    expect(stripReplyPrefixes('Re: 742 Birchwood')).toBe('742 Birchwood');
    expect(stripReplyPrefixes('RE: Fwd: X')).toBe('X');
  });

  test('reply chains group into subject families of ≥2', () => {
    const families = expectedSubjectFamilies(parsed);
    expect(families.length).toBeGreaterThanOrEqual(3);
    for (const fam of families) {
      expect(fam.members.length).toBeGreaterThanOrEqual(2);
      for (const m of fam.members) expect(stripReplyPrefixes(m.subject)).toBe(fam.family);
    }
  });

  test('the rows-20/21 collision family (inspection recommendations) is present with 2 members', () => {
    const families = expectedSubjectFamilies(parsed);
    const fam = families.find((f) => f.family === '742 Birchwood Lane - Inspection Results - My Recommendations');
    expect(fam).toBeDefined();
    expect(fam!.members).toHaveLength(2);
  });
});
