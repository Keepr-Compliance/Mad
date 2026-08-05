/**
 * RemovedContactsSection tests (BACKLOG-2367)
 *
 * The Clients & Contacts "Show removed contacts (N)" section: it must list the
 * RIGHT people, restore the RIGHT person, and tell the parent to refresh.
 *
 * ===========================================================================
 * THE FIXTURE IS TRANSCRIBED, NOT INVENTED
 * ===========================================================================
 * `makeRemovedContact` below reproduces the actual output of
 * `contactDbService.getRemovedContacts`, captured by running that function
 * against a real SQLite database built from `electron/database/schema.sql` plus
 * migration v56's DDL. Two details would have been wrong if typed from memory,
 * and both are load-bearing:
 *
 *   - `removed_at` is SQLite's `"YYYY-MM-DD HH:MM:SS"` (a SPACE), not an ISO
 *     8601 string with `T`/`Z`. The card formats this value.
 *   - `active_role_count` arrives as a NUMBER from a correlated COUNT(*), so
 *     the `> 0` test in the card is a numeric comparison, not a truthiness
 *     check on a string.
 *
 * ===========================================================================
 * EXACT IDENTITY, NEVER COUNTS
 * ===========================================================================
 * "two cards rendered" is satisfied by the wrong two people, and "the wrong
 * contact was restored" is the defect that would actually hurt. Every assertion
 * names who.
 *
 * Fixture values are reserved-for-documentation only: `example.com` and the
 * `+1 555 01xx` reserved fictional range.
 */

import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { RemovedContactsSection } from "../RemovedContactsSection";

const USER_ID = "user-2367";

/**
 * BulkSelectionBar renders its action button TWICE (a responsive mobile layout
 * and a desktop one), so the test id is not unique. Same helper the
 * BACKLOG-1719 bulk-restore suite uses.
 */
const first = (testId: string) => screen.getAllByTestId(testId)[0];

/**
 * Transcribed from a real `getRemovedContacts` row — see the file docblock.
 * The captured row was:
 *   {
 *     "id": "c-probe", "display_name": "Dana Example",
 *     "email": "dana@example.com", "phone": "+15550100",
 *     "company": "Example Realty", "title": "Broker", "source": "manual",
 *     "removed_at": "2026-08-05 03:08:06", "removed_reason": "user_unimported",
 *     "active_role_count": 0
 *   }
 */
function makeRemovedContact(overrides: {
  id: string;
  display_name: string;
  email?: string | null;
  phone?: string | null;
  removed_reason?: string | null;
  active_role_count?: number;
  removed_at?: string;
}) {
  return {
    id: overrides.id,
    display_name: overrides.display_name,
    email: overrides.email ?? null,
    phone: overrides.phone ?? null,
    company: "Example Realty",
    title: "Broker",
    source: "manual",
    removed_at: overrides.removed_at ?? "2026-08-05 03:08:06",
    removed_reason: overrides.removed_reason ?? "user_unimported",
    active_role_count: overrides.active_role_count ?? 0,
  };
}

const DANA = makeRemovedContact({
  id: "c-dana",
  display_name: "Dana Example",
  email: "dana@example.com",
  phone: "+15550100",
  active_role_count: 2,
});
const REESE = makeRemovedContact({
  id: "c-reese",
  display_name: "Reese Example",
  email: "reese@example.com",
  removed_reason: "user_deleted",
});

beforeAll(() => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  (window.api.contacts as any).getRemoved = jest.fn();
  (window.api.contacts as any).restore = jest.fn();
  /* eslint-enable @typescript-eslint/no-explicit-any */
});

beforeEach(() => {
  jest.clearAllMocks();
  (window.api.contacts.restore as jest.Mock).mockResolvedValue({
    success: true,
    restored: true,
  });
});

/** Open the section and wait for the list to appear. */
async function openSection() {
  await act(async () => {
    await userEvent.click(screen.getByTestId("show-removed-contacts-toggle"));
  });
  await waitFor(() => {
    expect(screen.getByTestId("removed-contacts-section")).toBeInTheDocument();
  });
}

/** Display names currently rendered, sorted — the identity set under test. */
function renderedNames(): string[] {
  return screen
    .getAllByTestId("removed-contact-card")
    .map((card) => card.querySelector("span")?.textContent ?? "")
    .sort();
}

