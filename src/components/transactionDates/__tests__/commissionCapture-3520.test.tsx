/**
 * BACKLOG-3520 — the commission block of "Verify Transaction Details", on both
 * routes (Submit's date step and Export's Step 1).
 *
 * The REAL shared writer is used (not mocked): every assertion about what is
 * saved reads the payload that reaches `window.api.transactions.update`, so a
 * host that stops passing the commission update to the writer is caught.
 *
 * RUNNER: npx jest src/components/transactionDates/__tests__/commissionCapture-3520.test.tsx
 */
import React from "react";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { Transaction } from "@/types";
import ExportModal from "../../ExportModal";
import { SubmitForReviewModal } from "../../transactionDetailsModule/components/modals/SubmitForReviewModal";

const updateMock = window.api.transactions.update as jest.Mock;
const exportEnhancedMock = window.api.transactions.exportEnhanced as jest.Mock;
const completenessMock = window.api.transactions.checkExportCompleteness as jest.Mock;
const featureCheckMock = window.api.featureGate.check as jest.Mock;
const getStatusMock = window.api.entitlement.getStatus as jest.Mock;

const TX = "txn-3520";
const base = {
  id: TX,
  user_id: "user-3520",
  status: "active",
  property_address: "18 Bellweather Lane",
  transaction_type: "purchase",
  started_at: "2026-01-05",
  closed_at: "2026-03-14",
  sale_price: 412500,
  listing_price: 415000,
} as unknown as Transaction;

const DATES = { started_at: "2026-01-05", closing_deadline: null, closed_at: "2026-03-14", closing_date_verified: 1 };

beforeEach(() => {
  jest.clearAllMocks();
  updateMock.mockResolvedValue({ success: true });
  featureCheckMock.mockResolvedValue({ allowed: true, value: "", source: "default" });
  exportEnhancedMock.mockResolvedValue({ success: true, path: "/out/audit" });
  completenessMock.mockResolvedValue({ complete: true });
  getStatusMock.mockResolvedValue({ localTransactionId: TX, status: "unlocked", fromCache: false });
});

function renderSubmit(transaction: Transaction = base, onSubmit = jest.fn()) {
  render(
    <SubmitForReviewModal
      transaction={transaction}
      emailCount={4}
      textThreadCount={2}
      attachmentCount={3}
      emailAttachmentCount={1}
      totalSizeBytes={2048}
      isSubmitting={false}
      progress={null}
      error={null}
      onCancel={jest.fn()}
      onSubmit={onSubmit}
      onExport={jest.fn()}
    />,
  );
  return { onSubmit };
}

function renderExport(transaction: Transaction = base) {
  return render(
    <ExportModal transaction={transaction} userId="user-3520" onClose={jest.fn()} onExportComplete={jest.fn()} />,
  );
}

const field = (id: string) => screen.getByTestId(id) as HTMLInputElement;
const type = (id: string, value: string) => fireEvent.change(field(id), { target: { value } });
const has = (id: string) => screen.queryByTestId(id) !== null;
async function click(testId: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId(testId));
  });
}
/** The payload the shared writer sent to the IPC bridge, last call. */
function sentUpdate(): Record<string, unknown> {
  expect(updateMock).toHaveBeenCalled();
  const call = updateMock.mock.calls[updateMock.mock.calls.length - 1];
  expect(call[0]).toBe(TX);
  return call[1] as Record<string, unknown>;
}

