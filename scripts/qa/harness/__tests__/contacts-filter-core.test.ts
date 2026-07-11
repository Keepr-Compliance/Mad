/**
 * Unit test for the CONTACTS CATEGORY-FILTER cell core (BACKLOG-1977).
 *
 * Pure Node — no app launch, DB, or keychain. Proves the deterministic parts of the cell:
 *   1. The core's EXPECTED_FILTER_CONTACTS corpus is byte-identical to what seed-fixture.js writes
 *      (QA_FILTER_CONTACTS) — the seeder is the writer, the core is the reader/oracle, so a drift
 *      between the two would make the cell assert against the wrong ground truth. This is the same
 *      cross-process single-source-of-truth guard the users-roles cell uses for QA_SEED_CONTACT_IDS.
 *   2. The ORACLE (expectedVisibleCount, which runs the REAL matchesContactFilters predicate) yields
 *      the intended per-source-leaf and per-role-leaf counts over the seeded corpus. If a future edit to
 *      the filter model, the seeder corpus, or the leaf→value maps drifts the counts, THIS fails first
 *      (fast, pure Node) instead of a headful Playwright run.
 *
 * NOTE: the 3 always-seeded default contacts (Alice/Bob/Carol) carry source='email' (matches no source
 * leaf) + default_role=NULL. They are part of the imported set the reader returns at runtime, but they
 * never contribute to a category count, so the per-leaf oracle math below uses ONLY the filter corpus.
 * The spec adds them to the observed rows at runtime and the oracle handles them uniformly.
 */
import {
  EXPECTED_FILTER_CONTACTS,
  type ObservedContactRow,
} from '../contacts-filter-core';
import { expectedVisibleCount } from '../../../../e2e/driver/contactsFilterOracle';
import {
  SOURCE_LEAF,
  ROLE_LEAF,
  ALL_SOURCE_LEAF_IDS,
  ALL_ROLE_LEAF_IDS,
} from '../../../../src/utils/contactFilterModel';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const seed = require('../seed-fixture.js') as {
  QA_FILTER_CONTACTS: Array<{ id: string; source: string; default_role: string | null }>;
  QA_FILTER_CONTACT_IDS: Record<string, string>;
};

/** Observed-row view of the seeded filter corpus (is_message_derived aliased 0, like the reader). */
const corpusRows: ObservedContactRow[] = EXPECTED_FILTER_CONTACTS.map((c) => ({
  id: c.id,
  source: c.source,
  default_role: c.default_role,
  is_message_derived: 0,
}));

const allSources = new Set<string>(ALL_SOURCE_LEAF_IDS as readonly string[]);
const allRoles = new Set<string>(ALL_ROLE_LEAF_IDS as readonly string[]);

describe('contacts-filter-core (BACKLOG-1977)', () => {
  it('EXPECTED_FILTER_CONTACTS is byte-identical to the seeder QA_FILTER_CONTACTS (single source of truth)', () => {
    const fromSeed = seed.QA_FILTER_CONTACTS.map((c) => ({
      id: c.id,
      source: c.source,
      default_role: c.default_role ?? null,
    }));
    const fromCore = EXPECTED_FILTER_CONTACTS.map((c) => ({
      id: c.id,
      source: c.source,
      default_role: c.default_role,
    }));
    expect(fromCore).toEqual(fromSeed);
    // Ids are FIXED, valid, distinct UUIDs.
    const ids = fromCore.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    }
  });

  it('corpus size is 8 (the KNOWN source×role mix)', () => {
    expect(EXPECTED_FILTER_CONTACTS.length).toBe(8);
  });

  describe('SOURCE isolation (all roles selected) — per-provider seeded counts', () => {
    const cases: Array<[string, string, number]> = [
      ['Manual', SOURCE_LEAF.MANUAL, 2],
      ['Contacts App', SOURCE_LEAF.CONTACTS_APP, 1],
      ['Outlook', SOURCE_LEAF.EMAIL_OUTLOOK, 2],
      ['Gmail', SOURCE_LEAF.EMAIL_GMAIL, 1],
      ['iPhone', SOURCE_LEAF.PHONE_IPHONE, 2],
      ['Android', SOURCE_LEAF.PHONE_ANDROID, 0],
    ];
    it.each(cases)('source=%s only → %s contacts', (_label, leaf, expected) => {
      expect(expectedVisibleCount(corpusRows, new Set([leaf]), allRoles)).toBe(expected);
    });
  });

  describe('ROLE isolation (all sources selected) — per-role seeded counts', () => {
    const cases: Array<[string, string, number]> = [
      ['Buyers (buyer/client)', ROLE_LEAF.BUYERS, 2],
      ['Sellers (seller)', ROLE_LEAF.SELLERS, 2],
      ['Agents (seller_agent)', ROLE_LEAF.AGENTS, 2],
      ['Unassigned (NULL)', ROLE_LEAF.UNASSIGNED, 2],
    ];
    it.each(cases)('role=%s only → %s contacts', (_label, leaf, expected) => {
      expect(expectedVisibleCount(corpusRows, allSources, new Set([leaf]))).toBe(expected);
    });
  });

  it('empty selection on either dimension → 0 (AND predicate, honest empty)', () => {
    expect(expectedVisibleCount(corpusRows, new Set(), allRoles)).toBe(0);
    expect(expectedVisibleCount(corpusRows, allSources, new Set())).toBe(0);
  });

  it('AND semantics: source=Manual ∧ role=Sellers → only the manual seller (1)', () => {
    expect(
      expectedVisibleCount(corpusRows, new Set([SOURCE_LEAF.MANUAL]), new Set([ROLE_LEAF.SELLERS])),
    ).toBe(1);
  });

  it('the 3 default email-source contacts never contribute (source=email matches no leaf)', () => {
    const withDefaults: ObservedContactRow[] = [
      ...corpusRows,
      { id: 'a1', source: 'email', default_role: null, is_message_derived: 0 },
      { id: 'a2', source: 'email', default_role: null, is_message_derived: 0 },
      { id: 'a3', source: 'email', default_role: null, is_message_derived: 0 },
    ];
    // All sources + all roles: still only the 8 corpus rows match (email matches no source leaf).
    expect(expectedVisibleCount(withDefaults, allSources, allRoles)).toBe(EXPECTED_FILTER_CONTACTS.length);
  });
});
