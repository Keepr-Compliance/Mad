/**
 * BACKLOG-2471 PR C — the compare screen's columns, read-only.
 *
 * WHAT THIS FILE PINS THAT THE SERVICE SUITE CANNOT: the two FOUNDER DECISION D5
 * treatments are strings on screen, not fields in a payload. The service returns
 * `transactions: []` and `kind: "source"`; whether that reaches the user as
 * "not a contact yet" or as an empty cell is decided here, and only here.
 *
 * The view is stubbed at `window.api` rather than mocked at the hook, so the
 * component and its hook are exercised together — the same reason
 * `LinkSourceSearch`'s suite stubs the bridge.
 *
 * Every assertion names EXACT ids. A count would pass while rendering the wrong
 * column.
 *
 * NEGATIVE-CONTROL DISCIPLINE: an assertion that "not a contact yet" is on
 * screen would also pass if the whole column vanished, so each copy assertion is
 * paired with a structural one naming the column it must appear IN.
 */

import React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { ContactCompareSources } from "./ContactCompareSources";
import type { ContactCompareView } from "@/types/contactProvenance";

const CONTACT_LINK = "link-origin";
const OUTLOOK_LINK = "link-outlook";

/**
 * TRANSCRIBED FROM THE PRODUCER. Every field is what
 * `getContactCompareColumns` projects for a two-column contact — verified by
 * `electron/services/__tests__/contactCompare.test.ts`, which builds the same
 * shape through the real writers and the real driver. Fixture values use RFC
 * 2606 domains and NANP reserved-fictional numbers (555 is the EXCHANGE).
 */
function makeView(overrides: Partial<ContactCompareView> = {}): ContactCompareView {
  return {
    contactId: "c-paul",
    title: "Is this the same Paul Dorian?",
    reason: "Both records list the phone number +1 (206) 555-0142, and the names match.",
    namesMatch: true,
    columns: [
      {
        linkId: CONTACT_LINK,
        kind: "contact",
        columnLabel: "Mac address book",
        displayName: "Paul Dorian",
        name: { value: "Paul Dorian", matched: true },
        emails: [],
        phones: [{ value: "+1 (206) 555-0142", matched: true }],
        company: null,
        transactions: ["571 Dale St N"],
        recentCommunication: [
          {
            id: "tx-2",
            channel: "text",
            title: "Re: inspection scheduling",
            occurredAt: "2026-08-02T09:00:00.000Z",
            matchedIdentifier: null,
          },
        ],
        sourceRecordPresent: true,
      },
      {
        linkId: OUTLOOK_LINK,
        kind: "source",
        columnLabel: "Outlook contacts",
        displayName: "Paul Dorian",
        name: { value: "Paul Dorian", matched: true },
        emails: [{ value: "pdorian@example.com", matched: false }],
        phones: [{ value: "+1 (206) 555-0142", matched: true }],
        company: "Example Realty",
        transactions: [],
        recentCommunication: [
          {
            id: "em-1",
            channel: "email",
            title: "571 Dale St — signed disclosures attached",
            occurredAt: "2026-08-01T10:00:00.000Z",
            matchedIdentifier: "pdorian@example.com",
          },
        ],
        sourceRecordPresent: true,
      },
    ],
    ...overrides,
  };
}

function stubApi(result: {
  success: boolean;
  view?: ContactCompareView | null;
  error?: string;
}) {
  const getCompareColumns = jest.fn().mockResolvedValue(result);
  (window as unknown as { api: unknown }).api = { contacts: { getCompareColumns } };
  return getCompareColumns;
}

async function renderScreen(
  result: Parameters<typeof stubApi>[0] = { success: true, view: makeView() },
  onClose = jest.fn(),
) {
  stubApi(result);
  const utils = render(
    <ContactCompareSources userId="u1" contactId="c-paul" onClose={onClose} />,
  );
  await waitFor(() => expect(screen.queryByTestId("compare-loading")).toBeNull());
  return { ...utils, onClose };
}

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api;
});

describe("the columns", () => {
  it("renders one column per linkId, contact first", async () => {
    await renderScreen();

    // CONTROL: drop a column from the map and this names the id that vanished.
    expect(screen.getByTestId(`compare-column-${CONTACT_LINK}`)).toBeTruthy();
    expect(screen.getByTestId(`compare-column-${OUTLOOK_LINK}`)).toBeTruthy();
    expect(
      [...document.querySelectorAll("[data-testid^='compare-column-']")].map((el) =>
        el.getAttribute("data-testid"),
      ),
    ).toEqual([`compare-column-${CONTACT_LINK}`, `compare-column-${OUTLOOK_LINK}`]);
  });

  it("marks only the contact's column as a linked record on the source side", async () => {
    await renderScreen();

    // CONTROL: drop the `kind === "source"` guard and the contact's column grows
    // a "linked record" tag, which would tell the user their own contact is one
    // of the records under question.
    expect(screen.queryByTestId(`compare-source-tag-${CONTACT_LINK}`)).toBeNull();
    expect(screen.getByTestId(`compare-source-tag-${OUTLOOK_LINK}`)).toBeTruthy();
  });

  it("renders all six rows on every column, including the empty ones", async () => {
    await renderScreen();

    // Founder decision, 2026-08-05: "Empty rows stay, blank, on source columns."
    // CONTROL: hide a row when its value is empty and the contact's Emails and
    // Company rows disappear, putting the two columns out of line.
    for (const linkId of [CONTACT_LINK, OUTLOOK_LINK]) {
      for (const field of ["name", "emails", "phone", "company", "transactions", "communication"]) {
        expect(screen.getByTestId(`compare-row-${field}-${linkId}`)).toBeTruthy();
      }
    }
  });

  it("writes 'none' in a cell the record has no value for", async () => {
    await renderScreen();

    // Paired with the structural assertion: the row exists AND reads "none".
    const emails = screen.getByTestId(`compare-row-emails-${CONTACT_LINK}`);
    // CONTROL: render an em dash, or nothing, and this goes red.
    expect(emails.textContent).toBe("none");
    expect(screen.getByTestId(`compare-row-company-${CONTACT_LINK}`).textContent).toBe("none");
  });
});

