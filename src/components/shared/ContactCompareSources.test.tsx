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

/**
 * ===========================================================================
 * BACKLOG-2502 R5 — FOUR CANDIDATES ON ONE SCREEN
 * ===========================================================================
 * The founder opened a contact with four possible duplicates and had no way to
 * answer three of them: the screen drew one candidate and the footer carried one
 * answer for the whole screen.
 *
 * Every assertion below names WHICH control belongs to WHICH record. A count of
 * four buttons would pass with four copies of the same candidate's control.
 */

const CANDIDATES = [
  { proposalId: "p-1", sourceType: "macos", sourceRecordId: "mac-11", displayName: "P. Dorian" },
  { proposalId: "p-2", sourceType: "outlook", sourceRecordId: "out-22", displayName: "Paul Dorian" },
  { proposalId: "p-3", sourceType: "google", sourceRecordId: "goo-33", displayName: "Paul Dorian" },
  { proposalId: "p-4", sourceType: "macos", sourceRecordId: "mac-44", displayName: "Paul D." },
] as const;

/** The key `getContactCompareColumns` builds for a candidate — its shape is pinned by the service suite. */
const candidateColumnId = (c: { sourceType: string; sourceRecordId: string }): string =>
  `compare-column-proposed:${c.sourceType}:${c.sourceRecordId}`;

/**
 * TRANSCRIBED FROM THE PRODUCER. `electron/services/__tests__/contactCompare.test.ts`
 * ("R5 — several candidates") builds this exact shape through the real writers
 * and the real driver: one `kind: "proposed"` column per candidate, in the
 * caller's order, keyed `proposed:<type>:<record>` and carrying `proposalId`.
 */
function makeFourCandidateView(count = CANDIDATES.length): ContactCompareView {
  const base = makeView();
  return {
    ...base,
    columns: [
      base.columns[0],
      ...CANDIDATES.slice(0, count).map((c) => ({
        linkId: `proposed:${c.sourceType}:${c.sourceRecordId}`,
        kind: "proposed" as const,
        columnLabel: "Outlook contacts",
        displayName: c.displayName,
        name: { value: c.displayName, matched: false },
        emails: [{ value: `${c.sourceRecordId}@example.com`, matched: false }],
        phones: [],
        company: null,
        transactions: [],
        recentCommunication: [],
        sourceRecordPresent: true,
        proposalId: c.proposalId,
      })),
    ],
  };
}

async function renderQueueRoute(
  view: ContactCompareView = makeFourCandidateView(),
) {
  const getCompareColumns = jest.fn().mockResolvedValue({ success: true, view });
  const confirmLink = jest.fn().mockResolvedValue({ success: true, linked: true });
  (window as unknown as { api: unknown }).api = {
    contacts: { getCompareColumns, confirmLink },
  };
  const handlers = {
    onClose: jest.fn(),
    onCandidateSame: jest.fn(),
    onCandidateDifferent: jest.fn(),
    onConfirmed: jest.fn(),
    onConfirmedAndEdit: jest.fn(),
    onRejected: jest.fn(),
  };
  const utils = render(
    <ContactCompareSources
      userId="u1"
      contactId="c-paul"
      proposalId="p-1"
      proposedSources={CANDIDATES.map((c) => ({
        sourceType: c.sourceType,
        sourceRecordId: c.sourceRecordId,
        proposalId: c.proposalId,
      }))}
      {...handlers}
    />,
  );
  await waitFor(() => expect(screen.queryByTestId("compare-loading")).toBeNull());
  return { ...utils, ...handlers };
}

