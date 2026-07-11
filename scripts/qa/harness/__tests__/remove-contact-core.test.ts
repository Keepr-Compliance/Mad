import {
  CONTACT_TO_REMOVE,
  EXPECTED_REMAINING_CONTACT_IDS,
  QA_SEED_CONTACT_IDS,
  SEEDED_ASSIGNED_CONTACT_IDS,
  diffRemoval,
  type ObservedContactRole,
} from '../remove-contact-core';

/**
 * BACKLOG-1978 — pure-Node unit tests for the remove-contact cell's expected-set + classifier.
 * No app launch, no DB — proves diffRemoval separates PASS (empty deviations, junction == survivors) from
 * FAIL (removed contact still present, a survivor wrongly removed, or a spurious extra row) BEFORE the
 * founder-gated live run ever executes.
 */

/** A minimal observed junction row for a contact id (role fields are irrelevant to the removal oracle). */
function row(contactId: string): ObservedContactRole {
  return { contact_id: contactId, role: 'seller', role_category: 'client', specific_role: 'seller', is_primary: 0 };
}

/** The OBSERVED junction that EXACTLY matches the expected post-remove state (the PASS baseline). */
function observedAfterCorrectRemove(): ObservedContactRole[] {
  return EXPECTED_REMAINING_CONTACT_IDS.map(row);
}

describe('remove-contact constants — deterministic ground truth', () => {
  it('removes the MIDDLE of the three seeded assignments (QA_SEED_CONTACT_IDS[2])', () => {
    expect(SEEDED_ASSIGNED_CONTACT_IDS).toEqual([
      QA_SEED_CONTACT_IDS[1],
      QA_SEED_CONTACT_IDS[2],
      QA_SEED_CONTACT_IDS[3],
    ]);
    expect(CONTACT_TO_REMOVE).toBe(QA_SEED_CONTACT_IDS[2]);
  });

  it('expects exactly the two non-removed contacts to survive', () => {
    expect([...EXPECTED_REMAINING_CONTACT_IDS].sort()).toEqual(
      [QA_SEED_CONTACT_IDS[1], QA_SEED_CONTACT_IDS[3]].sort(),
    );
    expect(EXPECTED_REMAINING_CONTACT_IDS).not.toContain(CONTACT_TO_REMOVE);
    expect(EXPECTED_REMAINING_CONTACT_IDS).toHaveLength(2);
  });

  it('uses VALID UUIDs for the removed + surviving contacts', () => {
    const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(CONTACT_TO_REMOVE).toMatch(uuidV4);
    for (const id of EXPECTED_REMAINING_CONTACT_IDS) expect(id).toMatch(uuidV4);
  });
});

describe('diffRemoval — PASS classification', () => {
  it('returns zero deviations when the junction is exactly the two survivors (PASS)', () => {
    expect(diffRemoval(EXPECTED_REMAINING_CONTACT_IDS, CONTACT_TO_REMOVE, observedAfterCorrectRemove())).toEqual([]);
  });

  it('is order-independent (junction rows may come back in any order)', () => {
    const reversed = [...observedAfterCorrectRemove()].reverse();
    expect(diffRemoval(EXPECTED_REMAINING_CONTACT_IDS, CONTACT_TO_REMOVE, reversed)).toEqual([]);
  });
});

describe('diffRemoval — FAIL classification', () => {
  it('flags the removed contact still being present (remove op did nothing)', () => {
    const observed = [...observedAfterCorrectRemove(), row(CONTACT_TO_REMOVE)];
    const devs = diffRemoval(EXPECTED_REMAINING_CONTACT_IDS, CONTACT_TO_REMOVE, observed);
    expect(devs).toContainEqual({ contactId: CONTACT_TO_REMOVE, kind: 'not-removed' });
  });

  it('flags a survivor that was wrongly removed (removed the wrong / too many rows)', () => {
    // Only ONE survivor remains — the other was incorrectly deleted along with the target.
    const observed = [row(QA_SEED_CONTACT_IDS[1])];
    const devs = diffRemoval(EXPECTED_REMAINING_CONTACT_IDS, CONTACT_TO_REMOVE, observed);
    expect(devs).toContainEqual({ contactId: QA_SEED_CONTACT_IDS[3], kind: 'wrongly-removed' });
  });

  it('flags an unexpected extra contact in the junction (spurious row)', () => {
    const decoy = '00000000-0000-4000-8000-0000000019ff';
    const observed = [...observedAfterCorrectRemove(), row(decoy)];
    const devs = diffRemoval(EXPECTED_REMAINING_CONTACT_IDS, CONTACT_TO_REMOVE, observed);
    expect(devs).toContainEqual({ contactId: decoy, kind: 'unexpected' });
  });

  it('flags an EMPTY junction (everything wrongly removed) as two wrongly-removed survivors', () => {
    const devs = diffRemoval(EXPECTED_REMAINING_CONTACT_IDS, CONTACT_TO_REMOVE, []);
    expect(devs.filter((d) => d.kind === 'wrongly-removed').map((d) => d.contactId).sort()).toEqual(
      [...EXPECTED_REMAINING_CONTACT_IDS].sort(),
    );
    // The removed id is legitimately absent → no 'not-removed' entry.
    expect(devs.some((d) => d.kind === 'not-removed')).toBe(false);
  });

  it('reports multiple independent deviations at once (not-removed + unexpected)', () => {
    const decoy = '00000000-0000-4000-8000-0000000019ee';
    const observed = [...observedAfterCorrectRemove(), row(CONTACT_TO_REMOVE), row(decoy)];
    const devs = diffRemoval(EXPECTED_REMAINING_CONTACT_IDS, CONTACT_TO_REMOVE, observed);
    expect(devs).toContainEqual({ contactId: CONTACT_TO_REMOVE, kind: 'not-removed' });
    expect(devs).toContainEqual({ contactId: decoy, kind: 'unexpected' });
  });
});
