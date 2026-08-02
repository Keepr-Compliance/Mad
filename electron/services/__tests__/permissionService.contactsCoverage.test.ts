/**
 * @jest-environment node
 *
 * BACKLOG-2404 — `permissionService` distinguishes three outcomes.
 *
 * This service decides WHAT THE USER IS TOLD, so it is where a silent partial
 * result actually costs someone. Before this ticket it had two answers —
 * "contacts load" and "contacts do not load" — derived from `success` and a
 * contact count. A 1-of-3 read satisfies both the same way a 3-of-3 read does.
 *
 * Two conflations are pinned here, and the second one has already shipped once:
 *
 *  1. PARTIAL vs COMPLETE. A user with a locked Exchange store can load
 *     contacts and is still missing half her address book.
 *  2. ZERO vs FAILURE. A successfully-read but empty address book used to
 *     return `canLoadContacts: false` with "you may need to grant Full Disk
 *     Access" — a wrong answer, stated confidently, for a permission the user
 *     already held. BACKLOG-2392 fixed one instance of this (a name-only book
 *     counted 0 reachable identifiers); the conflation itself lived on here.
 *
 * The reader is stubbed rather than driven over real fixtures ON PURPOSE: what
 * is under test is the BRANCHING on the contract, and the contract is exercised
 * against real `.abcddb` files in contactsService.readCoverage.test.ts.
 */

import { jest } from "@jest/globals";

jest.mock("os", () => ({
  ...(jest.requireActual("os") as object),
  platform: () => "darwin",
}));

