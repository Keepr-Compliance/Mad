/**
 * @jest-environment node
 *
 * BACKLOG-3237 — TRANSCRIPTION. The third banner row, measured off the real
 * producer rather than described.
 *
 * `diagnosticHandlers` suppresses this row under a Full Disk Access denial and
 * keeps it when there is none. Both halves are asserted in
 * `diagnosticHandlers.oneRowPerCause-3237.test.ts` against the fixture in
 * `tests/fixtures/contactsLoadingFailed-3237.ts`. If that fixture drifted from
 * what `permissionService.checkContactsLoading()` actually emits, those
 * assertions would go on passing while the shipped banner did something else —
 * the failure this repo has hit twice.
 *
 * So this suite drives the REAL `checkContactsLoading()`. Only the reader
 * beneath it (`contactsService.getContactNames`) is stubbed, with the status
 * transcribed from `contactsService.ts:652-670`; the branching, the field
 * names and every string in the row below are the service's own.
 */

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
import {
  CONTACTS_LOAD_FAILED_STATUS,
  CONTACTS_LOADING_FAILED_ISSUE,
  CONTACTS_CHECK_FAILED_ISSUE,
} from "../../../tests/fixtures/contactsLoadingFailed-3237";

describe("BACKLOG-3237 — the contacts-loading row is transcribed, not invented", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("emits CONTACTS_LOADING_FAILED exactly as the fixture records it", async () => {
    mockGetContactNames.mockResolvedValue({
      contactMap: {},
      phoneToContactInfo: {},
      contacts: [],
      status: CONTACTS_LOAD_FAILED_STATUS,
    });

    const result = await permissionService.checkContactsLoading();

    expect(result.canLoadContacts).toBe(false);
    // Field for field. A renamed key or a reworded string reds here first.
    expect(result.error).toEqual(CONTACTS_LOADING_FAILED_ISSUE);
  });

  it("emits CONTACTS_CHECK_FAILED exactly as the fixture records it", async () => {
    mockGetContactNames.mockRejectedValue(new Error("boom"));

    const result = await permissionService.checkContactsLoading();

    expect(result.canLoadContacts).toBe(false);
    expect(result.error).toEqual(CONTACTS_CHECK_FAILED_ISSUE);
  });

  it("the row carries a LIVE handler — it is a worse action, not a missing one", async () => {
    // The brief for this item said the third row had no button. It has one,
    // and it opens the raw macOS Privacy pane instead of the explainer. Pinned
    // because the suppression rationale rests on it: this row is not being
    // hidden because it is inert, it is being hidden because a better row is
    // already saying the same thing.
    mockGetContactNames.mockResolvedValue({
      contactMap: {},
      phoneToContactInfo: {},
      contacts: [],
      status: CONTACTS_LOAD_FAILED_STATUS,
    });

    const result = await permissionService.checkContactsLoading();

    expect(result.error?.actionHandler).toBe("open-system-settings");
    expect(result.error?.action.length).toBeGreaterThan(60);
  });

  it("a clean read produces no row at all", async () => {
    mockGetContactNames.mockResolvedValue({
      contactMap: { "+12125550142": "Someone" },
      phoneToContactInfo: {},
      contacts: [{}],
      status: {
        success: true,
        contactCount: 1,
        booksFound: 1,
        booksRead: 1,
        booksFailed: 0,
        coverage: "complete",
        failures: [],
      },
    });

    const result = await permissionService.checkContactsLoading();

    expect(result.canLoadContacts).toBe(true);
    expect(result.error).toBeUndefined();
  });
});
