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
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
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
    isConfirmed: false,
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

/**
 * A mount WITH the decide handlers — how `Contacts.tsx` wires it (PR D).
 *
 * Returns the stubs so each test can name the exact call it expects, and the
 * confirm stub so an outcome can be shaped per test.
 */
async function renderDeciding(
  opts: {
    view?: ContactCompareView | null;
    confirmOutcome?: { ok: boolean; error?: string; confirmed: number; alreadyConfirmed: number; proposalsResolved: number };
    unlinkingLinkId?: string | null;
  } = {},
) {
  const view = opts.view === undefined ? makeView() : opts.view;
  const getCompareColumns = jest.fn().mockResolvedValue({ success: true, view });
  const confirmSources = jest.fn().mockResolvedValue(
    opts.confirmOutcome ?? { ok: true, confirmed: 2, alreadyConfirmed: 0, proposalsResolved: 1 },
  );
  (window as unknown as { api: unknown }).api = {
    contacts: { getCompareColumns, confirmSources },
  };
  const handlers = {
    onClose: jest.fn(),
    onUnlinkSource: jest.fn(),
    onConfirmed: jest.fn(),
    onConfirmedAndEdit: jest.fn(),
  };
  const utils = render(
    <ContactCompareSources
      userId="u1"
      contactId="c-paul"
      unlinkingLinkId={opts.unlinkingLinkId ?? null}
      {...handlers}
    />,
  );
  await waitFor(() => expect(screen.queryByTestId("compare-loading")).toBeNull());
  return { ...utils, ...handlers, getCompareColumns, confirmSources };
}

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api;
});

