/**
 * BACKLOG-2631 — WHAT THE SHARED HOOK IS AND IS NOT ALLOWED TO FETCH.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS SEPARATELY FROM THE CONTAINER CONTROLS
 * ===========================================================================
 * `ContactAssignmentStep.oneRefreshPath-2631.test.tsx` drives both transaction
 * surfaces end to end and asserts `contacts:get-available` call counts through
 * them. That is the right level for "the reported defect is fixed", and the
 * wrong level for the guard underneath it: a container only ever calls
 * `triggerLazyLoad` once, from a mount effect, so a container test cannot
 * distinguish "the guard holds" from "nobody asked twice". Both look like one
 * fetch.
 *
 * So the guard is measured where it can be pushed: by calling it.
 *
 * ===========================================================================
 * WHAT THE GUARD IS, AND WHY IT IS NOT THE ONE THAT WAS DELETED
 * ===========================================================================
 * The two wizard mount guards (`useAuditContactAssignment:111`,
 * `EditContactsModal:839`) are gone. They refused to refetch for the life of the
 * mount, which is what left a merged-away record on screen.
 *
 * What this hook keeps refuses only a DUPLICATE INITIAL LOAD, and
 * `refreshBothLists` bypasses it rather than clearing it — so there is no window
 * in which the de-dup is down, and nothing can refuse an explicit refresh. The
 * two properties are asserted here as a pair, because either one alone is
 * satisfiable by the wrong implementation: a hook with no guard passes "a
 * refresh always fetches", and a hook with the OLD guard passes "repeated lazy
 * loads fetch once".
 *
 * ===========================================================================
 * WHY THE ADDRESS BOOK IS WORTH A GUARD AT ALL
 * ===========================================================================
 * `contacts:get-available` reads the whole address book. BACKLOG-2633 took it
 * from 7.4s at the founder's corpus — 91s at a realistic mailbox — to ~11ms and
 * flat, which is what made removing the mount guards safe. "Safe to ask again"
 * is not "ask on every render": a correct list that costs forty queries is a new
 * defect, and it is one no assertion about rendered rows can see, because the
 * list is identical either way.
 */

import React from "react";
import { act, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { useContactDirectory } from "./useContactDirectory";
import type { Contact } from "../../../electron/types/models";

const USER_ID = "user-2631";

const savedContact = {
  id: "d41f8c07-5b62-4a9e-8f13-6c0a2b7e9d54",
  user_id: USER_ID,
  name: "Bianca Okafor",
  display_name: "Bianca Okafor",
  email: "bianca.okafor@example.com",
  phone: "+15035550130",
  source: "manual",
  created_at: "2026-08-01T09:00:00Z",
  updated_at: "2026-08-01T09:00:00Z",
} as unknown as Contact;

/**
 * As `contacts:get-available` emits it — the shape the BACKLOG-2510/2511 suites
 * pin, identity fields included.
 */
const addressBookRecord = {
  id: "9a2e6d18-7c34-4b50-a6f2-1d8b3e5c7049",
  name: "Petra Lindqvist",
  display_name: "Petra Lindqvist",
  email: "p.lindqvist@example.net",
  phone: "+15035550144",
  allEmails: ["p.lindqvist@example.net"],
  allPhones: ["+15035550144"],
  source: "contacts_app",
  isFromDatabase: false,
  externalRecordId: "AB-RECORD-6620",
  externalSourceType: "macos",
} as unknown as Contact;

type Harness = ReturnType<typeof useContactDirectory>;

let latest: Harness;

/**
 * Renders the hook and exposes it. The rendered output is real DOM rather than a
 * bare ref so that `savedIds` / `externalIds` read what a consumer would read —
 * an ID SET, never a count.
 */
function Harness({
  autoLoadSaved,
  autoLoadExternal,
  propertyAddress,
}: {
  autoLoadSaved?: boolean;
  autoLoadExternal?: boolean;
  propertyAddress?: string;
}): React.ReactElement {
  const directory = useContactDirectory({
    userId: USER_ID,
    propertyAddress,
    autoLoadSaved,
    autoLoadExternal,
  });
  latest = directory;
  return (
    <div>
      <span data-testid="saved">
        {directory.contacts.map((c) => c.id).sort().join(",")}
      </span>
      <span data-testid="external">
        {directory.externalContacts.map((c) => c.id).sort().join(",")}
      </span>
      <span data-testid="error">{directory.contactsError ?? ""}</span>
    </div>
  );
}

const idsIn = (testId: string): string[] => {
  const text = screen.getByTestId(testId).textContent ?? "";
  return text === "" ? [] : text.split(",");
};

const availableCalls = () =>
  jest.mocked(window.api.contacts.getAvailable).mock.calls.length;
const getAllCalls = () => jest.mocked(window.api.contacts.getAll).mock.calls.length;

beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(window.api.contacts.getAll)
    .mockResolvedValue({ success: true, contacts: [savedContact] });
  jest
    .mocked(window.api.contacts.getSortedByActivity)
    .mockResolvedValue({ success: true, contacts: [savedContact] });
  jest
    .mocked(window.api.contacts.getAvailable)
    .mockResolvedValue({ success: true, contacts: [addressBookRecord] });
});

