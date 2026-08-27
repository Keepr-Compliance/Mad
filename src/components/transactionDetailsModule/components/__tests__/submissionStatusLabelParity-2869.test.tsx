/**
 * BACKLOG-2869 — ONE STATE, ONE WORD, ON EVERY SURFACE THAT SHOWS ONE.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE EXISTS TO PREVENT
 * ---------------------------------------------------------------------------
 * The first half of this item fixed the transaction header, where one boolean
 * drew one chip reading "Submitted" for three different states. Landing that
 * alone would have produced a second defect out of the fix: the same deal
 * reading "Under Review" in the header and "Submitted" on the list row behind
 * it. One state with two words is not a smaller problem than one word for
 * three states — it is a translation table the user has to build himself.
 *
 * So both chips now read `SUBMISSION_STATUS_LABEL`, and this file is the proof
 * that they do.
 *
 * ---------------------------------------------------------------------------
 * TWO KINDS OF ASSERTION, AND WHY BOTH ARE NEEDED
 * ---------------------------------------------------------------------------
 * 1. AGREEMENT (header label === list label). Catches drift between the two
 *    consumers. It CANNOT catch a wrong word — mutate the shared map and both
 *    surfaces move together, so agreement stays true. That is the correct
 *    behaviour and is exactly what proves they share a source.
 *
 * 2. GROUND TRUTH (each surface === the hand-typed founder table). This is
 *    what a mutation turns red, and it turns red on BOTH consumers at once,
 *    which is the measurement that distinguishes "genuinely shared" from "two
 *    maps that happen to agree today". If only one goes red, the refactor is
 *    incomplete.
 *
 * The founder table lives in `founderLabelTable-2869.ts` precisely so it is
 * NOT derived from the thing under test.
 *
 * Styling is deliberately unasserted. A header chip and a dense list row are
 * not the same object and are allowed to look different; the two files own
 * their own tone. The word is what may not differ.
 */
import React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TransactionHeader } from "../TransactionHeader";
import { SubmissionStatusBadge } from "../SubmissionStatusBadge";
import { SUBMISSION_STATUS_LABEL } from "../submissionStatusLabels";
import { FOUNDER_LABEL_TABLE, HEADER_BADGE_ROWS } from "./founderLabelTable-2869";
import type { SubmissionStatus, Transaction } from "@/types";

jest.mock("@/contexts/LicenseContext", () => ({ useLicense: jest.fn() }));
jest.mock("@/hooks/useFeatureGate", () => ({
  useFeatureGate: () => ({
    isAllowed: () => true,
    features: {},
    loading: false,
    refresh: jest.fn(),
  }),
}));
jest.mock("../../../../contexts/NetworkContext", () => ({
  useNetwork: () => ({
    isOnline: true,
    isChecking: false,
    lastOnlineAt: null,
    lastOfflineAt: null,
    connectionError: null,
    checkConnection: jest.fn(),
    clearError: jest.fn(),
    setConnectionError: jest.fn(),
  }),
}));

/** What the HEADER chip says for a status, read off the rendered DOM. */
function headerLabelFor(status: SubmissionStatus): string | null {
  render(
    <TransactionHeader
      transaction={
        {
          id: "tx-2869",
          user_id: "user-2869",
          property_address: "18 Bellweather Lane",
          status: "active",
          submission_status: status,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        } as unknown as Transaction
      }
      isPendingReview={false}
      isRejected={false}
      isApproving={false}
      isRejecting={false}
      isRestoring={false}
      isSubmitting={false}
      onClose={jest.fn()}
      onShowRejectReasonModal={jest.fn()}
      onShowEditModal={jest.fn()}
      onApprove={jest.fn()}
      onRestore={jest.fn()}
      onShowExportModal={jest.fn()}
      onShowDeleteConfirm={jest.fn()}
      reviewCount={0}
      onShowNeedsReview={jest.fn()}
      onComplete={jest.fn()}
      showExport={false}
    />,
  );

  // The header mounts a mobile and a desktop variant together, so the chip
  // exists twice. Read every instance and collapse: a half-applied change
  // would leave two different words and fail the uniqueness check below.
  const nodes = screen.queryAllByTestId("submission-status-badge");
  if (nodes.length === 0) return null;
  const texts = Array.from(new Set(nodes.map((n) => n.textContent?.trim() ?? "")));
  expect(texts).toHaveLength(1);
  return texts[0];
}

/** What the LIST-ROW chip says for the same status. */
function listLabelFor(status: SubmissionStatus): string {
  render(<SubmissionStatusBadge status={status} />);
  return screen.getByTestId("submission-status-chip").textContent?.trim() ?? "";
}

afterEach(cleanup);

describe("BACKLOG-2869 — the shipped map matches the founder's table", () => {
  it.each(FOUNDER_LABEL_TABLE)("$status is called \"$label\"", ({ status, label }) => {
    // The map against a copy of the requirement that no mutation can move.
    expect(SUBMISSION_STATUS_LABEL[status]).toBe(label);
  });

  it("covers every status the table names, and invents none", () => {
    expect(Object.keys(SUBMISSION_STATUS_LABEL).sort()).toEqual(
      FOUNDER_LABEL_TABLE.map((row) => row.status).sort(),
    );
  });
});

describe("BACKLOG-2869 — both surfaces render that word, not their own", () => {
  it.each(HEADER_BADGE_ROWS)("header says \"$label\" for $status", ({ status, label }) => {
    expect(headerLabelFor(status)).toBe(label);
  });

  it.each(FOUNDER_LABEL_TABLE)("list row says \"$label\" for $status", ({ status, label }) => {
    expect(listLabelFor(status)).toBe(label);
  });
});

describe("BACKLOG-2869 — and they agree with each other", () => {
  it.each(HEADER_BADGE_ROWS)("header and list row agree on $status", ({ status }) => {
    // Consumer to consumer, with the map out of the picture. This is the
    // assertion that stays green under a map mutation — which is what proves
    // the two are reading the same source rather than agreeing by luck.
    const header = headerLabelFor(status);
    cleanup();
    expect(header).toBe(listLabelFor(status));
  });

  it("shows no header chip for not_submitted, while the list row still names it", () => {
    // Visibility differs on purpose and is a surface decision; the WORD does
    // not. Both list cards guard on `submission_status !== "not_submitted"`
    // before rendering this chip at all, so in practice neither surface shows
    // it — the label exists so the Record stays exhaustive.
    expect(headerLabelFor("not_submitted")).toBeNull();
    cleanup();
    expect(listLabelFor("not_submitted")).toBe("Not Submitted");
  });
});
