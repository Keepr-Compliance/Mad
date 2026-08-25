/**
 * @jest-environment node
 *
 * BACKLOG-2859 — the role vocabulary is MIRRORED, not shared. This pins the two
 * halves against each other.
 *
 * WHY A MIRROR EXISTS AT ALL. `electron/` cannot import from `src/` (rootDir),
 * so the renderer's `getRoleDisplayName` is out of reach of the export
 * producers. `humanizeExportRole` in summaryHelpers is the second and only other
 * place the role enum becomes words.
 *
 * WHY THAT NEEDS A TEST. Drift here does not throw and does not fail tsc. It
 * ships: the chip on screen and the compliance summary the user files name the
 * SAME person on the SAME deal two different things. That is the exact defect
 * BACKLOG-2850 had to fix for the transaction-type label, reached through the
 * role label instead.
 *
 * The retired values are pinned too, because an export can run against rows an
 * older install wrote and a filed document is the worst place to print a raw
 * enum or the "Seller Agent" wording BACKLOG-2804 ruled against.
 */

import { humanizeExportRole } from "../summaryHelpers";
import { getRoleDisplayName } from "../../../../src/utils/transactionRoleUtils";
import type { TransactionType } from "../../../../src/utils/transactionRoleUtils";

const TYPES: TransactionType[] = ["purchase", "sale", "other"];

/** Every value the app can store today. */
const LIVE_ROLES = [
  "client",
  "agent",
  "co_agent",
  "appraiser",
  "inspector",
  "surveyor",
  "title_company",
  "escrow_officer",
  "mortgage_broker",
  "lender",
  "real_estate_attorney",
  "transaction_coordinator",
  "insurance_agent",
  "hoa_management",
  "condo_management",
  "other",
];

/** Values no longer offered, but still reachable from an un-migrated row. */
const RETIRED_ROLES = ["buyer_agent", "seller_agent", "listing_agent", "buyer", "seller"];

/**
 * A KNOWN, PRE-EXISTING DIVERGENCE — found by this test on its first run, and
 * deliberately NOT fixed here (BACKLOG-2859).
 *
 *   mortgage_broker         renderer "Lender (Mortgage Broker)"
 *                           export   "Mortgage Broker"
 *   transaction_coordinator renderer "Transaction Coordinator (TC)"
 *                           export   "Transaction Coordinator"
 *   hoa_management          renderer "HOA Management"
 *                           export   "Hoa Management"
 *
 * THE SET IS EXACTLY THREE, swept over the whole vocabulary rather than sampled
 * — the first two were found one at a time and the third only turned up when the
 * sweep was run properly. All three are the same defect: the export humanizes
 * generically, so it cannot produce a parenthetical gloss ("(TC)") or preserve
 * an acronym's casing ("HOA"), and none of them ever had an override.
 *
 * It predates this item — verified against
 * `origin/feat/BACKLOG-2849-submit-screen`, where `summaryHelpers` has no
 * `mortgage_broker` override at all and falls through to the title-caser, while
 * the renderer map has carried the parenthetical for far longer. Nothing in the
 * role collapse touches it.
 *
 * It is listed rather than fixed because aligning them changes a string printed
 * into a COMPLIANCE DOCUMENT the user files, and which of the two is correct is
 * a founder call, not an engineering one. Authoring that ruling here would be
 * inventing a decision nobody made. Reported on the item instead.
 *
 * Listing it keeps this test honest: parity is still asserted for every other
 * role, so NEW drift fails, while this one documented exception cannot silently
 * widen — adding a second entry requires editing this list.
 */
const KNOWN_DIVERGENCES = new Set([
  "mortgage_broker",
  "transaction_coordinator",
  "hoa_management",
]);

