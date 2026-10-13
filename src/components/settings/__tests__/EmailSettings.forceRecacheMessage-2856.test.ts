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
 *
 * BACKLOG-3910a: a force run no longer unlinks anything (emails tied to a deal
 * are kept), and a run in which a connected mailbox did not finish applies
 * nothing — so there is no partial-mailbox sentence any more; its replacement
 * is `describeForceNotApplied`.
 */

import { describeForceNotApplied, describeForceRecache } from "../EmailSettings";
import type { ForceSwapSummary } from "../EmailSettings";

const swap = (over: Partial<ForceSwapSummary> = {}): ForceSwapSummary => ({
  emailsDeleted: 47,
  emailsInserted: 47,
  emailsRefreshed: 0,
  emailsKeptLocked: 0,
  emailsKeptNoCopy: 0,
  participantsInserted: 94,
  providers: ["outlook"],
  ...over,
});

describe("describeForceRecache (BACKLOG-2856 / 3910a)", () => {
  /**
   * `success: true` with no `forceSwap` is the decline-to-swap outcome, and it
   * must not claim an unlink.
   */
  it("claims no unlink when no swap committed", () => {
    const msg = describeForceRecache(undefined);
    expect(msg).not.toMatch(/unlinked/i);
    expect(msg).toMatch(/unchanged/i);
  });

  /**
   * MUTATION: restore "Those emails were unlinked from their transactions." ->
   * red.
   */
  it("reports what landed and claims no unlink on a clean run", () => {
    const msg = describeForceRecache(swap({ emailsInserted: 47 }));
    expect(msg).toBe("Re-cached 47 emails.");
    expect(msg).not.toMatch(/unlink/i);
  });

  /** Re-cached = new rows + kept rows updated in place. Zero clauses omitted. */
  it("counts the refreshed rows in, and names them and the locked ones", () => {
    expect(
      describeForceRecache(swap({ emailsInserted: 40, emailsRefreshed: 7, emailsKeptLocked: 3 })),
    ).toBe(
      "Re-cached 47 emails. 7 of them were updated in place and kept their links. 3 emails on submitted or approved deals were left unchanged.",
    );
    expect(describeForceRecache(swap({ emailsInserted: 5, emailsKeptLocked: 2 }))).toBe(
      "Re-cached 5 emails. 2 emails on submitted or approved deals were left unchanged.",
    );
  });

  /** Singular/plural, because "Re-cached 1 emails" is the kind of thing he notices. */
  it("agrees in number", () => {
    expect(describeForceRecache(swap({ emailsInserted: 1 }))).toBe("Re-cached 1 email.");
    expect(describeForceRecache(swap({ emailsInserted: 0 }))).toBe("Re-cached 0 emails.");
    expect(
      describeForceRecache(swap({ emailsInserted: 0, emailsRefreshed: 1, emailsKeptLocked: 1 })),
    ).toBe(
      "Re-cached 1 email. 1 of them was updated in place and kept its links. 1 email on a submitted or approved deal was left unchanged.",
    );
  });
});

describe("describeForceNotApplied (BACKLOG-3910a, SR S6)", () => {
  const FALLBACK = "Re-cache could not finish for x. Nothing was changed.";

  it("token expired: reconnect, then run again", () => {
    expect(
      describeForceNotApplied(
        { mailboxes: [{ provider: "outlook", mailbox: "me@example.com", tokenExpired: true }] },
        FALLBACK,
      ),
    ).toBe(
      "Re-cache could not finish for me@example.com. Nothing was changed. Reconnect me@example.com in Settings, then run Re-cache again.",
    );
  });

  it("otherwise: check the connection", () => {
    expect(
      describeForceNotApplied(
        { mailboxes: [{ provider: "gmail", mailbox: "Gmail", tokenExpired: false }] },
        FALLBACK,
      ),
    ).toBe("Re-cache could not finish for Gmail. Nothing was changed. Check your connection and try again.");
  });

  it("two mailboxes, one expired: names both, gives each next step", () => {
    expect(
      describeForceNotApplied(
        {
          mailboxes: [
            { provider: "gmail", mailbox: "a@example.net", tokenExpired: true },
            { provider: "outlook", mailbox: "b@example.com", tokenExpired: false },
          ],
        },
        FALLBACK,
      ),
    ).toBe(
      "Re-cache could not finish for a@example.net and b@example.com. Nothing was changed. Reconnect a@example.net in Settings, then run Re-cache again. Check your connection and try again.",
    );
  });

  it("falls back to the main process sentence when no mailbox is named", () => {
    expect(describeForceNotApplied({ mailboxes: [] }, FALLBACK)).toBe(FALLBACK);
  });
});
