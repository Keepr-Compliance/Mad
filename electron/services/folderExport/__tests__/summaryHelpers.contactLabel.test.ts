/**
 * @jest-environment node
 *
 * BACKLOG-2461 — what the compliance PDF calls a party who has no name.
 *
 * This is the serious half of the ticket. A party on a transaction exported into
 * the audit summary as the literal word "Unknown" beside their role, while the
 * same row held a phone number we could have printed:
 *
 *     Client (Buyer/Seller) — Unknown
 *
 * That is a filed document naming a party as unidentified when we can identify
 * them. These tests assert the rendered HTML, not the helper — the helper is
 * covered by the parity suite, and what matters here is that the export path
 * actually reaches it.
 */

import { generateSummaryHTML } from "../summaryHelpers";
import type { TransactionWithDetails } from "../../transactionService/types";
import type { TransactionContactResult } from "../../db/transactionContactDbService";

function makeTransaction(
  contacts: Array<Partial<TransactionContactResult>>,
): TransactionWithDetails {
  return {
    id: "txn-1",
    user_id: "user-1",
    property_address: "1 Example Street",
    transaction_type: "purchase",
    status: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    // NOTE: the summary reads `contact_assignments`, not `contacts`. Naming it
    // wrong renders no contacts section at all and every assertion below passes
    // vacuously, so the section lookup asserts its own presence.
    contact_assignments: contacts.map((c, i) => ({
      id: `tc-${i}`,
      transaction_id: "txn-1",
      contact_id: `c-${i}`,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...c,
    })),
  } as unknown as TransactionWithDetails;
}

/**
 * The contacts section only — keeps assertions off the rest of the report.
 *
 * Runs to the start of the NEXT section rather than to the first closing tag:
 * the contact rows nest several divs, so stopping at the first `</div>` cut the
 * detail line off and made a passing assertion mean nothing.
 */
function contactsSection(html: string): string {
  const start = html.indexOf('<div class="contact-list">');
  expect(start).toBeGreaterThan(-1);
  const next = html.indexOf('<div class="section">', start);
  return html.slice(start, next === -1 ? undefined : next);
}

describe("BACKLOG-2461 — the audit PDF names a party by what we hold", () => {
  it("prints the formatted phone for a party with no name", () => {
    const html = generateSummaryHTML(
      makeTransaction([
        {
          contact_name: "",
          contact_phone: "+14155550134",
          specific_role: "CLIENT",
        },
      ]),
      [],
    );
    const section = contactsSection(html);

    expect(section).toContain("+1 (415) 555-0134");
    // The bug, stated as an assertion.
    expect(section).not.toContain(">Unknown<");
  });

  it("prints the email when there is no name and no phone", () => {
    const html = generateSummaryHTML(
      makeTransaction([
        { contact_name: "", contact_email: "jane@acme.com", specific_role: "CLIENT" },
      ]),
      [],
    );
    const section = contactsSection(html);

    expect(section).toContain("jane@acme.com");
    expect(section).not.toContain(">Unknown<");
  });

  it('prints "No name" when we genuinely hold nothing', () => {
    const html = generateSummaryHTML(
      makeTransaction([{ contact_name: "", specific_role: "CLIENT" }]),
      [],
    );
    const section = contactsSection(html);

    expect(section).toContain("No name");
    expect(section).not.toContain("Unknown");
  });

  it("keeps the country code on a non-US number", () => {
    // The founder's own data: Costa Rica. A bare "50664103686" is not dialable.
    const html = generateSummaryHTML(
      makeTransaction([
        { contact_name: "", contact_phone: "+50664103686", specific_role: "CLIENT" },
      ]),
      [],
    );

    expect(contactsSection(html)).toContain("+50664103686");
  });

  it("a real name still wins over everything else", () => {
    const html = generateSummaryHTML(
      makeTransaction([
        {
          contact_name: "Jane Doe",
          contact_company: "Acme Realty",
          contact_phone: "+14155550134",
          contact_email: "jane@acme.com",
          specific_role: "CLIENT",
        },
      ]),
      [],
    );

    expect(contactsSection(html)).toContain("Jane Doe");
  });

  it("falls back to the organisation before the phone", () => {
    const html = generateSummaryHTML(
      makeTransaction([
        {
          contact_name: "",
          contact_company: "Acme Realty",
          contact_phone: "+14155550134",
          specific_role: "CLIENT",
        },
      ]),
      [],
    );
    const section = contactsSection(html);

    expect(section).toContain("Acme Realty");
    // The phone is still listed as a detail — it is only the LABEL that the
    // organisation wins.
    expect(section).toContain("+14155550134");
  });

  it("does not print the same number twice when it became the label", () => {
    const html = generateSummaryHTML(
      makeTransaction([
        { contact_name: "", contact_phone: "+14155550134", specific_role: "CLIENT" },
      ]),
      [],
    );
    const section = contactsSection(html);

    // The label is the formatted number; the raw E.164 detail line is dropped
    // rather than repeating the same value in a filed document.
    expect(section).toContain("+1 (415) 555-0134");
    expect(section).not.toContain("+14155550134");
  });

  it("two nameless parties are distinguishable in the filed document", () => {
    const html = generateSummaryHTML(
      makeTransaction([
        { contact_name: "", contact_phone: "+14155550134", specific_role: "CLIENT" },
        { contact_name: "", contact_phone: "+14155550199", specific_role: "LISTING_AGENT" },
      ]),
      [],
    );
    const section = contactsSection(html);

    expect(section).toContain("+1 (415) 555-0134");
    expect(section).toContain("+1 (415) 555-0199");
  });

  it('a legacy row already holding "Unknown" heals without a migration', () => {
    // 18 of the founder's contacts were imported before this change and carry
    // the literal string. The screen and the export heal on next render; the
    // row is deliberately left alone (see contactDisplayLabel.persistence.test).
    const html = generateSummaryHTML(
      makeTransaction([
        { contact_name: "Unknown", contact_phone: "+14155550134", specific_role: "CLIENT" },
      ]),
      [],
    );
    const section = contactsSection(html);

    expect(section).toContain("+1 (415) 555-0134");
    expect(section).not.toContain(">Unknown<");
  });
});