describe("per-column Unlink", () => {
  it("sits on every source column and on no other", async () => {
    await renderDeciding();

    // CONTROL: drop the `kind === "source"` guard and the contact's own column
    // grows an Unlink — the founder's "we can't unlink a contact from itself".
    expect(
      [...document.querySelectorAll("[data-testid^='compare-unlink-']")].map((el) =>
        el.getAttribute("data-testid"),
      ),
    ).toEqual([`compare-unlink-${OUTLOOK_LINK}`]);
    expect(screen.queryByTestId(`compare-unlink-${CONTACT_LINK}`)).toBeNull();
  });

  /**
   * BACKLOG-2502 R6 — THE CONTACT ROUTE'S PER-COLUMN CONTROL, PINNED BY WHAT IT
   * IS RATHER THAN BY WHAT IT IS CALLED.
   *
   * R5 briefly gave candidate columns their own decision buttons and was
   * reverted on the founder's decision: the compare screen asks about ONE record
   * and the decision belongs in its footer. The risk that leaves behind is a
   * later change reintroducing a column-level decision under a new name, or
   * quietly harmonising this one's word with the queue's.
   *
   * Counting BUTTONS rather than test ids is what makes that catchable: a
   * renamed control is still a button, and a third control appearing beside this
   * one changes the count even if nothing existing is touched.
   */
  it("is the source column's ONLY control, and it reads Unlink", async () => {
    await renderDeciding();

    const sourceButtons = within(
      screen.getByTestId(`compare-column-${OUTLOOK_LINK}`),
    ).getAllByRole("button");
    expect(sourceButtons.map((b) => b.textContent)).toEqual(["Unlink"]);

    // The contact's own column decides nothing about itself, in any wording.
    expect(
      within(screen.getByTestId(`compare-column-${CONTACT_LINK}`)).queryAllByRole("button"),
    ).toEqual([]);
  });

  it("calls the caller's unlink with the link id, and nothing else", async () => {
    const { onUnlinkSource, confirmSources } = await renderDeciding();

    fireEvent.click(screen.getByTestId(`compare-unlink-${OUTLOOK_LINK}`));

    // The SHIPPED unlink, reached through Contacts.tsx. CONTROL: give the
    // compare screen its own unlink call and this stops being the only write.
    expect(onUnlinkSource).toHaveBeenCalledWith(OUTLOOK_LINK);
    expect(confirmSources).not.toHaveBeenCalled();
  });

  it("says which record is going while it goes", async () => {
    await renderDeciding({ unlinkingLinkId: OUTLOOK_LINK });

    const button = screen.getByTestId(`compare-unlink-${OUTLOOK_LINK}`);
    expect(button.textContent).toBe("Unlinking…");
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("closes when the last source record has gone", async () => {
    // The service returns no view once nothing is left to compare. The mock's
    // own footer: "unlink them all and the contact stands alone."
    // CONTROL: keep the screen open on an empty reload and this goes red,
    // leaving the user on a screen comparing one thing.
    const { onClose } = await renderDeciding({ view: null });

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

describe("the footer", () => {
  it("writes the confirmation and hands back to the caller", async () => {
    const { confirmSources, onConfirmed, onConfirmedAndEdit } = await renderDeciding();

    fireEvent.click(screen.getByTestId("compare-confirm"));

    await waitFor(() => expect(onConfirmed).toHaveBeenCalledTimes(1));
    expect(confirmSources).toHaveBeenCalledWith("u1", "c-paul");
    expect(onConfirmedAndEdit).not.toHaveBeenCalled();
  });

  it("Confirm & edit takes the other exit", async () => {
    const { confirmSources, onConfirmed, onConfirmedAndEdit } = await renderDeciding();

    fireEvent.click(screen.getByTestId("compare-confirm-edit"));

    await waitFor(() => expect(onConfirmedAndEdit).toHaveBeenCalledTimes(1));
    expect(confirmSources).toHaveBeenCalledTimes(1);
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it("reads 'Confirm all' once there are three columns", async () => {
    const view = makeView();
    view.columns = [...view.columns, { ...view.columns[1], linkId: "link-android" }];
    await renderDeciding({ view });

    // CONTROL: one label for both and this goes red. The mock changes the word
    // at three because "Confirm" beside three columns reads as "confirm this one".
    expect(screen.getByTestId("compare-confirm").textContent).toBe("Confirm all");
  });

  it("a failed confirm does NOT read as a quiet success", async () => {
    const { onConfirmed } = await renderDeciding({
      confirmOutcome: { ok: false, error: "That contact is no longer available.", confirmed: 0, alreadyConfirmed: 0, proposalsResolved: 0 },
    });

    fireEvent.click(screen.getByTestId("compare-confirm"));

    // CONTROL: close on every outcome and the user is returned to the list
    // believing they confirmed something they did not.
    await waitFor(() =>
      expect(screen.getByTestId("compare-confirm-error").textContent).toBe(
        "That contact is no longer available.",
      ),
    );
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it("offers no reject — Unlink is the only rejection", async () => {
    await renderDeciding();

    // The founder removed the footer reject: "Unlink sits on the record it
    // removes." CONTROL: add one back and this goes red.
    expect(screen.queryByTestId("compare-reject")).toBeNull();
    expect(screen.getByTestId("compare-confirm")).toBeTruthy();
  });

  it("states the decision instead of re-offering it once confirmed", async () => {
    await renderDeciding({ view: { ...makeView(), isConfirmed: true } });

    expect(screen.getByTestId("compare-already-confirmed")).toBeTruthy();
    expect(screen.queryByTestId("compare-confirm")).toBeNull();
  });

  it("nothing is written by opening or by closing", async () => {
    const { confirmSources, onClose } = await renderDeciding();

    fireEvent.click(screen.getByTestId("compare-close"));

    // BACKLOG-2273 does not exist: a verdict may only ever be the direct result
    // of a human pressing Confirm. CONTROL: confirm on load or on unmount and
    // this goes red.
    expect(confirmSources).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
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

describe("the decide controls are OPT-IN", () => {
  /**
   * THIS TEST WAS "PR C IS READ-ONLY" AND ITS MEANING HAS CHANGED — deliberately,
   * and it is not a quiet erosion.
   *
   * PR D adds `Unlink` and the footer, but only when the caller passes the
   * handlers. A mount without them renders exactly what PR C rendered. That is
   * what keeps PR G's three transaction callers, and every future read-only
   * mount, unchanged until they choose to opt in — and it is why the assertions
   * below still hold verbatim rather than being deleted.
   */
  it("offers no Unlink, no Confirm and no reject when the caller passes no handlers", async () => {
    const { onClose } = await renderScreen();

    // CONTROL: render the footer or the Unlink unconditionally and each of these
    // goes red — which is what stops PR D leaking onto surfaces that did not ask.
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
