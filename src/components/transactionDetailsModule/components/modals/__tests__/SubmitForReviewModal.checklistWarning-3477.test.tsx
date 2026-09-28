/**
 * BACKLOG-3477 PR E — before a submit or resubmit, warn when required
 * checklist items are not ticked. Warn and allow: "Submit anyway" proceeds,
 * "Go back" returns to the summary. Counted across EVERY checklist on the
 * transaction. A failed checklist read shows no warning and submits.
 *
 * FIXTURE PROVENANCE: `checklistFixtures-3476.json` is the real
 * `getChecklistsForTransaction` output over the real schema, kept honest by
 * electron/services/db/__tests__/checklistRendererFixtures-3476.test.ts
 * (real-sqlite, Electron runner). Its three checklists hold:
 *   Probe template        item 1 req ticked, item 2 req NOT ticked,
 *                         item 3 opt ticked, item 4 opt NOT ticked
 *   Other probe template  item 1 req ticked, items 2 + 3 req NOT ticked
 *   Done probe template   everything ticked
 * so the warning must list exactly Probe item 2, Other item 2, Other item 3 —
 * never Probe item 4 (optional), and not only the first checklist's.
 * The "nothing unticked" envelope is the same payload cut down to the Done
 * checklist with its own sums; the empty envelope is tests/setup.js:380,
 * which is what the producer returns for a transaction with no checklists.
 *
 * The date step (BACKLOG-3498) is walked through for real: dates are saved
 * through `window.api.transactions.update`, so "nothing was saved" is
 * observable.
 *
 * RUNNER: npx jest src/components/transactionDetailsModule/components/modals/__tests__/SubmitForReviewModal.checklistWarning-3477.test.tsx
 */
import React from "react";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SubmitForReviewModal } from "../SubmitForReviewModal";
import type { Transaction } from "@/types";
import type { ChecklistsForTransaction } from "../../../../../../electron/types/checklist";
import fixtures from "../../checklist/__tests__/fixtures/checklistFixtures-3476.json";

const REAL: ChecklistsForTransaction = fixtures.checklists as unknown as ChecklistsForTransaction;

/** Only the fully ticked checklist, with its own sums. */
const ALL_TICKED: ChecklistsForTransaction = (() => {
  const done = REAL.checklists.filter((c) => c.checklist.templateName === "Done probe template");
  return {
    checklists: done,
    requiredDone: done.reduce((s, c) => s + c.requiredDone, 0),
    requiredTotal: done.reduce((s, c) => s + c.requiredTotal, 0),
  };
})();

const EMPTY: ChecklistsForTransaction = { checklists: [], requiredDone: 0, requiredTotal: 0 };

const EXPECTED_TITLES = ["Probe item 2", "Other item 2", "Other item 3"];

const TX = "txn-3477";
const transaction = {
  id: TX,
  user_id: "user-3477",
  property_address: "18 Bellweather Lane",
  transaction_type: "purchase",
  status: "active",
  started_at: "2026-01-05",
  closed_at: "2026-03-14T18:22:05.000Z",
} as unknown as Transaction;

const getMock = () => window.api.checklists.get as jest.Mock;
const updateMock = () => window.api.transactions.update as jest.Mock;

type ModalProps = React.ComponentProps<typeof SubmitForReviewModal>;

function renderModal(overrides: Partial<ModalProps> = {}) {
  const props: ModalProps = {
    transaction,
    emailCount: 4,
    textThreadCount: 2,
    attachmentCount: 3,
    emailAttachmentCount: 1,
    totalSizeBytes: 2048,
    isSubmitting: false,
    progress: null,
    error: null,
    onCancel: jest.fn(),
    onSubmit: jest.fn(),
    onExport: jest.fn(),
    onDatesSaved: jest.fn(),
    checklistsEnabled: true,
    ...overrides,
  };
  const utils = render(<SubmitForReviewModal {...props} />);
  return { ...utils, props };
}

async function press(testId: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId(testId));
  });
}

/** Date step → Next → summary → Submit. */
async function pressSubmit(): Promise<void> {
  await press("submit-review-next");
  await press("submit-review-submit");
}

function warning(): HTMLElement | null {
  return screen.queryByTestId("submit-review-checklist-warning");
}

beforeEach(() => {
  getMock().mockReset();
  updateMock().mockReset();
  updateMock().mockResolvedValue({ success: true });
  getMock().mockResolvedValue({ success: true, checklists: REAL });
});