describe("the block (Submit route)", () => {
  it("prefills the sale price from the transaction, leaves both rates and the reason empty, shows an em dash", () => {
    renderSubmit();
    expect(field("commission-sale").value).toBe("412,500");
    expect(field("commission-offered").value).toBe("");
    expect(field("commission-actual").value).toBe("");
    expect(screen.getByTestId("commission-amount")).toHaveTextContent("—");
    expect(has("commission-reason")).toBe(false);
  });

  it("labels carry no (%), and there are no helper lines under the inputs", () => {
    renderSubmit();
    const block = screen.getByTestId("commission-fields");
    for (const label of ["Sale Price", "Commission Offered", "Commission Actual", "Commission Amount"]) {
      expect(within(block).getByText(label)).toBeInTheDocument();
    }
    expect(block.textContent).not.toMatch(/\(%\)/);
    expect(block.querySelectorAll("p")).toHaveLength(0);
  });

  it("Actual COPIES Offered as it is typed, until the agent edits Actual — then they are independent", () => {
    renderSubmit();
    type("commission-offered", "3");
    expect(field("commission-actual").value).toBe("3");
    type("commission-offered", "2.5");
    expect(field("commission-actual").value).toBe("2.5");

    type("commission-actual", "2");
    type("commission-offered", "3.5");
    expect(field("commission-actual").value).toBe("2"); // no longer follows
    expect(field("commission-offered").value).toBe("3.5");
  });

  it("computes the amount from Actual, rounded to cents BEFORE it is shown", () => {
    renderSubmit();
    type("commission-offered", "2.5"); // 412500 x 2.5% = 10312.5
    expect(screen.getByTestId("commission-amount")).toHaveTextContent("$10,312.50");
    expect(screen.getByTestId("commission-amount").textContent).not.toBe("$10,312.5");
    type("commission-sale", "333.33");
    type("commission-actual", "1.005"); // 333.33 x 1.005% = 3.3499665 -> 3.35
    expect(screen.getByTestId("commission-amount")).toHaveTextContent("$3.35");
  });

  it("asks for a reason whenever Actual differs from Offered, in EITHER direction, and hides it when they match again", () => {
    renderSubmit();
    type("commission-offered", "3");
    expect(has("commission-reason")).toBe(false);
    type("commission-actual", "2.5"); // lower
    expect(has("commission-reason")).toBe(true);
    type("commission-actual", "3.5"); // higher
    expect(has("commission-reason")).toBe(true);
    type("commission-actual", "3");
    expect(has("commission-reason")).toBe(false);
  });
});

