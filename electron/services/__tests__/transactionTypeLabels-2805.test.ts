/**
 * @jest-environment node
 *
 * BACKLOG-2805 (support ticket 112) — the exported documents use the same
 * words as the app.
 *
 * Founder ruling, now at its third value: "Purchase" -> "Listing/Purchase"
 * (BACKLOG-2805, shipped v2.29.0) -> **"Listing"** (BACKLOG-2850), exact;
 * **"Sale" unchanged**. The enum values `purchase` / `sale` do not move —
 * they are a DB column and a Zod enum.
 *
 * There are THREE export producers and none of them can read the renderer's
 * map, because `electron/` cannot import from `src/` (rootDir). They share
 * `electron/constants/transactionTypeLabels.ts` instead, and this suite pins
 * the literal strings so that map and its renderer mirror cannot drift apart
 * silently — the renderer suite pins the same two strings independently, so a
 * change to one side alone turns the other side red.
 *
 * One of the three was ALREADY WRONG before this ticket: the text export
 * printed the raw lowercase enum ("Transaction Type: purchase"). Fixing it is
 * in scope for the export path.
 */

import { TRANSACTION_TYPE_LABELS, getTransactionTypeLabel } from "../../constants/transactionTypeLabels";

describe("BACKLOG-2805 — electron-side transaction type labels", () => {
  it("maps the enum values to the founder-approved strings", () => {
    // The exact strings, asserted as literals. This is the anchor the
    // renderer mirror is checked against.
    expect(TRANSACTION_TYPE_LABELS.purchase).toBe("Listing");
    expect(TRANSACTION_TYPE_LABELS.sale).toBe("Sale");
  });

  it("returns N/A for a type it does not know", () => {
    // `other` is a real value in the Zod enum and the text export has always
    // had to render SOMETHING for it. Boundary, not a sample: empty string,
    // undefined and an unmapped-but-valid enum member all take this path.
    expect(getTransactionTypeLabel("other")).toBe("N/A");
    expect(getTransactionTypeLabel(undefined)).toBe("N/A");
    expect(getTransactionTypeLabel("")).toBe("N/A");
  });

  it("does not lowercase, uppercase or otherwise reshape a known label", () => {
    // Capitalisation is load-bearing: the enum value is lowercase
    // `purchase` and the label is title-case, so a helper that lowercases on
    // the way into HTML would print the raw value back.
    expect(getTransactionTypeLabel("purchase")).toBe("Listing");
    expect(getTransactionTypeLabel("sale")).toBe("Sale");
  });
});
