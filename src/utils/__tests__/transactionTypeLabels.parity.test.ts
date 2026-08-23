/**
 * @jest-environment node
 *
 * BACKLOG-2805 — the two copies of the transaction-type labels must agree.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE ARE TWO COPIES AT ALL
 * ---------------------------------------------------------------------------
 * `tsconfig.electron.json` sets `rootDir: "./electron"`, so nothing under
 * `electron/` may import from `src/`. The three export producers print this
 * field into documents the user files, so they need the labels too — hence a
 * mirror, exactly as BACKLOG-2461 needed one for the contact display label.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS, AND WHAT IT REPLACES
 * ---------------------------------------------------------------------------
 * PR #2352 originally claimed the drift guard was already in place: "each
 * side's suite pins the same literals, so changing one alone turns the other
 * red." **That claim was false, and SR review measured it false.** No suite
 * loaded both maps, so the realistic drift path — edit one literal and the
 * suite that pins it, both on the same side — left the opposite side fully
 * green and shipped two vocabularies for one field.
 *
 * A test file is not bundled, so this is the one place both copies can be
 * loaded at once and compared. That is the whole point of the pattern.
 */

import { TRANSACTION_TYPE_LABELS as ELECTRON_LABELS } from "../../../electron/constants/transactionTypeLabels";
import { getTransactionTypeLabel as electronLabelFor } from "../../../electron/constants/transactionTypeLabels";
import { TRANSACTION_TYPE_LABELS as RENDERER_LABELS } from "../../constants/transactionTypes";

/**
 * The expected strings are asserted too, not just parity.
 *
 * Two copies that are identically WRONG would agree perfectly, so agreement on
 * its own proves nothing. These are the founder's exact ruled strings for
 * BACKLOG-2805 — including the slash, which is the whole point of the ticket
 * and the character most at risk from a slugify or escape helper.
 */
const EXPECTED: Record<"purchase" | "sale", string> = {
  purchase: "Listing/Purchase",
  sale: "Sale",
};

describe("transaction type labels — electron/renderer parity", () => {
  it("both copies cover exactly the same enum values", () => {
    // Identity, not count: a copy that gained `other` while the other did not
    // is drift, and `toHaveLength(2)` would not see it.
    expect(Object.keys(RENDERER_LABELS).sort()).toEqual(["purchase", "sale"]);
    expect(Object.keys(ELECTRON_LABELS).sort()).toEqual(
      Object.keys(RENDERER_LABELS).sort(),
    );
  });

  it.each(Object.keys(EXPECTED) as Array<"purchase" | "sale">)(
    "both copies label %s identically, and correctly",
    (key) => {
      expect(RENDERER_LABELS[key]).toBe(EXPECTED[key]);
      expect(ELECTRON_LABELS[key]).toBe(EXPECTED[key]);
      expect(ELECTRON_LABELS[key]).toBe(RENDERER_LABELS[key]);
    },
  );

  it("the electron helper agrees with the renderer map for every mapped value", () => {
    // The helper is what the .txt export actually calls, so parity on the map
    // alone would not cover the path that prints into the document.
    for (const key of Object.keys(RENDERER_LABELS) as Array<"purchase" | "sale">) {
      expect(electronLabelFor(key)).toBe(RENDERER_LABELS[key]);
    }
  });

  it("neither copy leaks a label into the other's fallback", () => {
    // `other` is unmapped on BOTH sides on purpose (each surface keeps its own
    // fall-through). If one copy ever gains it, the maps disagree and the row
    // above catches it — this states the current contract explicitly.
    expect(RENDERER_LABELS).not.toHaveProperty("other");
    expect(ELECTRON_LABELS).not.toHaveProperty("other");
    expect(electronLabelFor("other")).toBe("N/A");
  });
});