/** Let every settled promise and every React commit land. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("useContactDirectory — fetch discipline (BACKLOG-2631)", () => {
  /**
   * CONTROL — REPEATED LAZY LOADS COST ONE READ.
   *
   * `triggerLazyLoad` is idempotent by contract: the audit wizard calls it on
   * every transition into step 2, and `Screen2Overlay` calls it from an effect.
   * Ten calls is the stand-in for a user stepping back and forth, or for an
   * effect whose dependency identity churned.
   *
   * OBSERVED RED: delete the `externalLoadedRef.current || externalInFlightRef.current`
   * check from `loadExternalContacts` and this reads 10.
   */
  it("reads the address book ONCE however many times the lazy load is triggered", async () => {
    render(<Harness autoLoadSaved={false} autoLoadExternal={false} />);
    expect(availableCalls()).toBe(0);

    await act(async () => {
      latest.triggerLazyLoad();
    });
    await settle();

    for (let i = 0; i < 9; i += 1) {
      await act(async () => {
        latest.triggerLazyLoad();
      });
    }
    await settle();

    expect(availableCalls()).toBe(1);
    expect(getAllCalls()).toBe(1);
    expect(idsIn("external")).toEqual([addressBookRecord.id]);
    expect(idsIn("saved")).toEqual([savedContact.id]);
  });

  /**
   * CONTROL — AND THE GUARD CANNOT REFUSE A REFRESH. THIS IS THE WHOLE ITEM.
   *
   * The deleted wizard guards would have made every one of these a no-op after
   * the first. Asserted alongside the test above and not instead of it: a hook
   * with NO guard passes this one and fails that one, which is how the pair
   * pins the property rather than half of it.
   *
   * OBSERVED RED: add `if (externalLoadedRef.current) return [];` at the top of
   * `refreshBothLists` — the shape the two deleted guards had — and this reads 1.
   */
  it("refreshes every time it is asked, bypassing that guard", async () => {
    render(<Harness />);
    await settle();
    expect(availableCalls()).toBe(1);

    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await latest.refreshBothLists();
      });
    }

    expect(availableCalls()).toBe(4);
    expect(getAllCalls()).toBe(4);
  });

  /**
   * CONTROL — A FAILED FIRST READ IS RETRIED, NOT SEALED IN.
   *
   * The guard is set on SUCCESS, and this is why. A flag claimed before the
   * fetch and never released turns one transient failure into an address-book
   * half that stays empty for the life of the mount — the picker then quietly
   * offers nothing to import and looks like an empty address book rather than a
   * failed read.
   *
   * OBSERVED RED: set `externalLoadedRef.current = true` unconditionally in
   * `loadExternalContacts` and the second set is still empty.
   */
  it("retries the address book on the next open when the first read failed", async () => {
    jest
      .mocked(window.api.contacts.getAvailable)
      .mockResolvedValueOnce({ success: false, error: "database is locked" });

    render(<Harness autoLoadSaved={false} autoLoadExternal={false} />);
    await act(async () => {
      latest.triggerLazyLoad();
    });
    await settle();

    expect(availableCalls()).toBe(1);
    expect(idsIn("external")).toEqual([]);

    await act(async () => {
      latest.triggerLazyLoad();
    });
    await settle();

    expect(availableCalls()).toBe(2);
    expect(idsIn("external")).toEqual([addressBookRecord.id]);
  });

  /**
   * CONTROL — ALL OR NOTHING, ASSERTED AT THE HOOK.
   *
   * If either fetch fails NEITHER half is committed. Committing the address-book
   * result alone removes the record while the saved contact is still absent —
   * the person then in neither list, which is worse than the defect being fixed.
   * Committing the saved result alone IS the defect.
   *
   * OBSERVED RED: commit each half independently (`if (saved !== null)
   * setContacts(saved); if (external !== null) setExternalContacts(external);`)
   * and the external set comes back empty instead of holding its old row.
   */
  it("commits neither half when one fetch fails", async () => {
    render(<Harness />);
    await settle();
    expect(idsIn("saved")).toEqual([savedContact.id]);
    expect(idsIn("external")).toEqual([addressBookRecord.id]);

    jest
      .mocked(window.api.contacts.getAll)
      .mockResolvedValueOnce({ success: false, error: "database is locked" });
    jest
      .mocked(window.api.contacts.getAvailable)
      .mockResolvedValueOnce({ success: true, contacts: [] });

    await act(async () => {
      await latest.refreshBothLists();
    });
    await settle();

    // The address-book fetch succeeded and would have cleared the half. It was
    // not committed, because its partner failed.
    expect(idsIn("external")).toEqual([addressBookRecord.id]);
    expect(idsIn("saved")).toEqual([savedContact.id]);
  });

  /**
   * CONTROL — `propertyAddress` PICKS THE CHANNEL, WHICH IS THE ONLY THING THE
   * THREE CONTAINERS CONFIGURE ABOUT THE SAVED HALF.
   *
   * The two transaction surfaces read `contacts:get-sorted-by-activity` for the
   * deal; Clients & Contacts has no deal and reads `contacts:get-all`. Asserted
   * because collapsing the two would silently reorder the picker on both
   * transaction surfaces — a change nobody would see in a list assertion, since
   * both channels return the same people.
   */
  it("reads the deal-sorted channel only when there is a deal", async () => {
    const withDeal = render(<Harness propertyAddress="123 Main Street" />);
    await settle();
    expect(window.api.contacts.getSortedByActivity).toHaveBeenCalledWith(
      USER_ID,
      "123 Main Street",
    );
    expect(window.api.contacts.getAll).not.toHaveBeenCalled();
    withDeal.unmount();

    jest.clearAllMocks();
    jest
      .mocked(window.api.contacts.getAll)
      .mockResolvedValue({ success: true, contacts: [savedContact] });
    jest
      .mocked(window.api.contacts.getAvailable)
      .mockResolvedValue({ success: true, contacts: [addressBookRecord] });

    render(<Harness />);
    await settle();
    expect(window.api.contacts.getAll).toHaveBeenCalledWith(USER_ID);
    expect(window.api.contacts.getSortedByActivity).not.toHaveBeenCalled();
  });

  /**
   * CONTROL — THE THROWN MESSAGE REACHES THE SCREEN.
   *
   * Two of the three containers surfaced it before this hook existed (Clients &
   * Contacts through `err.message`, the transaction-details provider through
   * `contactService`'s `getErrorMessage`); the wizard copy replaced it with a
   * generic string. Unifying on the generic one would have been a silent
   * downgrade on two surfaces — it is the difference between "database is
   * locked" and "no such column" on a screen someone is looking at.
   */
  it("surfaces the underlying error rather than a generic one", async () => {
    jest
      .mocked(window.api.contacts.getAll)
      .mockRejectedValueOnce(new Error("database is locked"));

    render(<Harness />);
    await settle();

    expect(screen.getByTestId("error")).toHaveTextContent("database is locked");
  });
});
