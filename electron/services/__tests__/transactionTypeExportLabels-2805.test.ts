/**
 * @jest-environment node
 *
 * BACKLOG-2805 (support ticket 112) — the three export producers, asserted on
 * their RENDERED output.
 *
 * The sibling suite pins the shared constant. This one proves each producer
 * actually reaches it: a map that is correct but unread would pass there and
 * fail here. All three are asserted, because all three print this field into
 * a document the user files:
 *
 *   1. folderExport/summaryHelpers   — the audit summary HTML
 *   2. pdfExportService              — the compliance PDF
 *   3. enhancedExportService         — the .txt export
 *
 * (3) was ALREADY WRONG before this ticket: it printed the raw lowercase enum,
 * "Transaction Type: purchase". Fixing it is in scope for the export path.
 *
 * Reserved-for-documentation fixture values only.
 */

import { generateSummaryHTML } from "../folderExport/summaryHelpers";
import type { TransactionWithDetails } from "../transactionService/types";
import pdfExportService from "../pdfExportService";
import enhancedExportService from "../enhancedExportService";
import type { Transaction } from "../../types/models";

function makeTransaction(transactionType: string | undefined): TransactionWithDetails {
  return {
    id: "txn-2805",
    user_id: "user-1",
    property_address: "1 Example Street",
    transaction_type: transactionType,
    status: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    contact_assignments: [],
  } as unknown as TransactionWithDetails;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function pdfHtml(transactionType: string | undefined): string {
  return (pdfExportService as any)._generateHTML(
    makeTransaction(transactionType) as unknown as Transaction,
    [],
  );
}

function txtSummary(transactionType: string | undefined): string {
  return (enhancedExportService as any)._createSummary(
    makeTransaction(transactionType) as unknown as Transaction,
    [],
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe("BACKLOG-2805 — the audit summary HTML", () => {
  it('prints "Listing/Purchase" for a purchase', () => {
    const html = generateSummaryHTML(makeTransaction("purchase"), []);
    expect(html).toContain("Listing/Purchase");
  });

  it('still prints "Sale" for a sale, unchanged', () => {
    const html = generateSummaryHTML(makeTransaction("sale"), []);
    expect(html).toContain(">Sale<");
    expect(html).not.toContain("Listing/Purchase");
  });

  it("still prints N/A for a type it cannot name", () => {
    // Pre-existing behaviour that must survive the refactor.
    expect(generateSummaryHTML(makeTransaction("other"), [])).toContain("N/A");
  });
});

describe("BACKLOG-2805 — the compliance PDF", () => {
  it('prints "Listing/Purchase" for a purchase', () => {
    expect(pdfHtml("purchase")).toContain("Listing/Purchase");
  });

  it("keeps the RAW ENUM in the badge CSS class", () => {
    // The label and the class name come from the same field and only one of
    // them may change. `badge-Listing/Purchase` would be a broken selector
    // with a slash in it — this is the assertion that separates "renamed the
    // label" from "renamed the value".
    const html = pdfHtml("purchase");
    expect(html).toContain("badge-purchase");
    expect(html).not.toContain("badge-Listing/Purchase");
  });

  it('still prints "Sale" for a sale', () => {
    const html = pdfHtml("sale");
    expect(html).toContain(">Sale<");
    expect(html).not.toContain("Listing/Purchase");
  });

  it("still prints N/A when the type is absent", () => {
    expect(pdfHtml(undefined)).toContain("N/A");
  });
});

describe("BACKLOG-2805 — the .txt export", () => {
  it('prints "Transaction Type: Listing/Purchase", not the raw enum', () => {
    // The pre-existing defect: this line printed `purchase`, lowercase, in a
    // document the user files.
    const txt = txtSummary("purchase");
    expect(txt).toContain("Transaction Type: Listing/Purchase");
    expect(txt).not.toContain("Transaction Type: purchase");
  });

  it('prints "Transaction Type: Sale", not the raw enum', () => {
    const txt = txtSummary("sale");
    expect(txt).toContain("Transaction Type: Sale");
    expect(txt).not.toContain("Transaction Type: sale");
  });

  it("still prints N/A when the type is absent", () => {
    expect(txtSummary(undefined)).toContain("Transaction Type: N/A");
  });
});
