/**
 * BACKLOG-2868 — EACH BLOCKED STATUS MUST BE TOLD SOMETHING TRUE OF ITSELF.
 *
 * BACKLOG-2853 disabled the modal's action across FOUR statuses and wrote a
 * lead paragraph for ONE. A rejected deal was therefore told its submission
 * "is with your broker for review" and that "if your broker asks for changes,
 * you will be able to resubmit it here" — both false in a terminal state — and
 * because the same change disabled the button, the accurate line the service
 * carries stopped being reachable by pressing it.
 *
 * WHY THE 2853 SUITE DID NOT CATCH IT. That suite derives the DISABLED SET by
 * execution, which is the right shape for the question it asked, and it asserts
 * the lead copy only at `submitted` — the one status whose copy was correct. A
 * presence check ("the screen says a submission exists") passes while all four
 * share one message. So every assertion below that names a status also asserts
 * the OTHER statuses' copy is ABSENT. Presence alone cannot separate the fixed
 * code from the broken code, and a check whose inputs cannot separate pass from
 * fail carries no information.
 *
 * FIXTURE PROVENANCE. `submission_status` is the only input this branch reads;
 * its permitted values are the `SubmissionStatus` union in
 * electron/types/models.ts. `progress: null` is what `useSubmitForReview.reset()`
 * sets, i.e. the exact re-entry state. The expected messages are NOT retyped
 * here — they are imported from the producer, see below.
 *
 * THE CROSS-BOUNDARY IMPORT IS DELIBERATE AND IS THE POINT OF THE FILE.
 * `electron/services/submissionStatusMessages.ts` is the CANONICAL copy of
 * these strings and the modal holds a mirror, because the renderer cannot
 * value-import from `electron/` in production (Vite parses it as JavaScript)
 * and `electron/` cannot import from `src/` (`rootDir`). A TEST is not bundled
 * by Vite, so it can import both and prove they agree. This is the repo's
 * established pattern — `src/utils/__tests__/contactSourceDefaults.parity.test.ts:19`
 * imports its canonical module by relative path for exactly this reason. The
 * module is dependency-free, so this pulls in no Electron or Supabase runtime.
 *
 * CONTROLS RUN MANUALLY, MEASURED RESULTS ON BACKLOG-2868:
 *  - MUTATION: give two statuses the same lead in `BLOCKED_STATUS_COPY`.
 *  - COLLAPSE: revert the map to BACKLOG-2853's single shared string.
 * Both must go red here, or this file is decoration.
 *
 * RUNNER: npx jest src/components/transactionDetailsModule/components/modals/__tests__/SubmitForReviewModal.blockedStatusCopy-2868.test.tsx
 */
import React from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SubmitForReviewModal } from "../SubmitForReviewModal";
import {
  BLOCKED_SUBMISSION_STATUSES,
  BLOCKED_SUBMISSION_MESSAGES,
} from "../../../../../../electron/services/submissionStatusMessages";
import type { Transaction } from "@/types";

/**
 * BACKLOG-3498: dated, so the date step's Next is enabled. A deal that can
 * still be submitted (not_submitted, needs_changes) opens on the date step and
 * its lead and action are on the next screen. Blocked statuses are unaffected.
 * Date-only start (wizard, useAuditSubmission.ts:140-142) and ISO-timestamp end
 * (detection path, electron/services/transactionService/transactionService.ts:958).
 */
const baseTransaction = {
  id: "txn-2868",
  user_id: "user-2868",
  property_address: "18 Bellweather Lane",
  transaction_type: "purchase",
  status: "active",
  started_at: "2026-01-05",
  closed_at: "2026-03-14T18:22:05.000Z",
} as unknown as Transaction;

/** BACKLOG-3498: Next from the date step to the lead and the action. */
function goToSummary(): void {
  fireEvent.click(screen.getByTestId("submit-review-next"));
}