describe("BACKLOG-2859: the export humanizer mirrors the renderer's labels", () => {
  it.each(TYPES)("agrees on EVERY live role for a %s transaction", (type) => {
    // A single loop over the whole vocabulary rather than a hand-picked sample.
    // A hand-picked corpus is how the parity test in BACKLOG-2439 drifted and
    // stayed green: it had no input at the boundary that mattered.
    for (const role of LIVE_ROLES) {
      if (KNOWN_DIVERGENCES.has(role)) continue;
      expect(humanizeExportRole(role, type)).toBe(getRoleDisplayName(role, type));
    }
  });

  it.each(TYPES)("agrees on every RETIRED role for a %s transaction", (type) => {
    for (const role of RETIRED_ROLES) {
      expect(humanizeExportRole(role, type)).toBe(getRoleDisplayName(role, type));
    }
  });
});

describe("BACKLOG-2859: the export resolves `agent` from the transaction type", () => {
  /**
   * Both directions, with the WRONG label asserted absent. A presence-only check
   * passes in a world where the resolver returns the same string for both types.
   */
  it("reads \"Buyer's Agent\" on a Listing", () => {
    expect(humanizeExportRole("agent", "purchase")).toBe("Buyer's Agent");
    expect(humanizeExportRole("agent", "purchase")).not.toBe("Listing Agent");
  });

  it('reads "Listing Agent" on a Sale — the 2804 ruling, preserved', () => {
    expect(humanizeExportRole("agent", "sale")).toBe("Listing Agent");
    expect(humanizeExportRole("agent", "sale")).not.toBe("Buyer's Agent");
    expect(humanizeExportRole("agent", "sale")).not.toBe("Seller Agent");
  });

  it("names no side when the type does", () => {
    // `other`, and an export running without a type at all.
    expect(humanizeExportRole("agent", "other")).toBe("Agent");
    expect(humanizeExportRole("agent", undefined)).toBe("Agent");
    expect(humanizeExportRole("agent", null)).toBe("Agent");
  });

  it("resolves `client` both ways", () => {
    expect(humanizeExportRole("client", "purchase")).toBe("Seller (Client)");
    expect(humanizeExportRole("client", "purchase")).not.toBe("Buyer (Client)");
    expect(humanizeExportRole("client", "sale")).toBe("Buyer (Client)");
    expect(humanizeExportRole("client", "sale")).not.toBe("Seller (Client)");
  });

  it("renders co_agent IDENTICALLY on both types — it is not dynamic", () => {
    const onListing = humanizeExportRole("co_agent", "purchase");
    const onSale = humanizeExportRole("co_agent", "sale");
    expect(onListing).toBe(onSale);
    expect(onListing).toBe("Co-Agent");
  });

  it("never prints a raw enum for anything it can be handed", () => {
    for (const type of TYPES) {
      for (const role of [...LIVE_ROLES, ...RETIRED_ROLES]) {
        const label = humanizeExportRole(role, type);
        expect(label).not.toMatch(/_/);
        expect(label).not.toBe(role);
      }
    }
  });
});

describe("BACKLOG-2859: the known divergence is pinned, so it cannot widen", () => {
  it("still diverges exactly as recorded — and is the ONLY role that does", () => {
    // If someone aligns these two (a fine thing to do, once the founder rules),
    // this test fails and points at the list to update. That is the intent: the
    // exception is a recorded decision, not a silent hole.
    expect(humanizeExportRole("mortgage_broker", "sale")).toBe("Mortgage Broker");
    expect(getRoleDisplayName("mortgage_broker", "sale")).toBe("Lender (Mortgage Broker)");
    expect(humanizeExportRole("transaction_coordinator", "sale")).toBe("Transaction Coordinator");
    expect(getRoleDisplayName("transaction_coordinator", "sale")).toBe(
      "Transaction Coordinator (TC)",
    );
    expect(humanizeExportRole("hoa_management", "sale")).toBe("Hoa Management");
    expect(getRoleDisplayName("hoa_management", "sale")).toBe("HOA Management");

    // The EXACT diverging set, swept over the whole vocabulary rather than
    // sampled. Both entries are the same shape: the renderer carries a
    // parenthetical gloss the export's generic title-caser cannot produce.
    const diverging = LIVE_ROLES.filter(
      (r) => humanizeExportRole(r, "sale") !== getRoleDisplayName(r, "sale"),
    ).sort();
    expect(diverging).toEqual([
      "hoa_management",
      "mortgage_broker",
      "transaction_coordinator",
    ]);
  });
});
