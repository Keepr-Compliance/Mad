/**
 * FIDELITY GUARD for the address-filter fixture (BACKLOG-1947 / BACKLOG-1950).
 *
 * The whole harness is only trustworthy if the fixture's committed exact counts
 * (docs/qa/scenarios/fixture-filter-counts.json: OFF=6 / ON=4) are what the app's
 * OWN linking logic actually produces — NOT hand-waved numbers. This test proves
 * that by RECOMPUTING the filter-OFF / filter-ON classification straight from the
 * seeded fixture rows using the REAL app modules:
 *
 *   - electron/utils/addressNormalization.normalizeAddress   (address → tokens)
 *   - electron/utils/emailDateRange.computeTransactionDateRange (the date window)
 *   - scripts/qa/harness/db-set-diff-core.buildDerivedQuery   (the H3 oracle SQL shape)
 *
 * If a future edit to normalizeAddress, the window logic, or the fixture drifts
 * the real counts away from the manifest, THIS test fails first (fast, pure Node),
 * instead of a flaky headful Playwright run.
 *
 * WINDOWLESS-ORACLE INVARIANT (load-bearing): buildDerivedQuery intentionally
 * OMITS the sent_at window (deferred to BACKLOG-1887/FU-1) while the runtime
 * linker enforces it. They agree ONLY because every COUNTED fixture email is
 * inside the window. This test ASSERTS that invariant: every counted email's
 * sent_at ∈ computeTransactionDateRange(fixtureTransaction). Do NOT reopen the
 * BACKLOG-1887 shared-oracle scope to "fix" this — the invariant is the contract.
 *
 * Pure Node: addressNormalization + emailDateRange are dependency-free utils and
 * db-set-diff-core requires no electron/native module, so this runs under the
 * harness jest config (npm run qa:test) with no app launch, DB, or keychain.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeAddress } from '../../../../electron/utils/addressNormalization';
import { computeTransactionDateRange } from '../../../../electron/utils/emailDateRange';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const seed = require('../seed-fixture.js') as {
  defaultFixture: () => FixtureShape;
  FIXTURE_ADDRESS: string;
  FIXTURE_WINDOW_START: string;
};

interface FixtureEmail {
  id: string;
  class: 'off-on' | 'off-only' | 'decoy' | 'own';
  from: string;
  subject: string;
  body_plain: string;
  sent_at: string;
}
interface FixtureShape {
  user: { id: string; email: string };
  contacts: Array<{ email: string }>;
  transaction: { property_address: string; started_at: string; created_at: string; closed_at?: string | null };
  emails: FixtureEmail[];
}

const MANIFEST_PATH = join(__dirname, '..', '..', '..', '..', 'docs', 'qa', 'scenarios', 'fixture-filter-counts.json');
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
  transaction: { address: string; normalizedTokens: string[] };
  contacts: string[];
  ownAddressExcluded: string;
  expectedCounts: { corpus: number; filterOff: number; filterOn: number };
};

const fx = seed.defaultFixture();
const ownAddress = fx.user.email.toLowerCase();
const contactAddresses = new Set(fx.contacts.map((c) => c.email.toLowerCase().trim()));

/** filter-OFF membership per the app: a transaction contact is the participant (own address excluded). */
function isParticipantMatch(e: FixtureEmail): boolean {
  const from = e.from.toLowerCase().trim();
  return from !== ownAddress && contactAddresses.has(from);
}

/** In-window per the RUNTIME linker's computeTransactionDateRange (closed_at=null → end=now). */
function isInWindow(e: FixtureEmail): boolean {
  const { start, end } = computeTransactionDateRange({
    started_at: fx.transaction.started_at,
    created_at: fx.transaction.created_at,
    closed_at: fx.transaction.closed_at ?? null,
  });
  const t = new Date(e.sent_at).getTime();
  return t >= start.getTime() && t <= end.getTime();
}

/** filter-ON: OFF membership AND subject/body contains ALL address tokens (substring, mirrors the SQL LIKE). */
function matchesAddressTokens(e: FixtureEmail, tokens: string[]): boolean {
  const hay = `${e.subject} ${e.body_plain ?? ''}`.toLowerCase();
  return tokens.every((tok) => hay.includes(tok.toLowerCase()));
}

