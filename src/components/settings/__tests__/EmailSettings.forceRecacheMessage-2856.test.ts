/**
 * BACKLOG-2856: what the user is TOLD after a force re-cache.
 *
 * Companion to `emailSyncHandlers.forceRecache-2856`. That suite pins the
 * handler no longer swallowing the failure; this one pins the sentence itself,
 * because the original defect was not only a dropped field — it was a template
 * string that asserted an unlink unconditionally:
 *
 *   `Re-cached ${result.emailsStored ?? 0} emails … Linked emails were unlinked
 *    from their transactions.`
 *
 * Two things wrong with it, both user-visible:
 *   - `emailsStored` counts rows written to the STAGING tables, so on a force run
 *     it reports what was FETCHED, not what survived the swap;
 *   - the unlink clause is stated even when no swap committed, which is what sent
 *     users off to re-attach mail that had never been detached.
 *
 * The message is now derived from `forceSwap`, which exists only when the swap
 * actually committed.
 */

import { describeForceRecache } from "../EmailSettings";
import type { Connections } from "../types";

const connected = (google: boolean, microsoft: boolean): Connections => ({
  google: google ? ({ connected: true } as Connections["google"]) : null,
  microsoft: microsoft ? ({ connected: true } as Connections["microsoft"]) : null,
});

const swap = (over: Partial<{ emailsInserted: number; providers: Array<"gmail" | "outlook"> }> = {}) => ({
  emailsDeleted: over.emailsInserted ?? 47,
  emailsInserted: over.emailsInserted ?? 47,
  participantsInserted: 94,
  providers: over.providers ?? (["outlook"] as Array<"gmail" | "outlook">),
});

describe("describeForceRecache (BACKLOG-2856)", () => {
  /**
   * The defect, stated as a test. `success: true` with no `forceSwap` is the
   * decline-to-swap outcome, and it must not claim an unlink.
   *
   * MUTATION: return the old template string -> "unlinked from their
   * transactions" appears and this goes red.
   */
  it("claims no unlink when no swap committed", () => {
    const msg = describeForceRecache(undefined, connected(false, true));
    expect(msg).not.toMatch(/unlinked/i);
    expect(msg).toMatch(/unchanged/i);
  });

  /** A clean single-mailbox run reports what LANDED, and owns the unlink. */
  it("reports the inserted count and the unlink on a clean run", () => {
    const msg = describeForceRecache(swap({ emailsInserted: 47 }), connected(false, true));
    expect(msg).toContain("Re-cached 47 emails");
    expect(msg).toMatch(/unlinked from their transactions/i);
    expect(msg).not.toMatch(/could not be re-downloaded/i);
  });

  /**
   * The partial success — the case most likely to mislead, because the count
   * looks healthy and nothing else on screen would say a whole mailbox was left
   * untouched.
   *
   * MUTATION: drop the `skipped` branch -> the Gmail warning disappears and the
   * message reads as a complete success.
   */
  it("names a connected mailbox that was skipped", () => {
    const msg = describeForceRecache(
      swap({ emailsInserted: 47, providers: ["outlook"] }),
      connected(true, true),
    );
    expect(msg).toContain("Re-cached 47 emails");
    expect(msg).toContain("Gmail could not be re-downloaded");
    expect(msg).toMatch(/left unchanged/i);
  });

  it("names both mailboxes when neither provider is in the swap", () => {
    const msg = describeForceRecache(
      swap({ emailsInserted: 0, providers: [] }),
      connected(true, true),
    );
    expect(msg).toContain("Gmail and Outlook could not be re-downloaded");
    expect(msg).toMatch(/were left unchanged/i);
  });

  /** Singular/plural, because "Re-cached 1 emails" is the kind of thing he notices. */
  it("agrees in number", () => {
    expect(describeForceRecache(swap({ emailsInserted: 1 }), connected(false, true))).toContain(
      "Re-cached 1 email.",
    );
    expect(describeForceRecache(swap({ emailsInserted: 0 }), connected(false, true))).toContain(
      "Re-cached 0 emails.",
    );
  });
});