describe("BACKLOG-3477 E-C1 — required items unticked across two checklists are listed", () => {
  it("lists exactly the required, unticked items from every checklist, and nothing is saved or submitted yet", async () => {
    const { props } = renderModal();
    await pressSubmit();

    const dialog = warning();
    expect(dialog).toBeInTheDocument();
    expect(within(dialog as HTMLElement).getByRole("heading")).toHaveTextContent(
      "3 required items are not checked",
    );
    expect(dialog).toHaveTextContent(
      "You can still submit. The checklist goes with the transaction as it stands.",
    );
    const rows = within(screen.getByTestId("submit-review-checklist-warning-list")).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent?.trim())).toEqual(EXPECTED_TITLES);
    expect(dialog).not.toHaveTextContent("Probe item 4");
    expect(getMock()).toHaveBeenCalledTimes(1);
    expect(getMock()).toHaveBeenCalledWith({ transactionId: TX });
    expect(updateMock()).not.toHaveBeenCalled();
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("says 'item is' for exactly one", async () => {
    const probeOnly = REAL.checklists.filter((c) => c.checklist.templateName === "Probe template");
    getMock().mockResolvedValue({
      success: true,
      checklists: { checklists: probeOnly, requiredDone: 1, requiredTotal: 2 },
    });
    renderModal();
    await pressSubmit();
    expect(within(warning() as HTMLElement).getByRole("heading")).toHaveTextContent(
      "1 required item is not checked",
    );
  });
});

describe("BACKLOG-3477 E-C2 — warn and allow", () => {
  it("Submit anyway saves the dates once and submits once, without reading the checklist again", async () => {
    const { props } = renderModal();
    await pressSubmit();
    await press("submit-review-checklist-submit-anyway");

    expect(warning()).not.toBeInTheDocument();
    expect(updateMock()).toHaveBeenCalledTimes(1);
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
    expect(getMock()).toHaveBeenCalledTimes(1);
  });

  it("Go back closes the warning, stays on the summary, and saves and submits nothing", async () => {
    const { props } = renderModal();
    await pressSubmit();
    await press("submit-review-checklist-go-back");

    expect(warning()).not.toBeInTheDocument();
    expect(screen.getByTestId("submit-review-lead")).toBeInTheDocument();
    expect(screen.getByTestId("submit-review-submit")).toBeEnabled();
    expect(updateMock()).not.toHaveBeenCalled();
    expect(props.onSubmit).not.toHaveBeenCalled();
  });
});

describe("BACKLOG-3477 E-C3 — the warning appears on resubmit too", () => {
  it("a needs_changes deal gets the same warning before it resubmits", async () => {
    const { props } = renderModal({
      transaction: { ...transaction, submission_status: "needs_changes" } as Transaction,
    });
    await pressSubmit();
    expect(warning()).toBeInTheDocument();
    expect(props.onSubmit).not.toHaveBeenCalled();
    await press("submit-review-checklist-submit-anyway");
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("BACKLOG-3477 E-C4 — no warning when there is nothing to warn about", () => {
  it.each([
    ["every required item ticked", ALL_TICKED],
    ["no checklists on the transaction", EMPTY],
  ])("%s → no warning, dates saved, submitted", async (_label, data) => {
    getMock().mockResolvedValue({ success: true, checklists: data });
    const { props } = renderModal();
    await pressSubmit();
    expect(warning()).not.toBeInTheDocument();
    expect(updateMock()).toHaveBeenCalledTimes(1);
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
  });

  it("checklists not enabled (plan does not allow them) → no read, no warning, submitted", async () => {
    const { props } = renderModal({ checklistsEnabled: false });
    await pressSubmit();
    expect(getMock()).not.toHaveBeenCalled();
    expect(warning()).not.toBeInTheDocument();
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("BACKLOG-3477 E-C5 — a failed checklist read does not block the submit", () => {
  it.each([
    ["the read is refused", () => getMock().mockResolvedValue({ success: false, error: "boom" })],
    ["the IPC throws", () => getMock().mockRejectedValue(new Error("ipc down"))],
  ])("%s → no warning, dates saved, submitted", async (_label, arrange) => {
    arrange();
    const { props } = renderModal();
    await pressSubmit();
    expect(warning()).not.toBeInTheDocument();
    expect(updateMock()).toHaveBeenCalledTimes(1);
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("BACKLOG-3477 E-C6 — the read in flight", () => {
  it("Submit is disabled while the checklist is being read, and a second press reads nothing more", async () => {
    let resolve: (v: unknown) => void = () => {};
    getMock().mockImplementation(() => new Promise((r) => { resolve = r; }));
    const { props } = renderModal();
    await pressSubmit();
    expect(screen.getByTestId("submit-review-submit")).toBeDisabled();
    await press("submit-review-submit");
    expect(getMock()).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve({ success: true, checklists: EMPTY });
    });
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
  });

  it("closing with the X while the read is pending saves and submits nothing", async () => {
    let resolve: (v: unknown) => void = () => {};
    getMock().mockImplementation(() => new Promise((r) => { resolve = r; }));
    const { props } = renderModal();
    await pressSubmit();
    await press("submit-review-close");
    await act(async () => {
      resolve({ success: true, checklists: EMPTY });
    });
    expect(updateMock()).not.toHaveBeenCalled();
    expect(props.onSubmit).not.toHaveBeenCalled();
  });
});

describe("BACKLOG-3477 E-C7 — BACKLOG-3498's date step still comes first", () => {
  it("the dialog opens on the date step, and no checklist read happens before Submit", async () => {
    renderModal();
    expect(screen.getByTestId("submit-review-dates")).toBeInTheDocument();
    await press("submit-review-next");
    expect(getMock()).not.toHaveBeenCalled();
    expect(warning()).not.toBeInTheDocument();
  });
});