jest.mock("../logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

const mockGetContactNames = jest.fn();
jest.mock("../contactsService", () => ({
  __esModule: true,
  getContactNames: () => mockGetContactNames(),
}));

import permissionService from "../permissionService";

type Status = Record<string, unknown>;

/** A reader result with the coverage contract filled in. */
function readerResult(
  status: Status,
  contactMap: Record<string, string> = {},
): unknown {
  return { contactMap, phoneToContactInfo: {}, contacts: [], status };
}

const COMPLETE_3_OF_3 = {
  success: true,
  contactCount: 1558,
  booksFound: 3,
  booksRead: 3,
  booksFailed: 0,
  coverage: "complete",
  failures: [],
};

const PARTIAL_2_OF_3 = {
  success: true,
  contactCount: 857,
  booksFound: 3,
  booksRead: 2,
  booksFailed: 1,
  coverage: "partial",
  failures: [{ path: "Sources/1DB81…/AddressBook-v22.abcddb", reason: "read-error" }],
};

const NONE_0_OF_3 = {
  success: false,
  contactCount: 0,
  booksFound: 3,
  booksRead: 0,
  booksFailed: 3,
  coverage: "none",
  failures: [
    { path: "AddressBook-v22.abcddb", reason: "read-error" },
    { path: "Sources/0CA70…/AddressBook-v22.abcddb", reason: "read-error" },
    { path: "Sources/1DB81…/AddressBook-v22.abcddb", reason: "read-error" },
  ],
  userMessage: "Could not load contacts from Contacts app",
  action: "Grant Full Disk Access in System Settings > Privacy & Security > Full Disk Access",
  error: "No contacts could be loaded from any database",
};

describe("BACKLOG-2404: checkContactsLoading tells three states apart", () => {
  beforeEach(() => {
    mockGetContactNames.mockReset();
  });

  describe("read everything", () => {
    it("reports complete coverage and raises nothing", async () => {
      mockGetContactNames.mockResolvedValue(readerResult(COMPLETE_3_OF_3));

      const result = await permissionService.checkContactsLoading();

      expect(result.canLoadContacts).toBe(true);
      expect(result.coverage).toBe("complete");
      expect(result.booksFound).toBe(3);
      expect(result.booksRead).toBe(3);
      expect(result.booksFailed).toBe(0);
      expect(result.contactCount).toBe(1558);
      expect(result.warning).toBeUndefined();
      expect(result.error).toBeUndefined();
    });
  });

  describe("read some — the ticket", () => {
    it("still says contacts load, and says what is missing", async () => {
      mockGetContactNames.mockResolvedValue(readerResult(PARTIAL_2_OF_3));

      const result = await permissionService.checkContactsLoading();

      // She CAN work — one locked book must not lock her out of the app.
      expect(result.canLoadContacts).toBe(true);
      // …and she is not told everything is fine.
      expect(result.coverage).toBe("partial");
      expect(result.warning).toBeDefined();
      expect(result.warning!.type).toBe("CONTACTS_PARTIAL_READ");
      expect(result.warning!.severity).toBe("warning");
      // The numbers, in the message, in the form a human reads.
      expect(result.warning!.message).toContain("2 of 3");
      expect(result.error).toBeUndefined();
    });

    it("is not mistakable for a clean run by any pre-2404 field", async () => {
      // The regression guard. A caller looking only at the fields that existed
      // before this ticket sees IDENTICAL answers for a 2-of-3 read and a
      // 2-of-2 read; that is exactly how the bug survived BACKLOG-2392.
      mockGetContactNames.mockResolvedValue(readerResult(PARTIAL_2_OF_3));
      const partial = await permissionService.checkContactsLoading();

      mockGetContactNames.mockResolvedValue(
        readerResult({ ...PARTIAL_2_OF_3, booksFound: 2, booksFailed: 0, coverage: "complete", failures: [] }),
      );
      const complete = await permissionService.checkContactsLoading();

      expect(partial.canLoadContacts).toBe(complete.canLoadContacts);
      expect(partial.contactCount).toBe(complete.contactCount);
      // The only fields that separate them are the ones 2404 added.
      expect(partial.coverage).not.toBe(complete.coverage);
      expect(partial.warning).toBeDefined();
      expect(complete.warning).toBeUndefined();
    });

    it("does not blame Full Disk Access when the store is merely corrupt", async () => {
      // `load-error` = opened, then threw partway. Sending this user to grant
      // an access she already holds is the 2392 mistake, one level up.
      mockGetContactNames.mockResolvedValue(
        readerResult({
          ...PARTIAL_2_OF_3,
          failures: [{ path: "Sources/1DB81…/AddressBook-v22.abcddb", reason: "load-error" }],
        }),
      );

      const result = await permissionService.checkContactsLoading();

      expect(result.warning!.details).toContain("damaged");
      expect(result.warning!.details).not.toContain("Full Disk Access");
    });
  });

  describe("read nothing", () => {
    it("reports a real failure and keeps the Full Disk Access advice", async () => {
      mockGetContactNames.mockResolvedValue(readerResult(NONE_0_OF_3));

      const result = await permissionService.checkContactsLoading();

      expect(result.canLoadContacts).toBe(false);
      expect(result.coverage).toBe("none");
      expect(result.error).toBeDefined();
      expect(result.error!.type).toBe("CONTACTS_LOADING_FAILED");
      expect(result.error!.severity).toBe("error");
      expect(result.warning).toBeUndefined();
      // "found 3, read 0" is a different diagnosis from "found 0" — the counts
      // travel on the failure return too, not just the success one.
      expect(result.booksFound).toBe(3);
      expect(result.booksRead).toBe(0);
    });
  });

  describe("empty is not a permissions failure (catalogue A8 / rule 4)", () => {
    it("a successful read of an empty address book raises NO Full Disk Access prompt", async () => {
      // THE CONFLATION THIS TICKET IS FORBIDDEN FROM REINTRODUCING.
      // Old behaviour: contactCount === 0 -> canLoadContacts: false, with
      // "No contacts were found… You may need to grant Full Disk Access."
      // The read SUCCEEDED. Her address book is simply empty.
      mockGetContactNames.mockResolvedValue(
        readerResult({
          success: true,
          contactCount: 0,
          booksFound: 1,
          booksRead: 1,
          booksFailed: 0,
          coverage: "complete",
          failures: [],
        }),
      );

      const result = await permissionService.checkContactsLoading();

      expect(result.canLoadContacts).toBe(true);
      expect(result.coverage).toBe("complete");
      expect(result.contactCount).toBe(0);
      expect(result.error).toBeUndefined();
      // Asserted on the SERIALISED whole result, not one field: the wrong
      // advice previously lived in a nested `error.message`, which a top-level
      // assertion would sail straight past.
      expect(JSON.stringify(result)).not.toContain("Full Disk Access");
    });

    it("a name-only book (zero reachable identifiers) is likewise not a failure", async () => {
      // The exact 2392 shape: three real people, no phone and no email between
      // them, so the phone/email lookup map is empty. `contactCount` counts
      // PEOPLE, and the coverage says the read was complete.
      mockGetContactNames.mockResolvedValue(
        readerResult({
          success: true,
          contactCount: 3,
          booksFound: 1,
          booksRead: 1,
          booksFailed: 0,
          coverage: "complete",
          failures: [],
        }),
      );

      const result = await permissionService.checkContactsLoading();

      expect(result.canLoadContacts).toBe(true);
      expect(result.contactCount).toBe(3);
      expect(JSON.stringify(result)).not.toContain("Full Disk Access");
    });
  });
});
