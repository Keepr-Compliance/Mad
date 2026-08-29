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
// BACKLOG-2757: `nameForHandle` is the ONE reader of a resolution map, and the
// handler now calls it. A factory that returns only `resolveHandles` would hand
// the handler `undefined` and this suite would report a TypeError instead of the
// behaviour it exists to pin, so the REAL function is passed through. Only
// `resolveHandles` is stubbed.
jest.mock("../../services/contactResolutionService", () => {
  const actual = jest.requireActual("../../services/contactResolutionService");
  return {
    ...actual,
    resolveHandles: (...args: unknown[]) => mockResolveHandles(...args),
  };
});
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

/**
 * BACKLOG-2757 — the shape `resolveHandles` ACTUALLY returns.
 *
 * Three corrections over the previous fixture, which described a state the real
 * producer cannot emit:
 *
 *   1. It is `{ names, matches }`, not a flat map. `matches` is what lets a
 *      caller that must not print a name tell an ambiguous handle from a
 *      certain one.
 *   2. Each resolved handle writes SEVERAL alias keys, not one. The imported-
 *      contacts tier calls `acc.add(norm, [norm, stored], match)` once per
 *      stored format, where `stored` is `contact_phones.phone_e164` and
 *      `phone_display`; the external tier adds `row.phone`; the AddressBook
 *      tier writes the CALLER'S OWN handle plus a `+1`-prefixed form.
 *   3. `phone_e164` holds the `+` form — `normalizeToE164` (contactDbService)
 *      returns `+1` + digits, and the DDL documents it as `+14155550102`.
 *
 * Transcribed from the real producer, not invented. Measured by calling
 * `resolveHandles` against a migrated file-backed DB with one seeded contact
 * (AddressBook stubbed empty to isolate the imported tier):
 *
 *   input "+15035550150" -> Object.keys(names) === ["5035550150", "+15035550150"]
 *
 * So a handle already in E.164 resolves under BOTH a raw index and
 * `nameForHandle`. The formats that separate them are measured below.
 */
const { normalizePhone } = jest.requireActual(
  "../../services/contactResolutionService",
) as { normalizePhone: (s: string) => string };

/** `normalizeToE164`, transcribed from contactDbService.ts:313-319. */
function toE164(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (phone.startsWith("+")) return phone;
  return `+${digits}`;
}

/**
 * The alias set the imported-contacts tier really writes for one stored number:
 * the normalized lookup key and the stored E.164 form.
 */
function resolutionFor(pairs: Array<[string, string]>) {
  const names: Record<string, string> = {};
  const matches: Record<string, readonly string[]> = {};
  for (const [stored, name] of pairs) {
    for (const alias of [normalizePhone(stored), toE164(stored)]) {
      if (!alias) continue;
      names[alias] = name;
      matches[alias] = [name];
    }
  }
  return { names, matches };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveHandles.mockResolvedValue(
    resolutionFor([
      [KNOWN_A, NAME_A],
      [KNOWN_B, NAME_B],
    ]),
  );
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
    mockResolveHandles.mockResolvedValue({ names: {}, matches: {} });
    const res = await invokeLinked([threadHit([UNKNOWN])]);
    expect(res.results.groupChats.items[0].memberNames).toEqual([]);
  });

  /**
   * BACKLOG-2928 — the format gap, measured rather than assumed.
   *
   * `memberHandles` comes from `messages.participants` -> `chat_members`, which
   * is Apple's raw string and is NOT normalized on ingest. The resolver keys its
   * map on the normalized digits and on the STORED formats
   * (`contact_phones.phone_e164` / `phone_display`), so a handle that is neither
   * — "503-555-0150" against a number stored as "+15035550150" — is present in
   * the map under a key the raw handle never equals.
   *
   * Indexing `names[handle]` directly therefore returns undefined, and the guard
   * below it omits the member rather than falling back to the number, so the
   * miss is indistinguishable from "no contact matched". `nameForHandle`
   * normalizes first and resolves it.
   *
   * Handles already in E.164 (every other case in this file) resolve under BOTH
   * readings, which is why this suite was green against the defect.
   */
  it("resolves a member handle whose format differs from the stored number", async () => {
    const DASHED = "503-555-0150";
    const STORED = "+15035550150";
    mockResolveHandles.mockResolvedValue(resolutionFor([[STORED, NAME_A]]));

    const res = await invokeLinked([threadHit([DASHED])]);
    expect(res.results.groupChats.items[0].memberNames).toEqual([NAME_A]);
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