describe("Next and the empty-commission warning (Submit route)", () => {
  it("an EMPTY commission warns on Next; Enter commission closes it and focuses Offered; nothing advances", async () => {
    renderSubmit();
    await click("submit-review-next");
    expect(screen.getByTestId("commission-not-entered-dialog")).toBeInTheDocument();
    expect(screen.getByText(/Your broker will see this submission without a commission figure/)).toBeInTheDocument();
    expect(screen.queryByText("Submission Summary")).not.toBeInTheDocument();

    await click("commission-enter");
    expect(has("commission-not-entered-dialog")).toBe(false);
    expect(document.activeElement).toBe(field("commission-offered"));
    expect(screen.queryByText("Submission Summary")).not.toBeInTheDocument();
  });

  it("Continue anyway NEVER blocks: it advances to the summary and Submit saves with NO commission key", async () => {
    const { onSubmit } = renderSubmit();
    await click("submit-review-next");
    await click("commission-continue-anyway");
    expect(screen.getByText("Submission Summary")).toBeInTheDocument();
    await click("submit-review-submit");
    const sent = sentUpdate();
    expect(sent).toEqual(DATES);
    expect(Object.keys(sent).filter((k) => k.startsWith("commission_") || k === "sale_price")).toEqual([]);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("a commission that is ENTERED goes straight to the summary, no warning", async () => {
    renderSubmit();
    type("commission-offered", "3");
    await click("submit-review-next");
    expect(has("commission-not-entered-dialog")).toBe(false);
    expect(screen.getByText("Submission Summary")).toBeInTheDocument();
  });

  it("with only Offered blanked after Actual was edited, the commission is still incomplete and warns", async () => {
    renderSubmit();
    type("commission-actual", "2");
    await click("submit-review-next");
    expect(has("commission-not-entered-dialog")).toBe(true);
  });

  it("an out-of-range rate BLOCKS Next with an inline error and no warning dialog", async () => {
    renderSubmit();
    type("commission-offered", "101");
    expect(screen.getByTestId("commission-error")).toHaveTextContent(/between 0 and 100/);
    await click("submit-review-next");
    expect(has("commission-not-entered-dialog")).toBe(false);
    expect(screen.queryByText("Submission Summary")).not.toBeInTheDocument();
  });
});

describe("what Submit saves", () => {
  it("saves rates as percentages, the gross rounded to cents, the reason, and the sale price — with the dates, in ONE update", async () => {
    renderSubmit();
    type("commission-offered", "3");
    type("commission-actual", "2.5");
    type("commission-reason", "  Reduced to close the deal ");
    await click("submit-review-next");
    await click("submit-review-submit");
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(sentUpdate()).toEqual({
      ...DATES,
      sale_price: 412500,
      commission_offered_rate: 3,
      commission_actual_rate: 2.5,
      commission_gross_amount: 10312.5,
      commission_adjustment_reason: "Reduced to close the deal",
    });
  });

  it("the reason is OPTIONAL: differing rates with no reason proceed, and store null", async () => {
    renderSubmit();
    type("commission-offered", "3");
    type("commission-actual", "2");
    await click("submit-review-next");
    expect(screen.getByText("Submission Summary")).toBeInTheDocument();
    await click("submit-review-submit");
    expect(sentUpdate().commission_adjustment_reason).toBeNull();
    expect(sentUpdate().commission_actual_rate).toBe(2);
  });

  it("a reason typed and then made irrelevant (rates match again) is NOT saved", async () => {
    renderSubmit();
    type("commission-offered", "3");
    type("commission-actual", "2");
    type("commission-reason", "stale");
    type("commission-actual", "3");
    await click("submit-review-next");
    await click("submit-review-submit");
    expect(sentUpdate().commission_adjustment_reason).toBeNull();
  });

  it("an exact-zero actual rate is saved as 0 with a gross of 0, not dropped", async () => {
    renderSubmit();
    type("commission-offered", "3");
    type("commission-actual", "0");
    await click("submit-review-next");
    await click("submit-review-submit");
    expect(sentUpdate().commission_actual_rate).toBe(0);
    expect(sentUpdate().commission_gross_amount).toBe(0);
  });

  it("an edited sale price is saved (the gross is computed from it) and the gross rounds half up", async () => {
    renderSubmit();
    type("commission-sale", "$333.33");
    type("commission-offered", "1.005");
    await click("submit-review-next");
    await click("submit-review-submit");
    expect(sentUpdate().sale_price).toBe(333.33);
    expect(sentUpdate().commission_actual_rate).toBe(1.005);
    expect(sentUpdate().commission_gross_amount).toBe(3.35);
  });
});

describe("a transaction that already has figures", () => {
  const saved = { ...base, commission_offered_rate: 3, commission_actual_rate: 2.5, commission_gross_amount: 10312.5, commission_adjustment_reason: "Reduced to close the deal" } as unknown as Transaction;

  it("opens with them, and editing Offered does NOT overwrite a recorded reduction", () => {
    renderSubmit(saved);
    expect(field("commission-offered").value).toBe("3");
    expect(field("commission-actual").value).toBe("2.5");
    expect(field("commission-reason").value).toBe("Reduced to close the deal");
    type("commission-offered", "4");
    expect(field("commission-actual").value).toBe("2.5");
  });

  it("blanking them CLEARS the row: every figure is sent as null", async () => {
    renderSubmit(saved);
    type("commission-offered", "");
    type("commission-actual", "");
    await click("submit-review-next");
    await click("commission-continue-anyway");
    await click("submit-review-submit");
    const sent = sentUpdate();
    expect(sent.commission_offered_rate).toBeNull();
    expect(sent.commission_actual_rate).toBeNull();
    expect(sent.commission_gross_amount).toBeNull();
    expect(sent.commission_adjustment_reason).toBeNull();
  });
});

describe("the Export route shares the block and the writer", () => {
  it("an empty commission warns with the export wording; Continue anyway proceeds to step 2", async () => {
    renderExport();
    fireEvent.click((await screen.findAllByRole("button", { name: /next/i }))[0]);
    expect(await screen.findByTestId("commission-not-entered-dialog")).toBeInTheDocument();
    expect(screen.getByText(/This export will not include a commission figure/)).toBeInTheDocument();
    await click("commission-continue-anyway");
    expect(await screen.findByText("Export Options")).toBeInTheDocument();
  });

  it("an entered commission is saved with the dates when Export is pressed", async () => {
    renderExport();
    type("commission-offered", "3");
    type("commission-actual", "2.5");
    fireEvent.click((await screen.findAllByRole("button", { name: /next/i }))[0]);
    expect(has("commission-not-entered-dialog")).toBe(false);
    const exportButton = (await screen.findAllByRole("button", { name: /^export$/i }))[0];
    await act(async () => {
      fireEvent.click(exportButton);
    });
    expect(sentUpdate()).toEqual({
      ...DATES,
      sale_price: 412500,
      commission_offered_rate: 3,
      commission_actual_rate: 2.5,
      commission_gross_amount: 10312.5,
      commission_adjustment_reason: null,
    });
  });
});