function renderAt(submissionStatus: string) {
  return render(
    <SubmitForReviewModal
      transaction={
        { ...baseTransaction, submission_status: submissionStatus } as Transaction
      }
      emailCount={4}
      textThreadCount={2}
      attachmentCount={3}
      emailAttachmentCount={1}
      totalSizeBytes={2048}
      isSubmitting={false}
      progress={null}
      error={null}
      onCancel={jest.fn()}
      onSubmit={jest.fn()}
      onExport={jest.fn()}
    />
  );
}

const lead = () => screen.getByTestId("submit-review-lead").textContent ?? "";

/**
 * The copy the user is expected to see, per status. The lead is asserted as an
 * EXACT string: a substring match would let a fifth sentence be appended, or
 * the four leads be concatenated into one, and still pass.
 */
const EXPECTED: Record<string, { title: string; lead: string }> = {
  submitted: {
    title: "Already Submitted",
    lead: "This transaction has already been submitted and is with your broker for review. It cannot be submitted again — if your broker asks for changes, you will be able to resubmit it here.",
  },
  under_review: {
    title: "Under Review",
    lead: "Cannot resubmit while broker is reviewing. Please wait for their decision.",
  },
  /**
   * BACKLOG-3390 — the status this map was missing, and the one the founder
   * pressed. Retyped here on purpose: this table is the EXACT-string pin, and
   * importing the canonical value into it would make the pin assert only that
   * a string equals itself. The containment tests below are where the import
   * does the work.
   */
  resubmitted: {
    title: "Already Resubmitted",
    lead: "This transaction has already been resubmitted and is waiting for your broker to review the new version. If your broker asks for more changes you will be able to resubmit again.",
  },
  approved: {
    title: "Already Approved",
    lead: "This submission has already been approved. There is nothing further to send.",
  },
  rejected: {
    title: "Submission Rejected",
    lead: "This submission has been rejected. Please contact your broker.",
  },
};

