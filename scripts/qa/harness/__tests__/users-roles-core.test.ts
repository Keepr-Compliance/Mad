import {
  diffRoles,
  EXPECTED_ROLE_TRIPLES,
  QA_SEED_CONTACT_IDS,
  type ObservedContactRole,
  type RoleTriple,
} from '../users-roles-core';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const seed = require('../seed-fixture.js') as {
  QA_SEED_CONTACT_IDS: Record<string, string>;
  defaultFixture: () => { contacts: Array<{ id: string }> };
};

/**
 * BACKLOG-1949 — pure-Node unit tests for the add-users-with-roles cell's expected-set + classifier.
 * No app launch, no DB — proves diffRoles separates PASS (empty deviations) from FAIL (wrong/missing
 * role, wrong category, wrong specific_role, or an unexpected extra assignment) BEFORE the founder-gated
 * live run ever executes.
 */

/** Build the OBSERVED junction rows that EXACTLY match the expected triples (the PASS baseline). */
function observedMatching(): ObservedContactRole[] {
  return EXPECTED_ROLE_TRIPLES.map((t) => ({
    contact_id: t.contactId,
    role: t.role,
    role_category: t.roleCategory,
    specific_role: t.specificRole,
    is_primary: 0,
  }));
}

describe('EXPECTED_ROLE_TRIPLES — deterministic, purchase-valid ground truth', () => {
  it('assigns exactly the three seeded fixture contacts', () => {
    expect(EXPECTED_ROLE_TRIPLES.map((t) => t.contactId)).toEqual([
      QA_SEED_CONTACT_IDS[1],
      QA_SEED_CONTACT_IDS[2],
      QA_SEED_CONTACT_IDS[3],
    ]);
  });

  // BACKLOG-1949: the app validates contact IDs as UUIDs on SAVE, so the seeded ids MUST be valid UUIDs.
  it('uses VALID UUIDs (not the old non-UUID qa-seed-contact-N literals)', () => {
    const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    for (const t of EXPECTED_ROLE_TRIPLES) {
      expect(t.contactId).toMatch(uuidV4);
      expect(t.contactId).not.toMatch(/^qa-seed-contact-/);
    }
  });

  // BACKLOG-1949 SINGLE-SOURCE CROSS-CHECK: the cell's contact IDs MUST equal the seeder's, or the cell
  // would drive the UI against IDs the fixture never seeded. Guards the cross-process duplication.
  it('the cell contact IDs match the seeder (seed-fixture.js QA_SEED_CONTACT_IDS)', () => {
    expect(QA_SEED_CONTACT_IDS).toEqual(seed.QA_SEED_CONTACT_IDS);
    const seededIds = seed.defaultFixture().contacts.map((c) => c.id);
    expect(EXPECTED_ROLE_TRIPLES.map((t) => t.contactId)).toEqual(seededIds);
  });

  it('uses only PURCHASE-valid roles (seller / seller_agent / escrow_officer), never buyer/listing_agent', () => {
    const roles = EXPECTED_ROLE_TRIPLES.map((t) => t.role);
    expect(roles).toEqual(['seller', 'seller_agent', 'escrow_officer']);
    expect(roles).not.toContain('buyer');
    expect(roles).not.toContain('listing_agent');
  });

  it('keeps role and specific_role in sync (the add path normalizes them)', () => {
    for (const t of EXPECTED_ROLE_TRIPLES) {
      expect(t.specificRole).toBe(t.role);
    }
  });

  it('maps each role to its ROLE_TO_CATEGORY category', () => {
    const byRole = Object.fromEntries(EXPECTED_ROLE_TRIPLES.map((t) => [t.role, t.roleCategory]));
    expect(byRole).toEqual({
      seller: 'client',
      seller_agent: 'agent',
      escrow_officer: 'title_escrow',
    });
  });
});

describe('diffRoles — PASS classification', () => {
  it('returns zero deviations when every observed triple matches (PASS)', () => {
    expect(diffRoles(EXPECTED_ROLE_TRIPLES, observedMatching())).toEqual([]);
  });

  it('is order-independent (junction rows may come back in any order)', () => {
    const reversed = [...observedMatching()].reverse();
    expect(diffRoles(EXPECTED_ROLE_TRIPLES, reversed)).toEqual([]);
  });
});

describe('diffRoles — FAIL classification', () => {
  it('flags a wrong role (a real persistence bug)', () => {
    const observed = observedMatching();
    observed[0] = { ...observed[0], role: 'buyer' }; // app persisted the wrong role
    const devs = diffRoles(EXPECTED_ROLE_TRIPLES, observed);
    expect(devs).toContainEqual({
      contactId: QA_SEED_CONTACT_IDS[1],
      kind: 'wrong-role',
      expected: 'seller',
      got: 'buyer',
    });
  });

  it('flags a wrong role_category (ROLE_TO_CATEGORY derivation regression)', () => {
    const observed = observedMatching();
    observed[1] = { ...observed[1], role_category: 'support' }; // mis-derived category
    const devs = diffRoles(EXPECTED_ROLE_TRIPLES, observed);
    expect(devs).toContainEqual({
      contactId: QA_SEED_CONTACT_IDS[2],
      kind: 'wrong-category',
      expected: 'agent',
      got: 'support',
    });
  });

  it('flags a wrong specific_role (role/specific_role fell out of sync)', () => {
    const observed = observedMatching();
    observed[2] = { ...observed[2], specific_role: 'title_company' };
    const devs = diffRoles(EXPECTED_ROLE_TRIPLES, observed);
    expect(devs).toContainEqual({
      contactId: QA_SEED_CONTACT_IDS[3],
      kind: 'wrong-specific-role',
      expected: 'escrow_officer',
      got: 'title_company',
    });
  });

  it('flags a missing contact (never assigned to the junction)', () => {
    const observed = observedMatching().slice(1); // drop the first seeded contact
    const devs = diffRoles(EXPECTED_ROLE_TRIPLES, observed);
    expect(devs).toContainEqual({
      contactId: QA_SEED_CONTACT_IDS[1],
      kind: 'missing',
      expected: 'seller',
      got: null,
    });
  });

  it('flags an UNEXPECTED extra assignment (added someone it should not have)', () => {
    const observed: ObservedContactRole[] = [
      ...observedMatching(),
      { contact_id: 'qa-seed-contact-decoy', role: 'buyer', role_category: 'client', specific_role: 'buyer', is_primary: 0 },
    ];
    const devs = diffRoles(EXPECTED_ROLE_TRIPLES, observed);
    expect(devs).toContainEqual({
      contactId: 'qa-seed-contact-decoy',
      kind: 'wrong-role',
      expected: '',
      got: 'buyer',
    });
  });

  it('reports multiple independent deviations at once', () => {
    const observed = observedMatching();
    observed[0] = { ...observed[0], role: 'buyer', role_category: 'client', specific_role: 'buyer' };
    const partial: RoleTriple[] = [...EXPECTED_ROLE_TRIPLES];
    const devs = diffRoles(partial, observed);
    // wrong-role + wrong-specific-role for contact-1 (category still 'client' = correct → no cat dev).
    expect(devs.filter((d) => d.contactId === QA_SEED_CONTACT_IDS[1]).map((d) => d.kind).sort()).toEqual([
      'wrong-role',
      'wrong-specific-role',
    ]);
  });
});
