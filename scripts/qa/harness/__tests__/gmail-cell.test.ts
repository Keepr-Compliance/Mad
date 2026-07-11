/**
 * Gmail cell wiring + per-provider manifest tests (BACKLOG-1851 / QA-H4).
 *
 * - The committed Gmail scenario + PROVISIONAL manifest load and agree on the
 *   corpus-derived 190/69/37 (no drift vs their own declared counts).
 * - `sourceTimezone` is now a first-class, validated manifest field.
 * - A parity TRIPWIRE asserts the Gmail expected membership currently equals
 *   Outlook's. This is provisional: when a live Gmail run (BACKLOG-1845) proves
 *   a real provider delta, THIS test failing is the signal to update the Gmail
 *   manifest — not to force the two providers equal forever.
 */
import { resolve } from 'path';
import { loadScenario } from '../manifest';
import { loadCanonicalList, toExpectedSets } from '../canonicalList';
import { memberKey } from '../diff';
import type { EmailSetMember } from '../types';

const REPO_ROOT = resolve(__dirname, '../../../..');
const GMAIL_SCENARIO = resolve(REPO_ROOT, 'docs/qa/scenarios/tx1-birchwood-gmail.json');
const OUTLOOK_MANIFEST = resolve(REPO_ROOT, 'docs/qa/tx1-canonical-list-v2.20.0.md');
const GMAIL_MANIFEST = resolve(REPO_ROOT, 'docs/qa/tx1-canonical-list-gmail-v2.20.0.md');

function multiset(members: EmailSetMember[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of members) m.set(memberKey(x), (m.get(memberKey(x)) ?? 0) + 1);
  return m;
}

describe('Gmail scenario', () => {
  it('loads, is gmail-sourced, and carries a validated sourceTimezone', () => {
    const { scenario, canonicalListPath } = loadScenario(GMAIL_SCENARIO);
    expect(scenario.source).toBe('gmail');
    expect(scenario.setIdentity).toBe('subject+shifted-date');
    expect(scenario.contacts).toHaveLength(9);
    // sourceTimezone is now formalized in the schema (was previously stripped).
    expect(scenario.sourceTimezone).toBe('America/Los_Angeles');
    expect(canonicalListPath.endsWith('docs/qa/tx1-canonical-list-gmail-v2.20.0.md')).toBe(true);
  });

  it('agrees with its PROVISIONAL manifest on the exact 190/69/37 counts', () => {
    const { scenario, canonicalListPath } = loadScenario(GMAIL_SCENARIO);
    const parsed = loadCanonicalList(canonicalListPath);
    // toExpectedSets throws if the checklist and manifest counts have drifted.
    const expected = toExpectedSets(parsed, scenario.expectedCounts);
    expect(expected.counts.corpus).toBe(190);
    expect(expected.filterOff).toHaveLength(69);
    expect(expected.filterOn).toHaveLength(37);
  });
});

describe('Gmail↔Outlook per-provider parity tripwire (PROVISIONAL)', () => {
  it('Gmail expected membership currently equals Outlook (until a live delta, BACKLOG-1845)', () => {
    const outlook = loadCanonicalList(OUTLOOK_MANIFEST);
    const gmail = loadCanonicalList(GMAIL_MANIFEST);

    const om = multiset(outlook.filterOff);
    const gm = multiset(gmail.filterOff);

    const drifted: string[] = [];
    for (const [key, n] of om) {
      if ((gm.get(key) ?? 0) !== n) drifted.push(key);
    }
    for (const key of gm.keys()) {
      if (!om.has(key)) drifted.push(key);
    }

    // If this fails AFTER a live Gmail run, it is an EXPECTED provider delta
    // (BACKLOG-1845/1806): update tx1-canonical-list-gmail-v2.20.0.md to the
    // real Gmail-derived membership. Do NOT force the providers equal.
    expect({ drifted, gmailOn: gmail.filterOn.length }).toEqual({
      drifted: [],
      gmailOn: outlook.filterOn.length,
    });
  });
});
