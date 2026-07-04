/**
 * @jest-environment node
 */

/**
 * Unit tests for getEmailNameMap (BACKLOG-1762).
 * Verifies the email -> display_name map building, lowercasing, and the
 * imported/primary "best wins" precedence.
 */

import { jest } from "@jest/globals";

const mockDbAll = jest.fn();

jest.mock("../core/dbConnection", () => ({
  dbAll: mockDbAll,
  dbGet: jest.fn(),
  dbRun: jest.fn(),
  dbTransaction: jest.fn(),
}));

jest.mock("../../logService", () => ({
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// contactDbService pulls in these at import time; stub to keep the node env light.
jest.mock("../../contactsService", () => ({ getContactNames: jest.fn() }));
jest.mock("../../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: jest.fn().mockReturnValue(false),
}));

import { getEmailNameMap } from "../contactDbService";

describe("contactDbService.getEmailNameMap", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("builds a lowercase email -> display_name map", () => {
    mockDbAll.mockReturnValue([
      { email: "emily.patt@gmail.com", display_name: "Emily Patterson" },
      { email: "sarah.mitchell@example.com", display_name: "Sarah Mitchell" },
    ]);

    const map = getEmailNameMap("user-1");

    expect(map).toEqual({
      "emily.patt@gmail.com": "Emily Patterson",
      "sarah.mitchell@example.com": "Sarah Mitchell",
    });
    expect(mockDbAll).toHaveBeenCalledWith(expect.any(String), ["user-1"]);
  });

  it("keeps the first (best-ordered) row when an address appears multiple times", () => {
    // Query returns rows ORDER BY is_imported DESC, is_primary DESC — so the
    // best row is first and should win.
    mockDbAll.mockReturnValue([
      { email: "dup@x.com", display_name: "Imported Primary" },
      { email: "dup@x.com", display_name: "Message Derived" },
    ]);

    const map = getEmailNameMap("user-1");

    expect(map["dup@x.com"]).toBe("Imported Primary");
  });

  it("lowercases mixed-case addresses returned by the query", () => {
    mockDbAll.mockReturnValue([
      { email: "MixedCase@X.com", display_name: "Casey" },
    ]);

    const map = getEmailNameMap("user-1");

    expect(map["mixedcase@x.com"]).toBe("Casey");
  });

  it("skips rows with empty email or display_name", () => {
    mockDbAll.mockReturnValue([
      { email: "", display_name: "No Email" },
      { email: "ok@x.com", display_name: "  " },
      { email: "good@x.com", display_name: "Good Contact" },
    ]);

    const map = getEmailNameMap("user-1");

    expect(map).toEqual({ "good@x.com": "Good Contact" });
  });

  it("returns an empty object when there are no contacts", () => {
    mockDbAll.mockReturnValue([]);
    expect(getEmailNameMap("user-1")).toEqual({});
  });
});
