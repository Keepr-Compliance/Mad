/**
 * =============================================================================
 * BACKLOG-3376 — THE DEAL WIZARD SAYS WHAT IT SAVED THAT NO EMAIL CAN COME FROM
 * =============================================================================
 * The same message the Clients & Contacts card raises, on the other surface that
 * imports a contact, differing in one word: this screen ADDED the person rather
 * than imported them.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS HALF IS LOAD-BEARING ON ITS OWN
 * -----------------------------------------------------------------------------
 * The control gap this item was built around was measured twice — an
 * unconditional `notify?.info(...)` in BOTH success branches left both
 * BACKLOG-3354 suites at 15 passed / 15, because their helper queries
 * `notification-error` and `NotificationToast` builds its testid from the
 * notification TYPE. Both of those measurements then positively controlled the
 * CARD half only; the wizard's helper was assumed to share the defect rather
 * than shown to (SR review `8c66f8e5`, Issue #3).
 *
 * So the HARNESS test below is not boilerplate here. It is the only thing that
 * makes this file's "0 info toasts" assertions mean anything, and it is what
 * closes that asymmetry.
 *
 * Fixtures follow `ContactAssignmentStep.importFailureToast-3354.test.tsx`.
 * Wording is FOUNDER CONFIRMS AT END-OF-A TEST.
 */
import React, { useContext, useEffect } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import ContactAssignmentStep from "./ContactAssignmentStep";
import { NotificationProvider, NotificationContext } from "../../contexts/NotificationContext";
import type { Contact } from "../../../electron/types/models";

jest.mock("../../services", () => ({
  settingsService: { getContactAutoRoleEnabled: jest.fn().mockResolvedValue(false) },
}));

const SHA = "89cb1a1d9";

/** The founder's real shape, in fictional form: a space inside the address. */
const BAD_ONE = "casey phone@example.com";
const BAD_TWO = ["Casey@ Example.com", "noatsign.example.com"];

const TEXT_ONE =
  `Casey Phone was added, but "${BAD_ONE}" isn't a valid email address. ` +
  `Emails from it won't be linked to your transactions. ` +
  `Open Casey Phone in your contacts and correct the address.`;
const TEXT_TWO =
  `Casey Phone was added, but 2 of their addresses aren't valid email addresses: ` +
  `"Casey@ Example.com" and "noatsign.example.com". ` +
  `Emails from them won't be linked to your transactions. ` +
  `Open Casey Phone in your contacts and correct them.`;
/** BACKLOG-3354's (b) message, which this one must never displace. */
const TEXT_3354_B = "Casey Phone was saved, but wasn't added. Find them in the list and add them again.";

const external = {
  id: "ext-1",
  user_id: "user-123",
  name: "Casey Phone",
  display_name: "Casey Phone",
  email: BAD_ONE,
  phone: "555-0001",
  source: "contacts_app",
  externalRecordId: "AB-1",
  externalSourceType: "macos",
  isFromDatabase: false,
  is_message_derived: true,
  created_at: "2024-02-01T00:00:00Z",
  updated_at: "2024-02-01T00:00:00Z",
} as unknown as Contact;

const savedCasey = {
  id: "db-1",
  user_id: "user-123",
  name: "Casey Phone",
  display_name: "Casey Phone",
  email: "casey@example.com",
  phone: null,
  source: "contacts_app",
  is_message_derived: false,
  created_at: "2024-02-01T00:00:00Z",
  updated_at: "2024-02-01T00:00:00Z",
} as unknown as Contact;

const refresh = jest.fn();

function Harness(): React.ReactElement {
  const [selected, setSelected] = React.useState<string[]>([]);
  return (
    <NotificationProvider>
      <ContactAssignmentStep
        step={2}
        contactAssignments={{}}
        selectedContactIds={selected}
        onSelectedContactIdsChange={setSelected}
        onAssignContact={jest.fn()}
        onRemoveContact={jest.fn()}
        userId="user-123"
        transactionType="purchase"
        propertyAddress="123 Main St"
        contacts={[]}
        contactsLoading={false}
        contactsError={null}
        onRefreshContacts={jest.fn()}
        onRefreshBothLists={refresh}
        externalContacts={[external]}
        externalContactsLoading={false}
      />
    </NotificationProvider>
  );
}

const infoToasts = () => screen.queryAllByTestId("notification-info");
const errorToasts = () => screen.queryAllByTestId("notification-error");

async function pressAdd() {
  const user = userEvent.setup();
  render(<Harness />);
  const row = screen.getAllByTestId("contact-row").find((r) => r.textContent?.includes("Casey Phone"));
  if (!row) throw new Error("no Casey Phone row");
  await user.click(within(row).getByTestId("contact-row-add-button"));
  await waitFor(() => expect(window.api.contacts.import).toHaveBeenCalledTimes(1));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 40));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  refresh.mockReset();
  refresh.mockResolvedValue(undefined);
});

