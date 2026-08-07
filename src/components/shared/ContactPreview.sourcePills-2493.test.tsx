/**
 * BACKLOG-2493 — the contact card shows its LIVE sources.
 *
 * THE DEFECT THIS FILE PINS
 *
 * The founder's Paul Dorian card read:
 *
 *     Paul Dorian
 *     Outlook
 *     Imported · Added Aug 3, 2026
 *
 * while every email address and phone number on that card had come from the Mac
 * address book. His Outlook link had been removed the day before (BACKLOG-2427)
 * and the Outlook-only address went with it. Only the label stayed.
 *
 * The card was reading `contact.source` — one scalar, written at INSERT, that no
 * unlink revises. BACKLOG-2472 had already stopped the LIST FILTER from trusting
 * that field and moved it onto `source_types`, the live crosswalk set. So the
 * filter said "Contacts App" and the card said "Outlook", for the same person,
 * on the same screen. The card is the half that was wrong, and this is that half.
 *
 * WHY EVERY ASSERTION NAMES AN EXACT PILL SET
 *
 * A count assertion (`toHaveLength(1)`) passes while rendering the WRONG source
 * — one Outlook pill and one Contacts App pill are both "one pill". Each test
 * below reads every pill in the card head and compares the whole array, so a
 * wrong pill, a missing pill, an extra pill and a duplicate all redden, and the
 * failure message names which source was rendered.
 *
 * FIXTURE PROVENANCE — TRANSCRIBED FROM THE PRODUCER, NOT INVENTED
 *
 * `source_types` is not free-form. It is produced by `getLiveSourcesByContact`
 * (electron/services/db/contactSourceSets.ts), which reads raw
 * `contact_source_links.source_type` values and maps each through
 * `toPersistedContactSource` before sorting and de-duplicating them. The raw
 * column admits exactly nine values (the v61 CHECK). Running that mapper over
 * all nine, at ff057ec0, produced:
 *
 *     {"macos":"contacts_app","iphone":"iphone","outlook":"outlook",
 *      "google_contacts":"google_contacts","android_sync":"android_sync",
 *      "manual":"manual","email":"email","sms":"sms","inferred":"inferred"}
 *     {"oneMacLink":["contacts_app"],"macPlusOutlook":["contacts_app","outlook"]}
 *
 * Two consequences the fixtures below obey:
 *   - `"messages"` NEVER appears in `source_types`. It is synthesised at SELECT
 *     time for message-derived pseudo-contacts and is not a crosswalk value — a
 *     fixture using it would describe a state the code cannot emit.
 *   - the producer SORTS, so fixtures are sorted. An unsorted fixture describes
 *     an output that never occurs, and would let an order bug pass unnoticed.
 */

import React from "react";
import { render, screen, within } from "@testing-library/react";
import { ContactPreview } from "./ContactPreview";
import type { ExtendedContact } from "../../types/components";

/** RFC 2606 / NANP only. */
const paulBase = {
  id: "c-paul",
  user_id: "u1",
  display_name: "Paul Dorian",
  name: "Paul Dorian",
  email: "p.dorian@example.com",
  allEmails: ["p.dorian@example.com", "paul.dorian@example.test"],
  allPhones: ["+1 (555) 010-1001"],
  created_at: "2026-08-03T00:00:00.000Z",
} as unknown as ExtendedContact;

function makeContact(overrides: Partial<ExtendedContact>): ExtendedContact {
  return { ...paulBase, ...overrides } as ExtendedContact;
}

/**
 * Every source pill in the card head, in render order, by test id.
 *
 * Scoped to `contact-preview-head` on purpose: the Sources provenance panel
 * lower down the card also names sources, and a document-wide query would
 * conflate the two, so a head that rendered NO pill could still look green.
 */
function pillsInHead(): string[] {
  const head = screen.getByTestId("contact-preview-head");
  return within(head)
    .queryAllByTestId(/^source-pill-/)
    .map((el) => el.getAttribute("data-testid") as string);
}

function renderCard(contact: ExtendedContact, isExternal = false) {
  return render(
    <ContactPreview
      contact={contact}
      isExternal={isExternal}
      transactions={[]}
      onClose={jest.fn()}
      onEdit={jest.fn()}
    />,
  );
}

describe("ContactPreview source pills — live sources (BACKLOG-2493)", () => {
  it("shows ONE pill per live source for a multi-source contact", () => {
    // A contact present in both the Mac address book and Outlook. Transcribed:
    // raw ['macos','outlook'] -> ["contacts_app","outlook"], sorted.
    renderCard(
      makeContact({ source: "contacts_app", source_types: ["contacts_app", "outlook"] }),
    );

    expect(pillsInHead()).toEqual(["source-pill-contacts_app", "source-pill-outlook"]);
  });

  it("THE FOUNDER'S CASE: shows the surviving source, not the stale scalar", () => {
    // Paul after his Outlook link was unlinked: the scalar still says the
    // address book that imported him FIRST, the crosswalk holds only macOS.
    renderCard(makeContact({ source: "outlook", source_types: ["contacts_app"] }));

    expect(pillsInHead()).toEqual(["source-pill-contacts_app"]);
    // Stated separately from the array assertion because this is the whole
    // point of the item: the live set REPLACES the scalar. If the two were
    // unioned, the removed source would be displayed forever — which is the bug.
    expect(screen.queryByTestId("source-pill-outlook")).not.toBeInTheDocument();
  });

  it("falls back to the scalar for a contact with no links (manual, or pre-crosswalk)", () => {
    // `source_types` ABSENT — which is what `attachLiveSources` leaves for a
    // contact with no crosswalk rows. It is never `[]`; the two are different
    // claims and only "we know of no source records" is true here.
    const contact = makeContact({ source: "outlook" });
    expect(contact.source_types).toBeUndefined();

    renderCard(contact);

    expect(pillsInHead()).toEqual(["source-pill-outlook"]);
  });

  it("keeps a manual contact's own pill rather than inventing an address book", () => {
    renderCard(makeContact({ source: "manual" }));

    expect(pillsInHead()).toEqual(["source-pill-manual"]);
  });

  it("leaves external (not-yet-imported) picker rows on their own origin", () => {
    // External records have no crosswalk row by construction — they are not in
    // the database yet. Distinct origins must still keep their identity instead
    // of collapsing into the generic Contacts App pill.
    renderCard(
      makeContact({ id: "ext-1", source: "iphone", source_types: undefined }),
      true,
    );

    expect(pillsInHead()).toEqual(["source-pill-iphone"]);
    expect(screen.getByTestId("status-pill-not-imported")).toBeInTheDocument();
  });

  it("renders each live source once when two of them share a pill variant", () => {
    // `email` and `inferred` are distinct source values that both display as the
    // Email pill. The mapper de-duplicates by display value, so the card shows
    // ONE Email pill rather than two identical ones side by side.
    renderCard(makeContact({ source: "manual", source_types: ["email", "inferred"] }));

    expect(pillsInHead()).toEqual(["source-pill-email"]);
  });
});
