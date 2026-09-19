/**
 * BACKLOG-2560 (validator half, executed under BACKLOG-2755) — every field the
 * transaction validator forwards is a real `transactions` column.
 *
 * WHAT THIS FILE DOES AND DOES NOT COVER
 * ======================================
 * The primary guarantee is a TYPE one and is therefore invisible to jest:
 * `RawTransactionData` is keyed off `Extract<TransactionColumn, …>`, so reading
 * `data.amount` in `validation.ts` is a compile error. A green run of this file
 * is not evidence for that. The `tsc` controls are recorded in the PR body;
 * `npm run type-check` is their gate.
 *
 * What this file adds is the RUNTIME half the type cannot see: that the object
 * actually handed to the writer contains no key the `transactions` table lacks.
 * A phantom could still be forwarded by a cast, or by a future edit that widens
 * the return type; this fails if one ever is.
 *
 * It also records the behaviour deliberately traded away. Two tests in
 * `validation.test.ts` asserted that a malformed `amount` and an over-long
 * `notes` still threw, pinning a BACKLOG-2558 decision to keep validating two
 * keys belonging to no table. Both are replaced by the type guarantee, and the
 * cases below state what a caller now sees instead — so the change is a
 * recorded trade rather than a silent loss.
 */
import { validateTransactionData } from "../validation";
import { TABLE_FIELDS } from "../sqlFieldWhitelist";

describe("validateTransactionData — field set (BACKLOG-2560)", () => {
  const REAL_COLUMNS = new Set<string>(TABLE_FIELDS.transactions);

  /**
   * A payload touching every branch of the validator at once, so the forwarded
   * key set is measured rather than sampled one field at a time.
   */
  const FULL_PAYLOAD = {
    property_address: "123 Example Street",
    property_street: "123 Example Street",
    property_city: "Springfield",
    property_state: "WA",
    property_zip: "98001",
    property_coordinates: '{"lat":47.6,"lng":-122.3}',
    transaction_type: "purchase",
    status: "active",
    sale_price: 500000,
    listing_price: 525000,
    closing_date_verified: 1,
    started_at: "2026-01-02",
    closed_at: "2026-03-04",
    closing_deadline: "2026-03-01",
    detection_status: "confirmed",
    reviewed_at: "2026-02-02",
    rejection_reason: "Not a real estate transaction",
    suggested_contacts: "[]",
  };

  it("forwards no key the transactions table does not have", () => {
    const validated = validateTransactionData(FULL_PAYLOAD, true);

    const forwarded = Object.keys(validated);
    // ANTI-VACUITY: a validator that forwarded nothing would trivially satisfy
    // the assertion below.
    expect(forwarded.length).toBeGreaterThan(15);

    const phantoms = forwarded
      .filter((key) => key !== "contact_assignments")
      .filter((key) => !REAL_COLUMNS.has(key))
      .sort();
    expect(phantoms).toEqual([]);
  });

  it("forwards every field of a full payload, so a silent drop is visible", () => {
    const validated = validateTransactionData(FULL_PAYLOAD, true);

    expect(Object.keys(validated).sort()).toEqual(
      Object.keys(FULL_PAYLOAD).sort(),
    );
  });

  it("no longer rejects `amount`, the traded-away behaviour, and never forwards it", () => {
    // BACKLOG-2558 kept a check here so `amount: -5` threw. `amount` is a
    // column of no table; the key is now unreadable in `validation.ts` rather
    // than merely unforwarded, which is the stronger guarantee. Recorded so the
    // trade is visible to the next reader instead of being inferred from a
    // deleted test.
    const validated = validateTransactionData(
      { ...FULL_PAYLOAD, amount: -5 },
      true,
    );

    expect("amount" in validated).toBe(false);
  });

  it("no longer rejects an over-long `notes`, and never forwards it", () => {
    const validated = validateTransactionData(
      { ...FULL_PAYLOAD, notes: "x".repeat(10001) },
      true,
    );

    expect("notes" in validated).toBe(false);
  });
});
