/**
 * Unit tests for the DELETE-TRANSACTIONS cell core (BACKLOG-1981). Pure Node — no app launch, DB, or
 * keychain; runs under the harness jest config (npm run qa:test).
 *
 * Proves:
 *   1. the duplicated QA_DELETE_* ids stay byte-identical to the seeder (the writer runs in a separate
 *      Electron-main process, so the values are mirrored and cross-checked here — the delete-emails
 *      DELETE_EMAILS_THREAD_MAP / users-roles QA_SEED_CONTACT_IDS precedent);
 *   2. the env-gated seed builder produces the EXACT extra-tx + FK-child shape the cell expects;
 *   3. the pure expectedRemainingTxIds oracle computes the correct set difference (singleton + bulk);
 *   4. the DEFAULT seed path (no env) is byte-identical (the 1950 fidelity guard's premise).
 */
import {
  BASE_FIXTURE_TX_ID,
  QA_DELETE_TX_IDS,
  QA_DELETE_TXC_IDS,
  QA_DELETE_COMM_IDS,
  QA_DELETE_LINKED_EMAIL_IDS,
  QA_DELETE_LINKED_CONTACT_IDS,
  ALL_SEEDED_TX_IDS,
  expectedRemainingTxIds,
  isSubset,
} from '../delete-transactions-core';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const seed = require('../seed-fixture.js') as {
  QA_DELETE_TX_IDS: Record<string, string>;
  QA_DELETE_TXC_IDS: Record<string, string>;
  QA_DELETE_COMM_IDS: Record<string, string>;
  QA_SEED_CONTACT_IDS: Record<string, string>;
  buildDeleteTxFixture: (userId: string) => {
    transactions: Array<{ id: string; user_id: string; property_address: string; status: string }>;
    transactionContacts: Array<{ id: string; transaction_id: string; contact_id: string; role: string }>;
    communications: Array<{ id: string; transaction_id: string; email_id: string; link_source: string }>;
  };
  defaultFixture: () => {
    transaction: { id: string };
    extraTransactions: unknown[];
    transactionContacts: unknown[];
    communications: unknown[];
    emails: unknown[];
    contacts: unknown[];
  };
};

describe('delete-transactions-core id fidelity (BACKLOG-1981)', () => {
  it('the core QA_DELETE_* ids are byte-identical to the seeder ids', () => {
    // If they drift, the expected-set oracle + readers would target ids the DB does not have.
    expect(QA_DELETE_TX_IDS).toEqual(seed.QA_DELETE_TX_IDS);
    expect(QA_DELETE_TXC_IDS).toEqual(seed.QA_DELETE_TXC_IDS);
    expect(QA_DELETE_COMM_IDS).toEqual(seed.QA_DELETE_COMM_IDS);
  });

  it('BASE_FIXTURE_TX_ID matches the seeder default transaction id', () => {
    expect(BASE_FIXTURE_TX_ID).toBe(seed.defaultFixture().transaction.id);
  });

  it('the linked contact ids mirror the reused seeded contacts 1 + 2', () => {
    expect([...QA_DELETE_LINKED_CONTACT_IDS].sort()).toEqual(
      [seed.QA_SEED_CONTACT_IDS[1], seed.QA_SEED_CONTACT_IDS[2]].sort(),
    );
  });

  it('ALL_SEEDED_TX_IDS is exactly the base tx + A/B/C (sorted)', () => {
    expect(ALL_SEEDED_TX_IDS).toEqual(
      [BASE_FIXTURE_TX_ID, QA_DELETE_TX_IDS.A, QA_DELETE_TX_IDS.B, QA_DELETE_TX_IDS.C].sort(),
    );
  });
});