describe("RemovedContactsSection", () => {
  it("does not fetch until the section is opened", () => {
    (window.api.contacts.getRemoved as jest.Mock).mockResolvedValue({
      success: true,
      contacts: [DANA],
    });

    render(<RemovedContactsSection userId={USER_ID} />);

    expect(window.api.contacts.getRemoved).not.toHaveBeenCalled();
    expect(screen.queryByTestId("removed-contacts-section")).not.toBeInTheDocument();
  });

  it("lists exactly the removed contacts, by name, scoped to the user", async () => {
    (window.api.contacts.getRemoved as jest.Mock).mockResolvedValue({
      success: true,
      contacts: [DANA, REESE],
    });

    render(<RemovedContactsSection userId={USER_ID} />);
    await openSection();

    expect(renderedNames()).toEqual(["Dana Example", "Reese Example"]);
    expect(window.api.contacts.getRemoved).toHaveBeenCalledWith(USER_ID);
  });

  it("shows the surviving transaction-role count, and omits it at zero", async () => {
    (window.api.contacts.getRemoved as jest.Mock).mockResolvedValue({
      success: true,
      contacts: [DANA, REESE],
    });

    render(<RemovedContactsSection userId={USER_ID} />);
    await openSection();

    // Dana kept 2 roles through the tombstone; Reese never had any.
    const badges = screen.getAllByTestId("removed-contact-role-count");
    expect(badges.map((b) => b.textContent)).toEqual(["2 transaction roles"]);
  });

  it("renders the human removal reason, not the raw enum value", async () => {
    (window.api.contacts.getRemoved as jest.Mock).mockResolvedValue({
      success: true,
      contacts: [REESE],
    });

    render(<RemovedContactsSection userId={USER_ID} />);
    await openSection();

    expect(screen.getByText("Deleted")).toBeInTheDocument();
    expect(screen.queryByText("user_deleted")).not.toBeInTheDocument();
  });

  it("restores the contact that was clicked — by id — and drops that row only", async () => {
    (window.api.contacts.getRemoved as jest.Mock).mockResolvedValue({
      success: true,
      contacts: [DANA, REESE],
    });
    const onRestoreComplete = jest.fn().mockResolvedValue(undefined);
    const onShowSuccess = jest.fn();

    render(
      <RemovedContactsSection
        userId={USER_ID}
        onRestoreComplete={onRestoreComplete}
        onShowSuccess={onShowSuccess}
      />,
    );
    await openSection();

    // Click the restore button belonging to Dana's card specifically.
    const danaCard = screen
      .getAllByTestId("removed-contact-card")
      .find((c) => c.textContent?.includes("Dana Example"))!;
    await act(async () => {
      await userEvent.click(
        danaCard.parentElement!.querySelector('[data-testid="restore-contact-button"]')!,
      );
    });

    expect(window.api.contacts.restore).toHaveBeenCalledTimes(1);
    expect(window.api.contacts.restore).toHaveBeenCalledWith("c-dana");

    // Reese — and only Reese — is still listed.
    await waitFor(() => {
      expect(renderedNames()).toEqual(["Reese Example"]);
    });
    expect(onRestoreComplete).toHaveBeenCalledTimes(1);
    expect(onShowSuccess).toHaveBeenCalledWith("Contact restored");
  });

  it("surfaces a backend failure and keeps the row in the list", async () => {
    (window.api.contacts.getRemoved as jest.Mock).mockResolvedValue({
      success: true,
      contacts: [DANA],
    });
    (window.api.contacts.restore as jest.Mock).mockResolvedValue({
      success: false,
      error: "database is locked",
    });
    const onShowError = jest.fn();
    const onRestoreComplete = jest.fn().mockResolvedValue(undefined);

    render(
      <RemovedContactsSection
        userId={USER_ID}
        onShowError={onShowError}
        onRestoreComplete={onRestoreComplete}
      />,
    );
    await openSection();

    await act(async () => {
      await userEvent.click(screen.getByTestId("restore-contact-button"));
    });

    expect(onShowError).toHaveBeenCalledWith("database is locked");
    // The contact must NOT vanish — she was not restored.
    expect(renderedNames()).toEqual(["Dana Example"]);
    expect(onRestoreComplete).not.toHaveBeenCalled();
  });

  it("shows the empty state when nothing has been removed", async () => {
    (window.api.contacts.getRemoved as jest.Mock).mockResolvedValue({
      success: true,
      contacts: [],
    });

    render(<RemovedContactsSection userId={USER_ID} />);
    await openSection();

    expect(screen.getByText("No removed contacts found.")).toBeInTheDocument();
    expect(screen.queryAllByTestId("removed-contact-card")).toHaveLength(0);
  });

  it("bulk-restores exactly the selected contacts, and no others", async () => {
    const KIM = makeRemovedContact({ id: "c-kim", display_name: "Kim Example" });
    (window.api.contacts.getRemoved as jest.Mock).mockResolvedValue({
      success: true,
      contacts: [DANA, REESE, KIM],
    });
    const onRestoreComplete = jest.fn().mockResolvedValue(undefined);

    render(
      <RemovedContactsSection userId={USER_ID} onRestoreComplete={onRestoreComplete} />,
    );
    await openSection();

    await act(async () => {
      await userEvent.click(screen.getByTestId("select-removed-contacts"));
    });

    // Select Dana and Kim, leaving Reese alone.
    const selectables = screen.getAllByTestId("removed-group-selectable");
    for (const el of selectables) {
      if (
        el.textContent?.includes("Dana Example") ||
        el.textContent?.includes("Kim Example")
      ) {
        await act(async () => {
          await userEvent.click(el.querySelector('[data-testid="removed-group-select"]')!);
        });
      }
    }

    await act(async () => {
      await userEvent.click(first("removed-contacts-section-bulk-restore"));
    });

    // Exactly the two selected ids, and nobody else.
    const restoredIds = (window.api.contacts.restore as jest.Mock).mock.calls
      .map((c) => c[0])
      .sort();
    expect(restoredIds).toEqual(["c-dana", "c-kim"]);

    await waitFor(() => {
      expect(renderedNames()).toEqual(["Reese Example"]);
    });
    // ONE silent parent refresh for the whole batch, not one per contact.
    expect(onRestoreComplete).toHaveBeenCalledTimes(1);
  });
});
