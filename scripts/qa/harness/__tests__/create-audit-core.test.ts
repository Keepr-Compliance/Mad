/**
 * Unit proofs for the CREATE-AUDIT cell's shared core (BACKLOG-1948).
 *
 * Guards the deterministic, load-bearing CONSTANTS + expected-shape builder the driver, the Playwright
 * spec, and the DB reader all agree on:
 *   - the KNOWN address is UNIQUE (not the seeded fixture address) and the start date is a FIXED past
 *     ISO date (clock-independent) — so "exactly one row" is unambiguous and stable;
 *   - the seeded contact id + Client role match the seed fixture + the wizard's step-3 gate;
 *   - buildExpectedCreate defaults to exactly-one and honours overrides.
 *
 * Pure Node → no app launch, no Electron, no DB. Runs under jest.qa.config.js.
 */
import {
  buildExpectedCreate,
  KNOWN_CREATE_ADDRESS,
  KNOWN_CREATE_CONTACT_ID,
  KNOWN_CREATE_ROLE,
  KNOWN_CREATE_START_DATE,
} from '../create-audit-core';

describe('known create-flow constants', () => {
  it('the known address is a non-empty, distinctive string (NOT the seeded fixture address)', () => {
    expect(KNOWN_CREATE_ADDRESS).toMatch(/1948 Harness Way/);
    // Must not collide with the filter-toggle fixture transaction address.
    expect(KNOWN_CREATE_ADDRESS).not.toMatch(/Birchwood/i);
  });

  it('the start date is a FIXED past ISO date (YYYY-MM-DD) — clock-independent', () => {
    expect(KNOWN_CREATE_START_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Parseable and strictly in the past (so it never depends on "today").
    const t = Date.parse(KNOWN_CREATE_START_DATE);
    expect(Number.isNaN(t)).toBe(false);
    expect(t).toBeLessThan(Date.now());
  });

  it('the contact id + role match the seed fixture and the step-3 Client gate', () => {
    expect(KNOWN_CREATE_CONTACT_ID).toBe('qa-seed-contact-1');
    expect(KNOWN_CREATE_ROLE).toBe('client');
  });
});

describe('buildExpectedCreate', () => {
  it('defaults to exactly-one row for the known address + start prefix', () => {
    expect(buildExpectedCreate()).toEqual({
      address: KNOWN_CREATE_ADDRESS,
      startedAtPrefix: KNOWN_CREATE_START_DATE,
      expectedCount: 1,
    });
  });

  it('honours overrides (e.g. a different address or count)', () => {
    expect(buildExpectedCreate({ address: 'Other', expectedCount: 0 })).toEqual({
      address: 'Other',
      startedAtPrefix: KNOWN_CREATE_START_DATE,
      expectedCount: 0,
    });
  });
});
