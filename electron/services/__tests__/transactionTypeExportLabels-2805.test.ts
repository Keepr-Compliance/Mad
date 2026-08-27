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
  it('prints "Listing" for a purchase', () => {
    const html = generateSummaryHTML(makeTransaction("purchase"), []);
    expect(html).toContain(">Listing<");
    // BACKLOG-2850: the string it REPLACED must be gone. "Listing" is a
    // prefix of "Listing/Purchase", so the presence assertion above passes on
    // the old label too and cannot stand alone.
    expect(html).not.toContain("Listing/Purchase");
  });

  it('still prints "Sale" for a sale, unchanged', () => {
    const html = generateSummaryHTML(makeTransaction("sale"), []);
    expect(html).toContain(">Sale<");
    // BACKLOG-2850: the negative is scoped to the VALUE cell (`>Listing<`),
    // not to the bare token. These documents already contain "Listing Price"
    // (pdfExportService) and "Listing Agent" (summaryHelpers) as unrelated
    // field labels, so `not.toContain("Listing")` asserts something false —
    // it passes here only because this fixture has no contacts and no price.
    expect(html).not.toContain(">Listing<");
  });

  it("still prints N/A for a type it cannot name", () => {
    // Pre-existing behaviour that must survive the refactor.
    expect(generateSummaryHTML(makeTransaction("other"), [])).toContain("N/A");
  });
});

describe("BACKLOG-2805 — the compliance PDF", () => {
  it('prints "Listing" for a purchase', () => {
    expect(pdfHtml("purchase")).toContain(">Listing<");
    expect(pdfHtml("purchase")).not.toContain("Listing/Purchase");
  });

  it("keeps the RAW ENUM in the badge CSS class", () => {
    // The label and the class name come from the same field and only one of
    // them may change. This is the assertion that separates "renamed the
    // label" from "renamed the value" — the latter would break the DB.
    //
    // BACKLOG-2850: the wrong-selector shape is now `badge-Listing`, which
    // (unlike the old `badge-Listing/Purchase`) is a SYNTACTICALLY VALID class
    // name. It would look fine in the markup and simply never match the
    // stylesheet, so this negative has to name the current label, not the
    // retired one.
    const html = pdfHtml("purchase");
    expect(html).toContain("badge-purchase");
    expect(html).not.toContain("badge-Listing");
  });

  it('still prints "Sale" for a sale', () => {
    const html = pdfHtml("sale");
    expect(html).toContain(">Sale<");
    // Scoped to the value cell — the PDF has a "Listing Price" field label.
    expect(html).not.toContain(">Listing<");
  });

  it("still prints N/A when the type is absent", () => {
    expect(pdfHtml(undefined)).toContain("N/A");
  });
});

describe("BACKLOG-2805 — the .txt export", () => {
  it('prints "Transaction Type: Listing", not the raw enum', () => {
    // The pre-existing defect: this line printed `purchase`, lowercase, in a
    // document the user files.
    const txt = txtSummary("purchase");
    expect(txt).toContain("Transaction Type: Listing");
    expect(txt).not.toContain("Transaction Type: purchase");
    expect(txt).not.toContain("Transaction Type: Listing/Purchase");
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