describe("BACKLOG-2502 R5 — every candidate is answered on its own column", () => {
  it("gives each candidate its own two answers, INSIDE that candidate's column", async () => {
    await renderQueueRoute();

    // Identity, not arithmetic: the control for `p-3` must be inside the column
    // drawn for `goo-33`, and nowhere else.
    // CONTROL: key the buttons by column index, or pass one shared proposalId,
    // and these `within` lookups fail even though four buttons are on screen.
    for (const c of CANDIDATES) {
      const column = within(screen.getByTestId(candidateColumnId(c)));
      expect(column.getByTestId(`compare-candidate-different-${c.proposalId}`).textContent).toBe(
        "Not this person",
      );
      expect(column.getByTestId(`compare-candidate-same-${c.proposalId}`).textContent).toBe(
        "Same person",
      );
    }
  });

  it("answers ONLY the candidate whose control was pressed", async () => {
    const { onCandidateDifferent, onCandidateSame } = await renderQueueRoute();

    fireEvent.click(screen.getByTestId("compare-candidate-different-p-2"));

    // CONTROL: close over the wrong candidate (e.g. the `proposalId` prop, which
    // is `p-1` here) and this reads p-1 — the screen would answer a question the
    // user did not press.
    expect(onCandidateDifferent.mock.calls).toEqual([["p-2"]]);
    expect(onCandidateSame).not.toHaveBeenCalled();
  });

  it("puts no candidate control on the contact's column or on a linked record", async () => {
    const view = makeFourCandidateView();
    view.columns.splice(1, 0, makeView().columns[1]); // a linked Outlook record
    await renderQueueRoute(view);

    // CONTROL: gate the block on `onCandidateDifferent` alone rather than on
    // `kind === "proposed"` and the contact's own column offers to reject itself.
    expect(
      within(screen.getByTestId(`compare-column-${CONTACT_LINK}`)).queryByText("Not this person"),
    ).toBeNull();
    expect(
      within(screen.getByTestId(`compare-column-${OUTLOOK_LINK}`)).queryByText("Not this person"),
    ).toBeNull();
    // ...and the linked record keeps ITS OWN word for its own act.
    expect(
      within(screen.getByTestId(`compare-column-${OUTLOOK_LINK}`)).queryByText("Same person"),
    ).toBeNull();
  });

  it("draws no candidate control for a candidate it cannot name", async () => {
    const view = makeFourCandidateView(1);
    view.columns[1] = { ...view.columns[1], proposalId: undefined };
    await renderQueueRoute(view);

    // A button that cannot say which proposal it answers must not be drawn.
    // CONTROL: drop the `column.proposalId` guard and this renders a control
    // whose press names `undefined`.
    expect(screen.queryByTestId("compare-candidate-different-undefined")).toBeNull();
    expect(screen.queryByText("Not this person")).toBeNull();
  });

  it("stands the footer's single answer down once several candidates are on screen", async () => {
    await renderQueueRoute();

    // A footer button says "this one", and with four on screen it cannot say
    // which. CONTROL: drop `!answersLiveOnColumns` from the footer's condition
    // and `Different people` sits under four candidates meaning one of them.
    expect(screen.queryByTestId("compare-footer")).toBeNull();
    expect(screen.queryByTestId("compare-reject-proposal")).toBeNull();
    expect(screen.queryByTestId("compare-confirm")).toBeNull();
  });

  it("keeps the footer exactly as it was for a single candidate", async () => {
    await renderQueueRoute(makeFourCandidateView(1));

    // The screen rounds 1-4 built and the founder approved. CONTROL: gate the
    // footer on `candidateCount > 0` instead of `> 1` and this disappears.
    expect(screen.getByTestId("compare-footer")).toBeTruthy();
    expect(screen.getByTestId("compare-reject-proposal")).toBeTruthy();
    expect(screen.getByTestId("compare-confirm")).toBeTruthy();
    expect(screen.getByTestId("compare-confirm-edit")).toBeTruthy();
  });

  it("keeps the footer on the contact route, which has no candidates at all", async () => {
    await renderDeciding();

    // Control 4's other half: nothing about R5 may reach the contact-row path.
    expect(screen.getByTestId("compare-footer")).toBeTruthy();
    expect(screen.getByTestId("compare-confirm")).toBeTruthy();
    expect(screen.getByTestId(`compare-unlink-${OUTLOOK_LINK}`).textContent).toBe("Unlink");
  });
});

describe("BACKLOG-2502 R5 — the column strip scrolls, the screen does not", () => {
  it("pins the CONTACT's column as a direct child of the one sideways scroller", async () => {
    await renderQueueRoute();

    const strip = screen.getByTestId("compare-columns");
    const contactColumn = screen.getByTestId(`compare-column-${CONTACT_LINK}`);

    // THE MECHANISM, not a class list: `position: sticky` resolves against the
    // nearest scrolling ancestor, so the pinned column must be a DIRECT child of
    // the element that scrolls. CONTROL: wrap the columns in an inner div — the
    // obvious way to add a divider later — and every class below is still
    // present while the column no longer sticks. This is the assertion that goes
    // red for that.
    expect(contactColumn.parentElement).toBe(strip);
    expect(strip.className).toContain("sm:overflow-x-auto");
    expect(contactColumn.className).toContain("sm:sticky");
    expect(contactColumn.className).toContain("sm:left-0");
    // Opaque, or the candidates scroll visibly under the contact's own values.
    expect(contactColumn.className).toContain("bg-white");

    // It is the contact's column that is pinned — by identity, not by position
    // in a class list. CONTROL: pin `index === columns.length - 1` and this
    // fails while four sticky candidates look fine in a screenshot.
    const view = makeFourCandidateView();
    expect(view.columns[0].kind).toBe("contact");
    for (const c of CANDIDATES) {
      expect(screen.getByTestId(candidateColumnId(c)).className).not.toContain("sticky");
    }
  });

  it("scrolls sideways in exactly one place, and it is not the page", async () => {
    await renderQueueRoute();

    const root = screen.getByTestId("contact-compare-screen");
    const strip = screen.getByTestId("compare-columns");

    // CONTROL: move `overflow-x-auto` up onto the panel (the quick fix when a
    // column is clipped) and this fails — the sideways scroll would then be the
    // whole screen's, which is what the founder asked us not to build.
    expect([...root.querySelectorAll('[class*="overflow-x"]')]).toEqual([strip]);
    // The frame clips what the strip does not scroll, so nothing escapes it.
    expect(root.className).toContain("overflow-hidden");
  });
});