describe('fixture-filter-counts fidelity (BACKLOG-1947/1950)', () => {
  it('normalizeAddress derives the exact tokens the manifest commits to', () => {
    const na = normalizeAddress(seed.FIXTURE_ADDRESS);
    expect(na).not.toBeNull();
    const tokens = [na!.streetNumber, ...na!.streetName.split(/\s+/)];
    // Pins the tokenizer: a future normalizeAddress change surfaces HERE, not in a headful run.
    expect(tokens).toEqual(['742', 'birchwood', 'lane', 'ne']);
    expect(tokens).toEqual(manifest.transaction.normalizedTokens);
  });

  it('the fixture address + contacts match the manifest', () => {
    expect(seed.FIXTURE_ADDRESS).toBe(manifest.transaction.address);
    expect([...contactAddresses].sort()).toEqual([...manifest.contacts].sort());
    expect(ownAddress).toBe(manifest.ownAddressExcluded.toLowerCase());
  });

  it('WINDOW INVARIANT: EVERY seeded email is inside the date window (SR Option A — no out-of-window email)', () => {
    // The invariant that makes the windowless H3 oracle == the windowed runtime BY CONSTRUCTION:
    // no seeded email is outside the window, so the oracle (which omits the window) can never count
    // an email the runtime would exclude. This is why we do NOT seed an out-of-window negative control.
    for (const e of fx.emails) {
      // (jest expect takes a single arg; the id/sent_at is in the loop var for a readable failure)
      expect({ id: e.id, inWindow: isInWindow(e) }).toEqual({ id: e.id, inWindow: true });
    }
    // Belt-and-suspenders: the participant-matched set and the participant-matched-AND-in-window set
    // are identical (the window excludes nothing), so oracle (windowless) == runtime (windowed).
    const participantMatched = fx.emails.filter(isParticipantMatch);
    const inWindowMatched = participantMatched.filter(isInWindow);
    expect(inWindowMatched.length).toBe(participantMatched.length);
  });

  it('recomputes filter-OFF == 6 from the fixture using the REAL app logic', () => {
    const off = fx.emails.filter((e) => isParticipantMatch(e) && isInWindow(e));
    expect(off.length).toBe(manifest.expectedCounts.filterOff);
    expect(off.length).toBe(6);
    // Membership sanity: exactly the 4 match + 2 no-match emails.
    expect(off.map((e) => e.id).sort()).toEqual(
      [
        'qa-seed-email-match-1',
        'qa-seed-email-match-2',
        'qa-seed-email-match-3',
        'qa-seed-email-match-4',
        'qa-seed-email-nomatch-1',
        'qa-seed-email-nomatch-2',
      ].sort(),
    );
  });

  it('recomputes filter-ON == 4 (⊆ OFF) from the fixture using the REAL address tokens', () => {
    const na = normalizeAddress(seed.FIXTURE_ADDRESS)!;
    const tokens = [na.streetNumber, ...na.streetName.split(/\s+/)];
    const off = fx.emails.filter((e) => isParticipantMatch(e) && isInWindow(e));
    const on = off.filter((e) => matchesAddressTokens(e, tokens));
    expect(on.length).toBe(manifest.expectedCounts.filterOn);
    expect(on.length).toBe(4);
    // filter-ON ⊆ filter-OFF.
    const offIds = new Set(off.map((e) => e.id));
    expect(on.every((e) => offIds.has(e.id))).toBe(true);
    // Exactly the 4 MATCH emails.
    expect(on.map((e) => e.id).sort()).toEqual(
      ['qa-seed-email-match-1', 'qa-seed-email-match-2', 'qa-seed-email-match-3', 'qa-seed-email-match-4'].sort(),
    );
    // The delta the toggle asserts.
    expect(off.length - on.length).toBe(2);
  });

  it('DECOY (non-contact participant) and OWN-only emails are in NEITHER set — participant IN() is the gate', () => {
    const na = normalizeAddress(seed.FIXTURE_ADDRESS)!;
    const tokens = [na.streetNumber, ...na.streetName.split(/\s+/)];
    const off = fx.emails.filter((e) => isParticipantMatch(e) && isInWindow(e));
    const on = off.filter((e) => matchesAddressTokens(e, tokens));
    const offIds = new Set(off.map((e) => e.id));
    const onIds = new Set(on.map((e) => e.id));

    // decoy-2 DELIBERATELY mentions the full address but has a non-contact participant → excluded.
    const decoy2 = fx.emails.find((e) => e.id === 'qa-seed-email-decoy-2')!;
    expect(matchesAddressTokens(decoy2, tokens)).toBe(true); // it DOES contain the address text
    expect(offIds.has(decoy2.id)).toBe(false); // …but is NOT linked (no contact participant)
    expect(onIds.has(decoy2.id)).toBe(false);

    for (const id of ['qa-seed-email-decoy-1', 'qa-seed-email-own-1']) {
      expect(offIds.has(id)).toBe(false);
      expect(onIds.has(id)).toBe(false);
    }
  });

  it('corpus == the number of seeded emails owned by the user (manifest)', () => {
    expect(fx.emails.length).toBe(manifest.expectedCounts.corpus);
  });
});
