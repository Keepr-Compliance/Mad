/**
 * @jest-environment node
 *
 * BACKLOG-2804 (support ticket 111) — the filed document uses the same word
 * the app does.
 *
 * The renderer names the seller's agent through ROLE_DISPLAY_NAMES. The export
 * cannot read that map — `electron/` may not import from `src/` — so it
 * humanizes the raw enum itself: `seller_agent` -> "Seller Agent". Left alone,
 * the app would say "Listing Agent" on screen while the compliance summary the
 * user actually files said "Seller Agent" about the same person on the same
 * deal.
 *
 * These tests assert the rendered HTML, not the helper, so they fail if the
 * override is added but the export path never reaches it.
 *
 * Fixture note: `specific_role` arrives here in the shape the DB holds it. The
 * existing contactLabel suite passes UPPERCASE ("LISTING_AGENT"), so the
 * override must be case-insensitive; both casings are asserted below.
 */

import { generateSummaryHTML } from "../summaryHelpers";
import type { TransactionWithDetails } from "../../transactionService/types";
import type { TransactionContactResult } from "../../db/transactionContactDbService";

function makeTransaction(
  contacts: Array<Partial<TransactionContactResult>>,
): TransactionWithDetails {
  return {
    id: "txn-2804",
    user_id: "user-1",
    property_address: "1 Example Street",
    transaction_type: "purchase",
    status: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    // The summary reads `contact_assignments`, not `contacts` — naming it wrong
    // renders no contacts section and every assertion passes vacuously, so the
    // section lookup below asserts its own presence.
    contact_assignments: contacts.map((c, i) => ({
      id: `tc-${i}`,
      transaction_id: "txn-2804",
      contact_id: `c-${i}`,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...c,
    })),
  } as unknown as TransactionWithDetails;
}

function contactsSection(html: string): string {
  const start = html.indexOf('<div class="contact-list">');
  expect(start).toBeGreaterThan(-1);
  const next = html.indexOf('<div class="section">', start);
  return html.slice(start, next === -1 ? undefined : next);
}

describe("BACKLOG-2804 — the audit summary calls the seller's agent the Listing Agent", () => {
  it('prints "Listing Agent" for a seller_agent party', () => {
    const html = generateSummaryHTML(
      makeTransaction([
        {
          contact_name: "Robin Example",
          specific_role: "seller_agent",
        },
      ]),
      [],
    );
    const section = contactsSection(html);

    expect(section).toContain("Listing Agent");
    expect(section).not.toContain("Seller Agent");
  });

  it("matches the enum case-insensitively", () => {
    // Rows reach this helper uppercased as well as lowercased (see the
    // contactLabel suite). An override keyed on the exact lowercase string
    // would pass the case above and silently miss these rows.
    const html = generateSummaryHTML(
      makeTransaction([
        { contact_name: "Robin Example", specific_role: "SELLER_AGENT" },
      ]),
      [],
    );
    const section = contactsSection(html);

    expect(section).toContain("Listing Agent");
    expect(section).not.toContain("Seller Agent");
  });

  it('prints "Listing Agent" for the vestigial listing_agent value too', () => {
    const html = generateSummaryHTML(
      makeTransaction([
        { contact_name: "Omar Example", specific_role: "listing_agent" },
      ]),
      [],
    );

    expect(contactsSection(html)).toContain("Listing Agent");
  });

  it("leaves every other role's humanized label alone", () => {
    // The negative control. Replacing the generic snake_case humanizer with a
    // lookup table, or over-matching on "agent", would pass the cases above
    // and break these — including the multi-word one, which is the only input
    // that proves the underscore split still runs.
    const html = generateSummaryHTML(
      makeTransaction([
        { contact_name: "Dana Example", specific_role: "buyer_agent" },
        { contact_name: "Pat Example", specific_role: "real_estate_attorney" },
        { contact_name: "Sam Example", specific_role: "inspector" },
      ]),
      [],
    );
    const section = contactsSection(html);

    // BACKLOG-2859: "Buyer's Agent", HTML-ESCAPED. The role goes through
    // escapeHtml, which maps `'` to `&#039;`, so the apostrophe is an entity in
    // the source and renders as an apostrophe in the filed PDF. Asserting the
    // escaped form is asserting what the file actually contains — matching the
    // unescaped string here would fail while the output was correct.
    //
    // This is a RETIRED stored value (`buyer_agent`) reaching the export from an
    // un-migrated row; it must still humanize rather than print a raw enum into
    // a compliance document.
    expect(section).toContain("Buyer&#039;s Agent");
    expect(section).not.toContain("Buyer Agent");
    expect(section).toContain("Real Estate Attorney");
    expect(section).toContain("Inspector");
  });
});