describe('buildDeleteTxFixture shape (BACKLOG-1981)', () => {
  const userId = 'a0000000-0000-4000-8000-00000000e2e0';
  const dt = seed.buildDeleteTxFixture(userId);

  it('seeds exactly 3 extra transactions (A/B/C), all active + owned by the user', () => {
    expect(dt.transactions.map((t) => t.id).sort()).toEqual(
      [QA_DELETE_TX_IDS.A, QA_DELETE_TX_IDS.B, QA_DELETE_TX_IDS.C].sort(),
    );
    for (const t of dt.transactions) {
      expect(t.user_id).toBe(userId);
      expect(t.status).toBe('active');
    }
  });

  it('TX_A has 2 transaction_contacts + 2 communications; TX_B has 1 + 1; TX_C has none', () => {
    const txcByTx = (id: string) => dt.transactionContacts.filter((r) => r.transaction_id === id).map((r) => r.id).sort();
    const commByTx = (id: string) => dt.communications.filter((r) => r.transaction_id === id).map((r) => r.id).sort();
    expect(txcByTx(QA_DELETE_TX_IDS.A)).toEqual([QA_DELETE_TXC_IDS.A1, QA_DELETE_TXC_IDS.A2].sort());
    expect(commByTx(QA_DELETE_TX_IDS.A)).toEqual([QA_DELETE_COMM_IDS.A1, QA_DELETE_COMM_IDS.A2].sort());
    expect(txcByTx(QA_DELETE_TX_IDS.B)).toEqual([QA_DELETE_TXC_IDS.B1]);
    expect(commByTx(QA_DELETE_TX_IDS.B)).toEqual([QA_DELETE_COMM_IDS.B1]);
    expect(txcByTx(QA_DELETE_TX_IDS.C)).toEqual([]);
    expect(commByTx(QA_DELETE_TX_IDS.C)).toEqual([]);
  });

  it('the link rows point at the reused seeded emails (which must survive a tx delete)', () => {
    expect(dt.communications.map((c) => c.email_id).sort()).toEqual([...QA_DELETE_LINKED_EMAIL_IDS].sort());
    // link_source must be a CHECK-allowed value.
    for (const c of dt.communications) expect(['auto', 'manual', 'scan']).toContain(c.link_source);
  });
});

describe('expectedRemainingTxIds oracle (BACKLOG-1981)', () => {
  it('INDIVIDUAL: deleting TX_A leaves base + B + C', () => {
    expect(expectedRemainingTxIds(ALL_SEEDED_TX_IDS, [QA_DELETE_TX_IDS.A])).toEqual(
      [BASE_FIXTURE_TX_ID, QA_DELETE_TX_IDS.B, QA_DELETE_TX_IDS.C].sort(),
    );
  });

  it('BULK: deleting B + C leaves base + TX_A (A is not selected)', () => {
    expect(expectedRemainingTxIds(ALL_SEEDED_TX_IDS, [QA_DELETE_TX_IDS.B, QA_DELETE_TX_IDS.C])).toEqual(
      [BASE_FIXTURE_TX_ID, QA_DELETE_TX_IDS.A].sort(),
    );
  });

  it('is a pure set difference (dedups, sorts, ignores unknown deleted ids)', () => {
    expect(expectedRemainingTxIds(['x', 'y', 'z'], ['y', 'y', 'unknown'])).toEqual(['x', 'z']);
  });
});

describe('isSubset helper (BACKLOG-1981)', () => {
  it('true when every element is present (emails/contacts survived)', () => {
    expect(isSubset(['a', 'b'], ['a', 'b', 'c'])).toBe(true);
  });
  it('false when an element is missing (a survivor was wrongly deleted)', () => {
    expect(isSubset(['a', 'z'], ['a', 'b', 'c'])).toBe(false);
  });
});

describe('DEFAULT seed path byte-identity (BACKLOG-1981 must not break the 1950 fidelity guard)', () => {
  // These are the invariants the fixture-filter-counts fidelity guard depends on. If a future edit to
  // the delete-tx region leaks into the default path, THIS fails fast (pure Node) before a headful run.
  const prev = process.env.KEEPR_QA_DELETE_TX;
  afterAll(() => {
    if (prev === undefined) delete process.env.KEEPR_QA_DELETE_TX;
    else process.env.KEEPR_QA_DELETE_TX = prev;
  });

  it('with KEEPR_QA_DELETE_TX unset, the fixture adds NO extra tx / junction / comm rows', () => {
    delete process.env.KEEPR_QA_DELETE_TX;
    const fx = seed.defaultFixture();
    expect(fx.extraTransactions).toEqual([]);
    expect(fx.communications).toEqual([]);
    expect(fx.transactionContacts).toHaveLength(3); // the base tx's 3 assignments, unchanged
    expect(fx.emails).toHaveLength(9);
    expect(fx.contacts).toHaveLength(3);
  });

  it('with KEEPR_QA_DELETE_TX=1, the extra rows appear (env-gated)', () => {
    process.env.KEEPR_QA_DELETE_TX = '1';
    const fx = seed.defaultFixture();
    expect(fx.extraTransactions).toHaveLength(3);
    expect(fx.communications).toHaveLength(3);
    expect(fx.transactionContacts).toHaveLength(6); // 3 base + 3 delete-tx
  });
});