describe("BACKLOG-2868 — per-status copy on a blocked deal", () => {
  test.each(Object.keys(EXPECTED))(
    "at '%s' the lead is that status's own copy, and no other status's copy appears",
    (status) => {
      renderAt(status);

      expect(lead()).toBe(EXPECTED[status].lead);
      expect(
        screen.getByRole("heading", { name: EXPECTED[status].title })
      ).toBeInTheDocument();

      /**
       * THE ASSERTION THAT SEPARATES FIXED FROM BROKEN. While one string served
       * all four, every presence check above passed for exactly one status and
       * the other three rendered that same string. Asserting the other statuses'
       * copy is absent is what fails in that world.
       */
      for (const other of Object.keys(EXPECTED)) {
        if (other === status) continue;
        expect(lead()).not.toContain(EXPECTED[other].lead);
        expect(
          screen.queryByRole("heading", { name: EXPECTED[other].title })
        ).not.toBeInTheDocument();
      }
    }
  );

  /**
   * The specific false sentences the item was filed on, named literally so they
   * cannot drift back in under a different arrangement.
   */
  test("a REJECTED deal is not told the broker is reviewing it or will ask for changes", () => {
    renderAt("rejected");

    expect(lead()).not.toMatch(/with your broker for review/i);
    expect(lead()).not.toMatch(/asks for changes/i);
    expect(lead()).not.toMatch(/you will be able to resubmit/i);
    expect(
      screen.queryByRole("heading", { name: "Already Submitted" })
    ).not.toBeInTheDocument();

    /**
     * THE BUTTON STILL READS "Already Submitted" AT `rejected`, DELIBERATELY,
     * and this pins it so the choice is visible rather than accidental.
     *
     * BACKLOG-2868 scoped the change to the title and the lead copy. The label
     * stays literally true — she did already submit it, and that is the reason
     * the control is dead — and moving it would move the BACKLOG-2849
     * button-literal suite for a string the item did not ask about. Raised as a
     * question on BACKLOG-2868 rather than taken silently. If the answer is
     * "give it a per-status label too", this expectation is where that lands.
     */
    expect(screen.getByTestId("submit-review-submit")).toHaveTextContent(
      "Already Submitted"
    );
  });

  test("an APPROVED deal is not told it is still with the broker for review", () => {
    renderAt("approved");

    expect(lead()).not.toMatch(/with your broker for review/i);
    expect(lead()).not.toMatch(/asks for changes/i);
  });

  /**
   * REACHABILITY, not presence. The regression BACKLOG-2868 names is not that
   * the accurate rejected message was missing from the codebase — it was in
   * `submissionStatusMessages.ts` the whole time. It is that the only way a
   * user could reach it was by pressing a button that BACKLOG-2853 disabled.
   * So this asserts it is ON SCREEN in the state the user arrives in, with no
   * interaction at all, and that the control which used to surface it is
   * indeed still dead — i.e. this text is the ONLY route.
   */
  test("the accurate rejected message is on screen without the user pressing anything", () => {
    renderAt("rejected");

    expect(
      screen.getByText(/This submission has been rejected\./)
    ).toBeInTheDocument();
    // The next step, so the dialog is not a terminal state with no way forward.
    expect(lead()).toMatch(/contact your broker/i);
    // And the route that used to carry it is still closed, which is why the
    // copy has to.
    expect(screen.getByTestId("submit-review-submit")).toBeDisabled();
  });

  /**
   * PARITY WITH THE PRODUCER. The renderer's mirror must CONTAIN the canonical
   * service message for its status. Containment, not equality: `rejected` adds
   * a next-step sentence the service's thrown Error has no room for, and
   * `submitted` keeps BACKLOG-2853's own accurate phrasing by instruction.
   *
   * Change a string in `submissionStatusMessages.ts` without changing the
   * modal and this goes red — which is the mechanism that was missing when one
   * lead paragraph was written for four statuses.
   */
  describe("parity with electron/services/submissionStatusMessages.ts", () => {
    test("the modal renders a lead for exactly the statuses the service refuses", () => {
      const rendered = new Set<string>();
      for (const status of [
        "not_submitted",
        "submitted",
        "under_review",
        "needs_changes",
        "resubmitted",
        "approved",
        "rejected",
      ]) {
        renderAt(status);
        // BACKLOG-3498: pass the date step wherever it is offered, to reach the
        // action. WHICH statuses get the step is dateStep-3498's C3a.
        if (screen.queryByTestId("submit-review-next")) goToSummary();
        if ((screen.getByTestId("submit-review-submit") as HTMLButtonElement).disabled) {
          rendered.add(status);
        }
        cleanup();
      }
      expect(rendered).toEqual(new Set(BLOCKED_SUBMISSION_STATUSES));
    });

    /**
     * `submitted` IS EXEMPT FROM CONTAINMENT, AND THE EXEMPTION IS NAMED HERE
     * RATHER THAN QUIETLY ABSENT — an exemption nobody can see is how the next
     * status gets left out of the next check.
     *
     * BACKLOG-2868's instruction for `submitted` was explicit: "current copy —
     * accurate". Its lead is BACKLOG-2853's own phrasing, which says the same
     * two facts as the service's message ("already submitted", "you can
     * resubmit if the broker asks") in different words. Harmonising it for
     * symmetry would reword an accurate string on a screen the founder has
     * already tested — the same unrequested widening that produced this item.
     * So it is pinned EXACTLY by the `EXPECTED` table above instead, which is a
     * stricter check than containment, not a weaker one.
     */
    const CONTAINMENT_STATUSES = BLOCKED_SUBMISSION_STATUSES.filter(
      (s) => s !== "submitted"
    );

    test.each([...CONTAINMENT_STATUSES])(
      "at '%s' the rendered lead contains the service's own message verbatim",
      (status) => {
        renderAt(status);
        expect(lead()).toContain(BLOCKED_SUBMISSION_MESSAGES[status]);
      }
    );

    test("the exemption covers exactly one status, so it cannot quietly grow", () => {
      expect(BLOCKED_SUBMISSION_STATUSES.length - CONTAINMENT_STATUSES.length).toBe(1);
      expect(CONTAINMENT_STATUSES).not.toContain("submitted");
      // And `submitted`'s copy is still pinned — by exact string, above.
      expect(EXPECTED.submitted.lead).toBeTruthy();
    });

    /**
     * Guards the containment assertion above from becoming vacuous. If the
     * canonical messages were ever collapsed to one shared string, every
     * `toContain` would still pass while the modal said one thing at every
     * blocked status — the defect, re-created one level up.
     *
     * Counted off `BLOCKED_SUBMISSION_STATUSES.length` rather than a literal,
     * so adding a status (BACKLOG-3390 added `resubmitted`) raises the bar
     * instead of leaving a stale "four" that the new string never has to clear.
     */
    test("the canonical messages are all DISTINCT strings", () => {
      const distinct = new Set(
        BLOCKED_SUBMISSION_STATUSES.map((s) => BLOCKED_SUBMISSION_MESSAGES[s])
      );
      expect(distinct.size).toBe(BLOCKED_SUBMISSION_STATUSES.length);
    });

    test("and so are the rendered leads", () => {
      const leads = new Set<string>();
      for (const status of BLOCKED_SUBMISSION_STATUSES) {
        renderAt(status);
        leads.add(lead());
        cleanup();
      }
      expect(leads.size).toBe(BLOCKED_SUBMISSION_STATUSES.length);
    });
  });

  /**
   * BACKLOG-3390 — NO REFUSAL THE USER READS MAY NAME A DATABASE OBJECT.
   *
   * The item was filed on this sentence, shown under the heading "Submission
   * Failed":
   *
   *   Failed to insert submission: duplicate key value violates unique
   *   constraint "transaction_submissions_org_txn_version_user_key"
   *
   * The patterns below are transcribed from it plus the SQL vocabulary that
   * would arrive the same way (a Postgres SQLSTATE, a table name, a PostgREST
   * code). Asserted over BOTH copies — the canonical strings the service throws
   * AND what the modal actually renders — because either one reaching a user is
   * the defect, and the modal's copy is written by hand.
   */
  test("no blocked-status sentence names a constraint, a table or a SQLSTATE", () => {
    const FORBIDDEN: RegExp[] = [
      /transaction_submissions/i,
      /_key\b/,
      /unique constraint/i,
      /duplicate key/i,
      /\bconstraint\b/i,
      /\bSQL\b/,
      /\b23505\b/,
      /\bPGRST\d+/,
      /\b(?:INSERT INTO|SELECT |UPDATE |DELETE FROM)\b/i,
    ];

    const subjects: Array<{ where: string; text: string }> = [];
    for (const status of BLOCKED_SUBMISSION_STATUSES) {
      subjects.push({
        where: `canonical[${status}]`,
        text: BLOCKED_SUBMISSION_MESSAGES[status],
      });
      renderAt(status);
      subjects.push({ where: `rendered lead at '${status}'`, text: lead() });
      cleanup();
    }

    // Anti-vacuity: an empty or short subject list would pass every assertion
    // below while proving nothing. Two subjects per blocked status, non-empty.
    expect(subjects).toHaveLength(BLOCKED_SUBMISSION_STATUSES.length * 2);
    for (const s of subjects) {
      expect(s.text.length).toBeGreaterThan(20);
      for (const pattern of FORBIDDEN) {
        expect({ where: s.where, matched: pattern.test(s.text) }).toEqual({
          where: s.where,
          matched: false,
        });
      }
    }
  });

  /**
   * The statuses this change must NOT have moved. `needs_changes` is the
   * broker-returned deal that legitimately resubmits; `not_submitted` is the
   * first-submit screen. Both were green before BACKLOG-2868 and before
   * BACKLOG-3390, and must stay green: 3390 blocks the state AFTER a resubmit,
   * never the state that starts one.
   */
  test("'needs_changes' and 'not_submitted' keep their live, non-blocked screens", () => {
    renderAt("needs_changes");
    goToSummary(); // BACKLOG-3498: the lead is on the screen after the date step
    expect(lead()).toMatch(/You are about to resubmit this transaction/);
    expect(screen.getByTestId("submit-review-submit")).toBeEnabled();
    cleanup();

    renderAt("not_submitted");
    goToSummary();
    expect(lead()).toMatch(/The following data will be sent to your broker/);
    expect(screen.getByTestId("submit-review-submit")).toBeEnabled();
  });
});