describe("BACKLOG-3376 deal wizard (+ Add): what was saved that no email can come from", () => {
  it("HARNESS: an INFO toast raised through the provider is visible to these queries", async () => {
    // No production break. The positive control for THIS surface's helper —
    // the half that the plan's and the SR review's measurements both left
    // uncontrolled. If this goes red, every "0 info toasts" below is vacuous.
    function Raise() {
      const n = useContext(NotificationContext);
      useEffect(() => {
        n?.notify.info("harness toast");
      }, [n]);
      return null;
    }
    render(
      <NotificationProvider>
        <Raise />
      </NotificationProvider>,
    );
    expect(await screen.findByTestId("notification-info")).toHaveTextContent("harness toast");
    expect(screen.queryAllByTestId("notification-error")).toHaveLength(0);
  });

  it("C1: one unmatchable address -> exactly one info toast naming it and the linking consequence", async () => {
    // Breaks caught: no message at all on this surface (the card wired and the
    // wizard forgotten — the shape the item's brief calls out by name); the
    // address not named; the linking sentence missing; an `error` toast.
    jest
      .mocked(window.api.contacts.import)
      .mockResolvedValue({ success: true, contacts: [savedCasey], unmatchableEmails: [BAD_ONE] });
    await pressAdd();
    expect(infoToasts()).toHaveLength(1);
    expect(within(infoToasts()[0]).getByText(TEXT_ONE)).toBeInTheDocument();
    expect(infoToasts()[0]).toHaveTextContent(BAD_ONE);
    expect(infoToasts()[0]).toHaveTextContent("won't be linked to your transactions");
    expect(errorToasts()).toHaveLength(0);
    // The add still worked: this is information, not a failure.
    await waitFor(() => expect(screen.getByTestId("added-chip-db-1")).toBeInTheDocument());
  });

  it("C6: this surface says ADDED", async () => {
    // Break caught: one shared string for both surfaces. This screen adds a
    // contact to a deal; it does not "import" one.
    jest
      .mocked(window.api.contacts.import)
      .mockResolvedValue({ success: true, contacts: [savedCasey], unmatchableEmails: [BAD_ONE] });
    await pressAdd();
    expect(infoToasts()[0]).toHaveTextContent("Casey Phone was added, but");
    expect(infoToasts()[0]).not.toHaveTextContent("was imported");
  });

  it("C10: two unmatchable addresses -> both named, in the source's own casing and order", async () => {
    // Breaks caught: only the first reported; a count with no list; the
    // lowercased stored form; the list joined without "and".
    jest
      .mocked(window.api.contacts.import)
      .mockResolvedValue({ success: true, contacts: [savedCasey], unmatchableEmails: BAD_TWO });
    await pressAdd();
    expect(infoToasts()).toHaveLength(1);
    expect(within(infoToasts()[0]).getByText(TEXT_TWO)).toBeInTheDocument();
    for (const address of BAD_TWO) expect(infoToasts()[0]).toHaveTextContent(address);
  });

  it("C2: a successful add with nothing unmatchable -> NO message", async () => {
    // Break caught: the message raised on every add — invisible to the entire
    // pre-existing control set (plan P2, SR S3).
    jest.mocked(window.api.contacts.import).mockResolvedValue({ success: true, contacts: [savedCasey] });
    await pressAdd();
    expect(infoToasts()).toHaveLength(0);
    expect(errorToasts()).toHaveLength(0);
    await waitFor(() => expect(screen.getByTestId("added-chip-db-1")).toBeInTheDocument());
  });

  it("C2-empty: an EMPTY array is silence, not an empty toast", async () => {
    // Break caught: the renderer checking the key's presence rather than a
    // non-empty array.
    jest
      .mocked(window.api.contacts.import)
      .mockResolvedValue({ success: true, contacts: [savedCasey], unmatchableEmails: [] });
    await pressAdd();
    expect(infoToasts()).toHaveLength(0);
  });

  it(`C3 INVENTED@${SHA}: a FAILED add shows 3354's message and NOT this one`, async () => {
    // INVENTED fixture: the shipped handler never produces it — the field is
    // spread on the SUCCESS return only. It pins the RENDERER half of the guard
    // on its own, independently of the handler half.
    //
    // Break caught: the message raised outside `if (result.success &&
    // importedContact)` — a user whose add FAILED would be told to go and
    // correct an address on a contact that was never saved.
    jest.mocked(window.api.contacts.import).mockResolvedValue({
      success: false,
      error: "disk I/O error",
      savedContactIds: ["db-1"],
      unmatchableEmails: [BAD_ONE],
    });
    await pressAdd();
    expect(errorToasts()).toHaveLength(1);
    expect(within(errorToasts()[0]).getByText(TEXT_3354_B)).toBeInTheDocument();
    expect(infoToasts()).toHaveLength(0);
  });

  it("C7: the refresh rejects -> the message is still shown", async () => {
    // Break caught: the `notify?.info` moved below `await onRefreshBothLists()`.
    // The prop is typed `() => Promise<void>`, nothing forbids it rejecting,
    // and the caller's catch only logs — so a rejected refresh would swallow
    // the message entirely. BACKLOG-3354's C-b-reject is the precedent for this
    // shape on this surface.
    refresh.mockRejectedValueOnce(new Error("refresh failed"));
    jest
      .mocked(window.api.contacts.import)
      .mockResolvedValue({ success: true, contacts: [savedCasey], unmatchableEmails: [BAD_ONE] });
    await pressAdd();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(infoToasts()).toHaveLength(1);
    expect(within(infoToasts()[0]).getByText(TEXT_ONE)).toBeInTheDocument();
  });
});