describe("founder decision D5", () => {
  it("a source record's Transactions cell reads 'not a contact yet'", async () => {
    await renderScreen();

    const source = screen.getByTestId(`compare-row-transactions-${OUTLOOK_LINK}`);
    // CONTROL: use the ordinary empty text and this reads "none" — which says
    // the record has no deals rather than that it is not a contact.
    expect(source.textContent).toBe("not a contact yet");
    // …and the contact's own column carries the real transaction, so the string
    // above cannot be passing because every column is empty.
    expect(screen.getByTestId(`compare-row-transactions-${CONTACT_LINK}`).textContent).toBe(
      "571 Dale St N",
    );
  });

  it("a source column's communication heading is tagged 'not linked', and the contact's is not", async () => {
    await renderScreen();

    // CONTROL: render the tag on every column and the first assertion goes red;
    // drop it entirely and the second does.
    expect(screen.queryByTestId(`compare-notlinked-${CONTACT_LINK}`)).toBeNull();
    expect(screen.getByTestId(`compare-notlinked-${OUTLOOK_LINK}`).textContent).toBe(
      "not linked",
    );
  });

  it("each column lists its own messages", async () => {
    await renderScreen();

    const contactComms = screen.getByTestId(`compare-row-communication-${CONTACT_LINK}`);
    const sourceComms = screen.getByTestId(`compare-row-communication-${OUTLOOK_LINK}`);

    expect(contactComms.querySelector("[data-testid='compare-comm-tx-2']")).toBeTruthy();
    expect(contactComms.querySelector("[data-testid='compare-comm-em-1']")).toBeNull();
    expect(sourceComms.querySelector("[data-testid='compare-comm-em-1']")).toBeTruthy();
  });
});

describe("marking", () => {
  it("marks the values the service marked, and nothing else", async () => {
    await renderScreen();

    // CONTROL: ignore `matched` and mark every value — the unmatched Outlook
    // address grows a badge and this goes red.
    expect(
      screen.getByTestId(`compare-row-phone-${OUTLOOK_LINK}`).textContent,
    ).toBe("+1 (206) 555-0142match");
    expect(screen.getByTestId(`compare-row-emails-${OUTLOOK_LINK}`).textContent).toBe(
      "pdorian@example.com",
    );
  });
});

describe("read-only", () => {
  it("offers no Unlink, no Confirm and no reject — only a close", async () => {
    const { onClose } = await renderScreen();

    // PR C is the read-only half. CONTROL: add PR D's controls early and each of
    // these goes red, which is what stops that landing unnoticed.
    expect(screen.queryByTestId(`compare-unlink-${OUTLOOK_LINK}`)).toBeNull();
    expect(screen.queryByTestId(`compare-unlink-${CONTACT_LINK}`)).toBeNull();
    expect(screen.queryByText("Confirm")).toBeNull();
    expect(screen.queryByText("Confirm & edit")).toBeNull();
    expect(screen.queryByText("Confirm all")).toBeNull();

    fireEvent.click(screen.getByTestId("compare-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("the header and the edge states", () => {
  it("shows the question and the reason sentence", async () => {
    await renderScreen();

    expect(screen.getByTestId("compare-title").textContent).toBe(
      "Is this the same Paul Dorian?",
    );
    expect(screen.getByTestId("compare-reason").textContent).toBe(
      "Both records list the phone number +1 (206) 555-0142, and the names match.",
    );
  });

  it("says there is nothing to compare when the service returns no view", async () => {
    await renderScreen({ success: true, view: null });

    expect(screen.getByTestId("compare-empty")).toBeTruthy();
    expect(document.querySelectorAll("[data-testid^='compare-column-']").length).toBe(0);
  });

  it("a failed load is NOT an empty one", async () => {
    await renderScreen({ success: false, error: "channel exploded" });

    // BACKLOG-1898's shape: a broken channel must not read as "this contact is
    // assembled from one record". CONTROL: collapse `failed` into the empty
    // branch and this reports the wrong thing to the user.
    expect(screen.getByTestId("compare-failed")).toBeTruthy();
    expect(screen.queryByTestId("compare-empty")).toBeNull();
  });

  it("says when a record has gone, using the words the card already uses", async () => {
    const view = makeView();
    view.columns[1] = {
      ...view.columns[1],
      sourceRecordPresent: false,
      name: null,
      emails: [],
      phones: [],
      company: null,
      recentCommunication: [],
    };
    await renderScreen({ success: true, view });

    // CONTROL: hide the column when its record is gone and a two-record contact
    // looks like a one-record contact — the invisibility this screen exists to
    // end.
    expect(screen.getByTestId(`compare-column-${OUTLOOK_LINK}`)).toBeTruthy();
    expect(screen.getByTestId(`compare-absent-${OUTLOOK_LINK}`).textContent).toBe(
      "This entry is no longer in that account.",
    );
  });
});
