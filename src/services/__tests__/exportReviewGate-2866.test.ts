/**
 * BACKLOG-2866 — the export review gate itself, and the guard that it stayed a
 * GATE and never became a filter.
 *
 * Founder ruling, 2026-08-25: unreviewed emails must never reach an exported
 * audit package, and the mechanism is the one that already stops a Complete —
 * "no reason to filter it".
 *
 * The distinction this file pins is the whole design: a FILTER would quietly
 * drop emails from a package and hand a broker an artifact missing things it
 * does not know is missing. A GATE refuses, and names the deal.
 */
import type { ReviewStateResult } from "../../../electron/types/ipc/window-api-transactions";
import {
  UNREADABLE_REVIEW_COUNT,
  describeBlockedExport,
  evaluateExportGate,
  reviewBlockedBody,
  reviewBlockedTitle,
  type ReviewStateReader,
} from "../exportReviewGate";

// The gate reads `count` and nothing else — the ITEM shape is exercised by
// reviewStateService's own suites, not here. Kept as ReviewStateResult so a
// change to the contract still breaks this file.
const emptyQueue: ReviewStateResult = { items: [], count: 0 };
const queueOf = (n: number): ReviewStateResult => ({
  items: Array.from({ length: n }, (_, i) => ({
    id: `pending:${i}`,
  })) as unknown as ReviewStateResult["items"],
  count: n,
});

/** A reader driven by an id→count map. Anything absent reads as empty. */
function readerFor(counts: Record<string, number>): ReviewStateReader {
  return jest.fn(async (id: string) =>
    counts[id] === undefined ? emptyQueue : queueOf(counts[id]),
  );
}

describe("evaluateExportGate — both directions", () => {
  it("ALLOWS when every target's queue is verified empty", async () => {
    const decision = await evaluateExportGate(
      [{ transactionId: "tx-a" }, { transactionId: "tx-b" }],
      readerFor({ "tx-a": 0, "tx-b": 0 }),
    );
    expect(decision.allowed).toBe(true);
  });

  it("BLOCKS on a non-empty queue and carries the count it actually read", async () => {
    const decision = await evaluateExportGate(
      [{ transactionId: "tx-a", label: "123 Main St" }],
      readerFor({ "tx-a": 3 }),
    );
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unreachable");
    expect(decision.blocked).toEqual([
      { transactionId: "tx-a", label: "123 Main St", count: 3 },
    ]);
  });

  it("BLOCKS when the queue cannot be READ — unreadable is not empty", async () => {
    // The failure this gate exists to prevent is exporting on an UNVERIFIED
    // queue. A throw means "cannot confirm it is empty", which is not the same
    // as "it is empty", so it must block and must not claim a count.
    const decision = await evaluateExportGate(
      [{ transactionId: "tx-a" }],
      jest.fn().mockRejectedValue(new Error("IPC down")),
    );
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unreachable");
    expect(decision.blocked[0].count).toBe(UNREADABLE_REVIEW_COUNT);
  });

  it("reads AT CALL TIME, not from anything captured earlier", async () => {
    // Same gate, called twice, queue fills in between. A gate that trusted a
    // captured value would allow the second call.
    const read: ReviewStateReader = jest
      .fn()
      .mockResolvedValueOnce(emptyQueue)
      .mockResolvedValueOnce(queueOf(1));

    const first = await evaluateExportGate([{ transactionId: "tx-a" }], read);
    const second = await evaluateExportGate([{ transactionId: "tx-a" }], read);

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("is ALL-OR-NOTHING: one blocked deal blocks the set, by id SET", async () => {
    const decision = await evaluateExportGate(
      [
        { transactionId: "tx-clean-1" },
        { transactionId: "tx-blocked", label: "45 Oak Ave" },
        { transactionId: "tx-clean-2" },
      ],
      readerFor({ "tx-clean-1": 0, "tx-blocked": 2, "tx-clean-2": 0 }),
    );

    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unreachable");
    // EXACT id set — the clean deals are not "allowed through", because under
    // all-or-nothing there is no through.
    expect(new Set(decision.blocked.map((b) => b.transactionId))).toEqual(
      new Set(["tx-blocked"]),
    );
  });

  it("reports EVERY blocked deal, not just the first", async () => {
    const decision = await evaluateExportGate(
      [
        { transactionId: "tx-a", label: "123 Main St" },
        { transactionId: "tx-b", label: "45 Oak Ave" },
        { transactionId: "tx-c", label: "9 Elm Rd" },
      ],
      readerFor({ "tx-a": 3, "tx-b": 0, "tx-c": 1 }),
    );
    if (decision.allowed) throw new Error("unreachable");
    expect(new Set(decision.blocked.map((b) => b.transactionId))).toEqual(
      new Set(["tx-a", "tx-c"]),
    );
  });

  it("an empty target list allows — there is nothing to refuse", async () => {
    const read = jest.fn();
    const decision = await evaluateExportGate([], read as ReviewStateReader);
    expect(decision.allowed).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });
});

describe("copy — ONE wording for one condition", () => {
  it("says the ONE sentence the founder ruled on (BACKLOG-2881)", () => {
    // BACKLOG-2866 moved this copy here byte-identical; BACKLOG-2881 then
    // changed the wording on the founder's ruling — the sentence no longer
    // names the action, so it cannot name the wrong one on a route that
    // completes nothing. Full rationale in the gate module.
    //
    // If either string drifts from here, the details dialog and the bulk
    // refusal start telling the user two different things about one queue.
    // The "no action word" rule itself is asserted in
    // `exportReviewGateCopy-2881.test.tsx`.
    expect(reviewBlockedTitle(3)).toBe("Review needed");
    expect(reviewBlockedBody(3)).toBe(
      "You have 3 communications that need to be reviewed first.",
    );
    expect(reviewBlockedBody(1)).toBe(
      "You have 1 communication that needs to be reviewed first.",
    );
    expect(reviewBlockedTitle(UNREADABLE_REVIEW_COUNT)).toBe(
      "Couldn't check Needs Review",
    );
    expect(reviewBlockedBody(UNREADABLE_REVIEW_COUNT)).toBe(
      "The review queue can't be read right now, so this can't go ahead. Open Needs Review to try again.",
    );
  });

  it("bulk refusal NAMES every blocked deal with its count", () => {
    const message = describeBlockedExport([
      { transactionId: "tx-a", label: "123 Main St", count: 3 },
      { transactionId: "tx-c", label: "9 Elm Rd", count: 1 },
    ]);
    // Same sentence as the dialog, then the names.
    expect(message).toContain(reviewBlockedBody(4));
    expect(message).toContain("123 Main St (3)");
    expect(message).toContain("9 Elm Rd (1)");
  });

  it("falls back to the id when a deal has no label — never an unnamed refusal", () => {
    const message = describeBlockedExport([{ transactionId: "tx-a", count: 2 }]);
    expect(message).toContain("tx-a (2)");
  });

  it("an all-unreadable batch says so instead of claiming a count", () => {
    const message = describeBlockedExport([
      { transactionId: "tx-a", label: "123 Main St", count: UNREADABLE_REVIEW_COUNT },
    ]);
    expect(message).toContain(reviewBlockedBody(UNREADABLE_REVIEW_COUNT));
    expect(message).toContain("123 Main St (couldn't check)");
    expect(message).not.toMatch(/You have -1/);
  });
});
