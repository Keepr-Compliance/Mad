/**
 * BACKLOG-2869 — the header badge names the state the deal is actually in.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE PINS
 * ---------------------------------------------------------------------------
 * Before this item the header computed one boolean —
 *
 *   isSubmitted = status === "submitted" || "under_review" || "approved"
 *
 * — and drew one green chip reading "Submitted". So an APPROVED deal reported
 * "Submitted" and never told its owner the answer she was waiting for, while
 * `rejected`, `needs_changes` and `resubmitted` fell outside the boolean and
 * drew NOTHING: a rejected deal was pixel-identical to one never sent.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY CASE ASSERTS AN ABSENCE TOO
 * ---------------------------------------------------------------------------
 * A presence-only suite CANNOT catch the bug this item fixes. Three statuses
 * share the label "Under Review" by design, and the old code gave three
 * statuses the label "Submitted" by accident — so "the badge is on screen" is
 * true in both worlds. What separates them is that the OTHER labels are
 * absent. Each case therefore asserts its own string present AND all three
 * rival strings gone, which is what goes red when two statuses collide on one
 * label (measured; see the PR body).
 *
 * The header mounts a mobile variant and a desktop variant together, hidden
 * from each other by Tailwind breakpoints, so every control exists TWICE. The
 * assertions read EVERY instance rather than the first: a change that reached
 * one variant only would otherwise pass.
 */
import fs from "fs";
import path from "path";
import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TransactionHeader, SUBMISSION_STATUS_TONE } from "../TransactionHeader";
import { HEADER_BADGE_ROWS } from "./founderLabelTable-2869";
import type { Transaction } from "@/types";

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

function renderHeader(submissionStatus: string | undefined) {
  const transaction = {
    id: "tx-2869",
    user_id: "user-2869",
    property_address: "18 Bellweather Lane",
    status: "active",
    submission_status: submissionStatus,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as unknown as Transaction;

  render(
    <TransactionHeader
      transaction={transaction}
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
}

const badges = () => screen.queryAllByTestId("submission-status-badge");

/**
 * The founder's table, from the ONE hand-typed copy in `founderLabelTable-2869`
 * — the same fixture the cross-surface parity suite reads.
 *
 * Hand-typed at source on purpose, and imported rather than re-typed here: a
 * table derived from the shipped map would assert the map against itself and
 * pass no matter what it said, while a second transcription could be
 * half-updated. `SUBMISSION_STATUS_LABEL` is deliberately NOT imported by this
 * file.
 */
const EXPECTED: Array<[status: string, label: string]> = HEADER_BADGE_ROWS.map(
  (row) => [row.status, row.label],
);

/** Every label the header can draw. Rival labels are derived from this. */
const ALL_LABELS = Array.from(new Set(HEADER_BADGE_ROWS.map((row) => row.label)));

describe("BACKLOG-2869 — one badge per status, by exact string", () => {
  it.each(EXPECTED)("%s reads \"%s\", and reads nothing else", (status, label) => {
    renderHeader(status);

    // Present, on BOTH rendered variants, with exactly this text.
    const rendered = badges();
    expect(rendered.length).toBeGreaterThan(0);
    for (const node of rendered) {
      expect(node).toHaveTextContent(label);
    }

    // Absent: every rival label. This is the half that fails when two statuses
    // collide — the half a presence-only check cannot supply.
    for (const rival of ALL_LABELS.filter((l) => l !== label)) {
      expect(screen.queryByText(rival)).not.toBeInTheDocument();
    }
  });

  it.each(["submitted", "under_review", "resubmitted", "approved"])(
    "%s never says the old word \"Submitted\"",
    (status) => {
      // The exact regression: these four all read "Submitted" before, and the
      // word survives in the codebase (list-card chip, modal titles), so its
      // absence HERE is worth its own assertion rather than being implied.
      renderHeader(status);

      expect(screen.queryByText("Submitted")).not.toBeInTheDocument();
    },
  );
});

describe("BACKLOG-2869 — the two statuses that drew nothing at all", () => {
  it.each(["rejected", "needs_changes"])("%s renders a badge, where before it rendered none", (status) => {
    // Asserted on the testid, not on text: this is the "is there a badge here
    // at all" question, and it must not be answerable by a stray word matching
    // somewhere else in the header.
    renderHeader(status);

    expect(badges().length).toBeGreaterThan(0);
  });
});

describe("BACKLOG-2869 — states the header must stay silent about", () => {
  it("not_submitted renders no badge and no label", () => {
    renderHeader("not_submitted");

    expect(badges()).toHaveLength(0);
    for (const label of ALL_LABELS) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
    // Not silent because nothing rendered — the header is there.
    expect(screen.queryAllByTestId("complete-button").length).toBeGreaterThan(0);
  });

  it("a row with no submission_status at all renders no badge", () => {
    // The column is nullable and the prop is optional (`submission_status?:`),
    // so this is a real row shape, not a hypothetical.
    renderHeader(undefined);

    expect(badges()).toHaveLength(0);
    expect(screen.queryAllByTestId("complete-button").length).toBeGreaterThan(0);
  });

  it("a status this build has never heard of renders no badge", () => {
    // A row written by a future portal or an older build. The header says
    // nothing rather than guessing — and must not crash reaching for a map
    // entry that does not exist.
    renderHeader("escalated_to_compliance");

    expect(badges()).toHaveLength(0);
    expect(screen.queryAllByTestId("complete-button").length).toBeGreaterThan(0);
  });
});

describe("BACKLOG-2869 — the tone map covers the schema, not a copy of it", () => {
  it("has an entry for exactly the statuses the CHECK constraint admits", () => {
    /**
     * Derived from the schema by execution, not from a second hand-typed list:
     * a status added to the CHECK constraint and forgotten here fails this
     * test rather than shipping as a silently badge-less state — which is the
     * shape of the original defect (`resubmitted` and `needs_changes` existed
     * in the schema and in no branch of the header).
     */
    const schema = fs.readFileSync(
      path.resolve(__dirname, "../../../../../electron/database/schema.sql"),
      "utf8",
    );
    const check = /submission_status\s+TEXT[^\n]*CHECK\s*\(submission_status\s+IN\s*\(([^)]*)\)\)/i.exec(schema);
    expect(check).not.toBeNull();

    const schemaStatuses = Array.from((check as RegExpExecArray)[1].matchAll(/'([^']+)'/g)).map((m) => m[1]);
    // The parse itself must not be vacuous.
    expect(schemaStatuses).toHaveLength(7);
    expect(schemaStatuses).toContain("resubmitted");

    expect(Object.keys(SUBMISSION_STATUS_TONE).sort()).toEqual([...schemaStatuses].sort());
  });

  it("gives not_submitted no tone (so no badge) and every other status one", () => {
    expect(SUBMISSION_STATUS_TONE.not_submitted).toBeNull();
    for (const [status] of EXPECTED) {
      expect(SUBMISSION_STATUS_TONE[status as keyof typeof SUBMISSION_STATUS_TONE]).not.toBeNull();
    }
  });
});
