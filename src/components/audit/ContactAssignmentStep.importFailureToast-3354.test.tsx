/**
 * BACKLOG-3354 — A FAILED "+ Add" IN THE DEAL WIZARD IS SHOWN.
 *
 * Before this item a failed `contacts:import` from the wizard's contact step
 * cleared the row's importing state and showed nothing: `ContactSearchList`'s
 * catch only logs. `ContactAssignmentStep.handleImportContact` now raises the
 * app's existing toast and tells two shapes apart by what the main process
 * returns:
 *
 *   (a) nothing saved — `success: false` without `savedContactIds`, a rejected
 *       invoke, or `success: true` with no contact → one "Couldn't add …" toast.
 *   (b) saved, then a post-commit read failed — `success: false` WITH
 *       `savedContactIds` → one "… was saved, but wasn't added" toast, raised
 *       BEFORE both halves are re-read; nothing is selected.
 *
 * Rendered INSIDE `NotificationProvider`, so "0 toasts" is a real observation.
 * Each test names the wrong implementation that turns it red; every one of
 * those mutations was run on the shipped code (pm_comments, BACKLOG-3354
 * implementation handoff). Wording is FOUNDER CONFIRMS AT END-OF-A TEST.
 */
import React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import ContactAssignmentStep from "./ContactAssignmentStep";
import { NotificationProvider } from "../../contexts/NotificationContext";
import type { Contact } from "../../../electron/types/models";

jest.mock("../../services", () => ({
  settingsService: { getContactAutoRoleEnabled: jest.fn().mockResolvedValue(false) },
}));

const TEXT_A = "Couldn't add Casey Phone — nothing was saved.";
const TEXT_B = "Casey Phone was saved, but wasn't added. Find them in the list and add them again.";
const SHA = "7b4828906";

/** An address-book row, not in the saved half, so "+ Add" imports it. */
const external = {
  id: "ext-1",
  user_id: "user-123",
  name: "Casey Phone",
  display_name: "Casey Phone",
  email: "casey@example.com",
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

const toasts = () => screen.queryAllByTestId("notification-error");

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

describe("BACKLOG-3354 deal wizard (+ Add): a failed import is shown", () => {
  it("C-a: nothing saved -> exactly one (a) toast, without the raw error, nothing added", async () => {
    // Breaks caught: no toast at all (the pre-3354 code); one generic message
    // for both shapes; raw `result.error` in the text; "treat any failure as
    // saved"; a second toast in a surrounding catch; a toast whenever the
    // saved half is empty.
    jest.mocked(window.api.contacts.import).mockResolvedValue({ success: false, error: "database is locked" });
    await pressAdd();
    expect(toasts()).toHaveLength(1);
    expect(within(toasts()[0]).getByText(TEXT_A)).toBeInTheDocument();
    expect(toasts()[0]).not.toHaveTextContent("database is locked");
    expect(screen.getByTestId("added-count")).toHaveTextContent("0");
  });

  it("C-b: saved ids -> exactly one (b) toast, both halves re-read once, nothing added", async () => {
    // Breaks caught: (b) without the refresh; one generic message for both
    // shapes; a second toast in a surrounding catch; a toast only in
    // ContactSearchList's catch.
    jest
      .mocked(window.api.contacts.import)
      .mockResolvedValue({ success: false, error: "disk I/O error", savedContactIds: ["db-1"] });
    await pressAdd();
    expect(toasts()).toHaveLength(1);
    expect(within(toasts()[0]).getByText(TEXT_B)).toBeInTheDocument();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("added-count")).toHaveTextContent("0");
  });

  it("C-b-reject: the refresh rejects -> still exactly one (b) toast", async () => {
    // Break caught: the (b) toast raised AFTER `await onRefreshBothLists()` —
    // a rejected refresh skips it, and the caller's catch only logs.
    refresh.mockRejectedValueOnce(new Error("refresh failed"));
    jest
      .mocked(window.api.contacts.import)
      .mockResolvedValue({ success: false, error: "disk I/O error", savedContactIds: ["db-1"] });
    await pressAdd();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(toasts()).toHaveLength(1);
    expect(within(toasts()[0]).getByText(TEXT_B)).toBeInTheDocument();
  });

  it("C-r: a rejected invoke -> exactly one (a) toast", async () => {
    // Breaks caught: no toast on a rejected invoke; a second toast in a
    // surrounding catch.
    jest
      .mocked(window.api.contacts.import)
      .mockRejectedValue(new Error("No handler registered for 'contacts:import'"));
    await pressAdd();
    expect(toasts()).toHaveLength(1);
    expect(within(toasts()[0]).getByText(TEXT_A)).toBeInTheDocument();
  });

  it(`C-c INVENTED@${SHA}: success with no contact -> exactly one (a) toast, nothing added`, async () => {
    // INVENTED fixture: no live producer. Only a legacy `is_imported = 0` row
    // deleted between list load and press returns `success: true, contacts: []`.
    // Break caught: the (a) toast raised only when `success === false`.
    jest.mocked(window.api.contacts.import).mockResolvedValue({ success: true, contacts: [] });
    await pressAdd();
    expect(toasts()).toHaveLength(1);
    expect(within(toasts()[0]).getByText(TEXT_A)).toBeInTheDocument();
    expect(screen.getByTestId("added-count")).toHaveTextContent("0");
  });

  it("C-s: success with an EMPTY saved half -> no toast, chip added", async () => {
    // Break caught: a toast whenever the saved half is empty (a new user with
    // no saved contacts would see an error on every successful add).
    jest.mocked(window.api.contacts.import).mockResolvedValue({ success: true, contacts: [savedCasey] });
    await pressAdd();
    expect(toasts()).toHaveLength(0);
    await waitFor(() => expect(screen.getByTestId("added-chip-db-1")).toBeInTheDocument());
  });
});
