/**
 * @jest-environment node
 *
 * BACKLOG-2816 (founder ruling, 2026-08-23) — group members are shown BY NAME.
 *
 * "If you want you can show a few of the members of the group chat (with name not
 * numbers)." The search service returns raw member handles because only the main
 * process can resolve them; this handler turns them into contact names before the
 * renderer ever sees them.
 *
 * ===========================================================================
 * THE RULE THIS PINS, AND WHY IT IS THE INTERESTING HALF
 * ===========================================================================
 * A member with no matching contact is OMITTED — not rendered as digits, not
 * "formatted" into a prettier number. A group where nobody is a saved contact
 * shows its name with no member line at all. Showing numbers is precisely what
 * he ruled out, so the unresolved case is asserted as an absence.
 *
 * Resolution goes through the SHARED `contactResolutionService.resolveHandles`
 * — the same resolver AttachMessagesModal uses. The mock below stands in for that
 * module, so if the wiring is removed the member-name assertions go red rather
 * than a snapshot quietly changing.
 *
 * All names and handles are invented.
 */

const mockResolveHandles = jest.fn();
const mockSearchLinked = jest.fn();
const mockSearchGlobal = jest.fn();
const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();

jest.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, fn);
    },
  },
}));
jest.mock("../../services/logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("../../services/db/core/dbConnection", () => ({
  getRawDatabase: jest.fn(() => ({})),
}));
jest.mock("../../services/contactResolutionService", () => ({
  resolveHandles: (...args: unknown[]) => mockResolveHandles(...args),
}));
jest.mock("../../services/db/transactionSearchDbService", () => ({
  searchLinkedContent: (...args: unknown[]) => mockSearchLinked(...args),
  searchGlobalContent: (...args: unknown[]) => mockSearchGlobal(...args),
}));

import { registerTransactionSearchHandlers } from "../transactionSearchHandlers";

const GROUP_NAME = "Kingfisher Lane Closing";
const KNOWN_A = "+14155550100";
const KNOWN_B = "+14155550101";
const UNKNOWN = "+14155550199";
const NAME_A = "Dana Whitfield";
const NAME_B = "Marcus Otero";

const TXN = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

const emptyGroup = { items: [], total: 0 };

function threadHit(memberHandles: string[]) {
  return {
    id: "m-newest",
    sender: null,
    snippet: null,
    sentAt: "2026-06-25T00:00:00.000Z",
    attribution: null,
    threadDisplayName: GROUP_NAME,
    memberHandles,
  };
}

beforeAll(() => {
  registerTransactionSearchHandlers();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveHandles.mockResolvedValue({ [KNOWN_A]: NAME_A, [KNOWN_B]: NAME_B });
});

/**
 * BACKLOG-2858: the thread rows carrying `memberHandles` moved to `groupChats`.
 * Resolving `texts` alone would now resolve NOTHING — a message row has no
 * `memberHandles` — and every member line in the app would silently go blank,
 * which is why these tests follow the rows rather than keeping the old key.
 */
const invokeLinked = async (groupChatHits: unknown[], textHits: unknown[] = []) => {
  mockSearchLinked.mockReturnValue({
    contacts: emptyGroup, emails: emptyGroup,
    texts: { items: textHits, total: 546 },
    groupChats: { items: groupChatHits, total: groupChatHits.length },
  });
  const fn = handlers.get("transactions:search-linked-content");
  if (!fn) throw new Error("handler not registered");
  return (await fn({}, TXN, "kingfisher")) as {
    results: { groupChats: { items: Array<{ memberNames?: string[] }> } };
  };
};

describe("BACKLOG-2816 — member handles become contact names", () => {
  it("resolves every member that maps to a contact", async () => {
    const res = await invokeLinked([threadHit([KNOWN_A, KNOWN_B])]);
    expect(res.results.groupChats.items[0].memberNames).toEqual([NAME_A, NAME_B]);
  });

  it("OMITS a member with no contact rather than showing digits", async () => {
    const res = await invokeLinked([threadHit([KNOWN_A, UNKNOWN, KNOWN_B])]);
    const names = res.results.groupChats.items[0].memberNames ?? [];
    expect(names).toEqual([NAME_A, NAME_B]);
    // The rule, asserted directly: nothing that looks like a number survives.
    expect(names.join(",")).not.toMatch(/\d{3}/);
  });

  it("yields an EMPTY member list when nobody resolves — never a digit list", async () => {
    mockResolveHandles.mockResolvedValue({});
    const res = await invokeLinked([threadHit([UNKNOWN])]);
    expect(res.results.groupChats.items[0].memberNames).toEqual([]);
  });

  it("asks the SHARED resolver once for every handle in the response", async () => {
    await invokeLinked([threadHit([KNOWN_A]), threadHit([KNOWN_B, UNKNOWN])]);
    expect(mockResolveHandles).toHaveBeenCalledTimes(1);
    const [handles] = mockResolveHandles.mock.calls[0] as [string[]];
    expect([...handles].sort()).toEqual([KNOWN_A, KNOWN_B, UNKNOWN].sort());
  });

  it("does not call the resolver when no hit carries members", async () => {
    await invokeLinked([], [{ id: "m-body", sender: KNOWN_A, snippet: "hello", sentAt: null }]);
    expect(mockResolveHandles).not.toHaveBeenCalled();
  });

  it("resolves the global Group chats category and the Unattached bucket together", async () => {
    // BACKLOG-2858 kept unattached thread rows in the Unattached bucket, so the
    // handler still has TWO places to resolve and must do it in one round trip.
    mockSearchGlobal.mockReturnValue({
      transactions: emptyGroup, contacts: emptyGroup, emails: emptyGroup,
      texts: emptyGroup,
      groupChats: { items: [threadHit([KNOWN_A])], total: 1 },
      unattached: { items: [{ kind: "text", title: null, ...threadHit([KNOWN_B]) }], total: 4 },
    });
    const fn = handlers.get("transactions:search-global");
    if (!fn) throw new Error("handler not registered");
    const res = (await fn({}, USER, "kingfisher")) as {
      results: {
        groupChats: { items: Array<{ memberNames?: string[] }> };
        unattached: { items: Array<{ memberNames?: string[] }> };
      };
    };
    expect(res.results.groupChats.items[0].memberNames).toEqual([NAME_A]);
    expect(res.results.unattached.items[0].memberNames).toEqual([NAME_B]);
    // ONE round trip covers both groups.
    expect(mockResolveHandles).toHaveBeenCalledTimes(1);
  });
});
