/**
 * FIDELITY GUARD for the address-filter fixture (BACKLOG-1947 / BACKLOG-1950).
 *
 * The whole harness is only trustworthy if the fixture's committed exact counts
 * (docs/qa/scenarios/fixture-filter-counts.json: OFF=6 / ON=4) are what the app's
 * OWN linking logic actually produces — NOT hand-waved numbers. This test proves
 * that by RECOMPUTING the filter-OFF / filter-ON classification straight from the
 * seeded fixture rows.
 *
 * WHAT IS REAL vs REIMPLEMENTED (be precise — do not overclaim):
 *   - REAL, imported directly:
 *       electron/utils/addressNormalization.normalizeAddress      (address → components)
 *       electron/utils/addressNormalization.contentContainsAddress (the address gate itself)
 *       electron/utils/emailDateRange.computeTransactionDateRange  (the date window)
 *   - LOCAL reimplementations (isParticipantMatch / isInWindow below): faithful mirrors
 *     of the app's participant-address `IN (contacts)` clause and the sent_at window.
 *
 *     BACKLOG-2678: the address predicate USED to be local too (`matchesAddressTokens`,
 *     require-every-token, mirroring the pre-BACKLOG-2311 SQL `LIKE` chain). BACKLOG-2311
 *     moved address filtering out of SQL into JS and demoted suffix/directional to
 *     OPTIONAL, at which point that local mirror was no longer a mirror — it just kept
 *     agreeing on this fixture. It now calls the app's own contentContainsAddress.
 *
 *     This guard still does NOT drive the SQL builder; the actual SQL shape is exercised
 *     END-TO-END by the H3 oracle against the real encrypted DB in the runtime cell
 *     (e2e/tests/filter-toggle-counts.spec.ts, "H3 oracle" test). NOTE that the oracle's
 *     buildDerivedQuery is itself still on the pre-2311 all-tokens semantics — the two
 *     agree on this fixture only because every seeded MATCH email spells the full
 *     address. That divergence is BACKLOG-2688, including the boundary email that would
 *     tell them apart.
 *
 * If a future edit to normalizeAddress, the window logic, or the fixture drifts
 * the real counts away from the manifest, THIS test fails first (fast, pure Node),
 * instead of a flaky headful Playwright run.
 *
 * WINDOWLESS-ORACLE INVARIANT (load-bearing): the H3 oracle (buildDerivedQuery)
 * intentionally OMITS the sent_at window (deferred to BACKLOG-1887/FU-1) while the
 * runtime linker enforces it. They agree ONLY because every seeded fixture email is
 * inside the window. This test ASSERTS that invariant: every email's sent_at ∈
 * computeTransactionDateRange(fixtureTransaction). Do NOT reopen the BACKLOG-1887
 * shared-oracle scope to "fix" this — the invariant is the contract.
 *
 * Pure Node: addressNormalization + emailDateRange are dependency-free utils, so
 * this runs under the harness jest config (npm run qa:test) with no app launch,
 * DB, or keychain.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  normalizeAddress,
  contentContainsAddress,
  type NormalizedAddress,
} from '../../../../electron/utils/addressNormalization';
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

/**
 * filter-ON: OFF membership AND the REAL app matcher accepts the email content.
 *
 * BACKLOG-2678: this used to be a local `matchesAddressTokens` reimplementation that required
 * EVERY token as a substring, mirroring the pre-BACKLOG-2311 SQL `LIKE` chain. BACKLOG-2311 moved
 * address filtering out of SQL and into JS (autoLinkService.ts:283-295) and made suffix/directional
 * OPTIONAL, so that mirror silently stopped being one. We now call the app's own
 * `contentContainsAddress` — one less reimplementation to drift.
 */
function matchesAddress(e: FixtureEmail, na: NormalizedAddress): boolean {
  return contentContainsAddress(`${e.subject} ${e.body_plain ?? ''}`, na);
}

describe('fixture-filter-counts fidelity (BACKLOG-1947/1950)', () => {
  it('normalizeAddress derives the exact components the matcher consumes', () => {
    const na = normalizeAddress(seed.FIXTURE_ADDRESS);
    expect(na).not.toBeNull();
    // Pins the tokenizer: a future normalizeAddress change surfaces HERE, not in a headful run.
    // BACKLOG-2311 shape — streetNumber + REQUIRED distinctive word(s), with suffix and directional
    // demoted to OPTIONAL and canonicalized ("NE" -> "northeast").
    expect(na).toEqual({
      streetNumber: '742',
      requiredNameWords: ['birchwood'],
      optionalWords: ['lane', 'northeast'],
      full: '742 birchwood lane northeast',
    });

    // NOT compared against manifest.transaction.normalizedTokens (["742","birchwood","lane","ne"]).
    // That array is NOT documentation: it feeds db-assert.js -> buildDerivedQuery -> the live
    // Playwright H3 oracle as one `LIKE '%<token>%'` per token, and the seeded fixture emails spell
    // the directional "NE". Regenerating it to the canonical "northeast" would make the oracle
    // search for a string no fixture email contains and collapse the runtime ON-count from 4 to 0.
    // The manifest bytes are deliberately left alone; reconciling the oracle with the post-2311
    // required/optional semantics is BACKLOG-2688.
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

  it('recomputes filter-ON == 4 (⊆ OFF) from the fixture using the REAL address matcher', () => {
    const na = normalizeAddress(seed.FIXTURE_ADDRESS)!;
    const off = fx.emails.filter((e) => isParticipantMatch(e) && isInWindow(e));
    const on = off.filter((e) => matchesAddress(e, na));
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
    const off = fx.emails.filter((e) => isParticipantMatch(e) && isInWindow(e));
    const on = off.filter((e) => matchesAddress(e, na));
    const offIds = new Set(off.map((e) => e.id));
    const onIds = new Set(on.map((e) => e.id));

    // decoy-2 DELIBERATELY mentions the full address but has a non-contact participant → excluded.
    const decoy2 = fx.emails.find((e) => e.id === 'qa-seed-email-decoy-2')!;
    expect(matchesAddress(decoy2, na)).toBe(true); // it DOES contain the address text
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
