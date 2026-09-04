/**
 * BACKLOG-3044 PR 2 — the two fragments that MOVED, pinned to their exact base text.
 *
 * ## Why this file exists
 *
 * `scripts/ci/sql-move-identity.mjs` compares a statement's SKELETON: it renders each
 * interpolation as a fixed marker, so it proves the text AROUND a fragment is unchanged
 * and the fragment's positions are unchanged. Its own header says plainly that it does
 * NOT prove the fragment itself is unchanged, and adds: *"A fragment that moves must be
 * controlled on its own text, by its own row here."*
 *
 * In PR 1 that limit cost nothing — the only fragment spliced there
 * (`reactionExclusion`) already lived inside `db/` and did not move. **PR 2 moves two
 * fragments**, so the limit became live, and this suite is the control that closes it.
 *
 * Without it, both fragments could have been rewritten during the move — a changed
 * join, a dropped `removed_at`, a renamed bind parameter — and every other control in
 * the PR would still have been green.
 *
 * ## The expected strings are GENERATED, not transcribed
 *
 * They were extracted from the pre-move tree by AST (`.tmp3044b/fragments.mjs`) and
 * written into this file by script. The same extraction produced the text placed in the
 * `db/` modules. Typing them by hand twice would let one typo enter both sides and
 * cancel itself out, which is a green test proving nothing.
 *
 * ## The `onTransaction` collapse this pins
 *
 * The base declared that predicate TWICE, in two different functions, and the move
 * collapsed the pair into one producer. The two declarations were verified
 * byte-identical by execution first; these assertions are what keep the collapse honest
 * afterwards, since a skeleton comparison cannot see inside either copy.
 */
import {
  COUNT_REVIEW_QUEUE_SQL,
  REVIEW_QUEUE_SQL,
} from "../contactLinkReviewSql";
import {
  CONTACTS_SHARE_TRANSACTION_SQL,
  SHARED_TRANSACTION_ADDRESSES_SQL,
} from "../contactLinkEvidenceSql";

/** `PENDING_JOIN` exactly as `contactLinkReview.ts` declared it before the move. */
const PENDING_JOIN = "\n    FROM contact_link_proposals p\n    JOIN contacts c\n      ON c.id = p.contact_id AND c.removed_at IS NULL\n    JOIN external_contacts ec\n      ON ec.user_id = p.user_id\n     AND ec.source = p.source_type\n     AND ec.external_record_id = p.source_record_id\n   WHERE p.user_id = ? AND p.status = 'pending'\n";

/** `onTransaction.replace(/@c/g, "@a")` — the base's own output, not a re-derivation. */
const ON_TRANSACTION_A = "(\n      t.buyer_agent_id = @a\n      OR t.seller_agent_id = @a\n      OR t.escrow_officer_id = @a\n      OR t.inspector_id = @a\n      OR EXISTS (\n        SELECT 1 FROM transaction_contacts tc\n         WHERE tc.transaction_id = t.id AND tc.contact_id = @a\n      )\n      OR (\n        t.other_contacts IS NOT NULL\n        AND EXISTS (\n          SELECT 1 FROM json_each(t.other_contacts) j WHERE j.value = @a\n        )\n      )\n    )";

/** `onTransaction.replace(/@c/g, "@b")`. */
const ON_TRANSACTION_B = "(\n      t.buyer_agent_id = @b\n      OR t.seller_agent_id = @b\n      OR t.escrow_officer_id = @b\n      OR t.inspector_id = @b\n      OR EXISTS (\n        SELECT 1 FROM transaction_contacts tc\n         WHERE tc.transaction_id = t.id AND tc.contact_id = @b\n      )\n      OR (\n        t.other_contacts IS NOT NULL\n        AND EXISTS (\n          SELECT 1 FROM json_each(t.other_contacts) j WHERE j.value = @b\n        )\n      )\n    )";

describe("BACKLOG-3044 PR 2 — moved fragments keep their exact text", () => {
  describe("PENDING_JOIN", () => {
    // Pinned THROUGH the statement rather than through a test-only export. The
    // fragment is module-private in contactLinkReviewSql.ts and should stay that way;
    // widening a module's surface so a test can see a private is a cost the test does
    // not need to impose.
    it("is spliced verbatim into the queue COUNT", () => {
      expect(COUNT_REVIEW_QUEUE_SQL).toBe(`SELECT COUNT(*) AS n ${PENDING_JOIN}`);
    });

    it("is spliced verbatim into the queue CONTENTS", () => {
      expect(REVIEW_QUEUE_SQL).toContain(PENDING_JOIN);
    });

    it("gives the count and the contents the SAME predicate", () => {
      // The reason the fragment is shared at all: "Review 12 possible duplicates"
      // opening onto 9 is the failure this prevents. Asserting both statements carry
      // the identical join is what makes that structural rather than remembered.
      expect(COUNT_REVIEW_QUEUE_SQL).toContain(PENDING_JOIN);
      expect(REVIEW_QUEUE_SQL).toContain(PENDING_JOIN);
    });

    it("still filters to pending proposals whose contact is not tombstoned", () => {
      // Named separately from the byte pin so a future INTENTIONAL edit to the
      // fragment cannot quietly drop either clause: the byte pin would be updated in
      // that edit, and these two would have to be updated deliberately too.
      expect(PENDING_JOIN).toContain("p.status = 'pending'");
      expect(PENDING_JOIN).toContain("c.removed_at IS NULL");
    });
  });

  describe("onTransaction", () => {
    it("binds @a and @b verbatim in the shared-transaction existence check", () => {
      expect(CONTACTS_SHARE_TRANSACTION_SQL).toBe(
        `SELECT 1 AS hit FROM transactions t
      WHERE ${ON_TRANSACTION_A}
        AND ${ON_TRANSACTION_B}
      LIMIT 1`,
      );
    });

    it("binds @a and @b verbatim in the shared-address read", () => {
      expect(SHARED_TRANSACTION_ADDRESSES_SQL).toBe(
        `SELECT t.property_address FROM transactions t
      WHERE ${ON_TRANSACTION_A}
        AND ${ON_TRANSACTION_B}
      ORDER BY t.property_address
      LIMIT 3`,
      );
    });

    it("keeps all six ways a contact can be on a transaction", () => {
      // The predicate is an ANTI-merge signal: dropping a branch makes it report
      // "these two never appear together" and makes a WRONG MERGE more likely. A byte
      // pin catches that, but only this says why six.
      for (const branch of [
        "t.buyer_agent_id",
        "t.seller_agent_id",
        "t.escrow_officer_id",
        "t.inspector_id",
        "FROM transaction_contacts tc",
        "json_each(t.other_contacts)",
      ]) {
        expect(ON_TRANSACTION_A).toContain(branch);
      }
    });

    it("carries NO contact id in its text — the ids are bound", () => {
      // The whole reason this fragment converted while BACKLOG-3103's four refused:
      // @a and @b are named BIND PARAMETERS, not values pasted into SQL.
      expect(ON_TRANSACTION_A).toContain("@a");
      expect(ON_TRANSACTION_A).not.toMatch(/'[^']*'/);
      expect(ON_TRANSACTION_B).toContain("@b");
      expect(ON_TRANSACTION_B).not.toMatch(/'[^']*'/);
    });

    it("differs from its sibling ONLY in the bound parameter name", () => {
      // Proves the collapse to one producer is faithful: the two copies are the same
      // sentence with one substitution, which is what made a single producer correct.
      expect(ON_TRANSACTION_A.replace(/@a/g, "@X")).toBe(ON_TRANSACTION_B.replace(/@b/g, "@X"));
    });
  });
});
