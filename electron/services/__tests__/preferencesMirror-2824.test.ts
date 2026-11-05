/**
 * @jest-environment node
 */

/**
 * BACKLOG-2824: the local copy of the cloud preferences bag, stored in the
 * session file. sessionService is an in-memory stand-in with the same contract
 * the copy relies on: updateSession merges into an existing session and
 * resolves false when there is none; saveSession replaces the session and
 * changes the generation; clearSession removes it and changes the generation.
 */

type Session = Record<string, unknown>;

let mockStored: Session | null = null;
let mockGeneration = 0;
const mockUpdateSession = jest.fn(async (updates: Session) => {
  if (!mockStored) return false;
  mockStored = { ...mockStored, ...updates };
  return true;
});

jest.mock("../sessionService", () => ({
  __esModule: true,
  default: {
    loadSession: jest.fn(async () => mockStored),
    updateSession: (updates: Session) => mockUpdateSession(updates),
    getGeneration: () => mockGeneration,
  },
}));

jest.mock("../logService", () => ({
  __esModule: true,
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  readPreferencesCopy,
  resetPreferencesCopyMemoForTests,
  writePreferencesCopy,
} from "../preferencesMirror";

// pii-allow-uuid: invented, not from any live row
const USER = "00000000-0000-4000-8000-000000000001";
// pii-allow-uuid: invented, not from any live row
const OTHER_USER = "00000000-0000-4000-8000-000000000002";

function saveSession(session: Session): void {
  mockStored = session;
  mockGeneration++;
}
function clearSession(): void {
  mockStored = null;
  mockGeneration++;
}

beforeEach(() => {
  mockStored = null;
  mockGeneration = 0;
  mockUpdateSession.mockClear();
  resetPreferencesCopyMemoForTests();
  saveSession({ user: { id: USER } });
});

describe("BACKLOG-2824 preferencesMirror", () => {
  it("stores the bag verbatim for the signed-in user and reads it back", async () => {
    const bag = { messages: { source: "android-companion" }, phone_type: "iphone" };
    await expect(writePreferencesCopy(USER, bag, USER)).resolves.toBe(true);

    const copy = await readPreferencesCopy(USER);
    expect(copy?.userId).toBe(USER);
    expect(copy?.preferences).toEqual(bag);
    expect(Number.isNaN(Date.parse(copy?.copiedAt ?? ""))).toBe(false);
  });

  it("an unknown stored value is copied as stored, not normalised (BACKLOG-3749)", async () => {
    const bag = { messages: { source: "some-future-source" } };
    await writePreferencesCopy(USER, bag, USER);
    expect((await readPreferencesCopy(USER))?.preferences).toEqual(bag);
  });

  // C8
  it("C8: an empty cloud bag is copied as {}", async () => {
    await expect(writePreferencesCopy(USER, {}, USER)).resolves.toBe(true);
    expect((await readPreferencesCopy(USER))?.preferences).toEqual({});
  });

  it("is not written for a user id other than the signed-in user", async () => {
    await expect(writePreferencesCopy(USER, { a: 1 }, OTHER_USER)).resolves.toBe(false);
    await expect(writePreferencesCopy(USER, { a: 1 }, null)).resolves.toBe(false);
    expect(mockUpdateSession).not.toHaveBeenCalled();
    expect(await readPreferencesCopy(USER)).toBeNull();
  });

  // C4
  describe("C4: a copy that does not parse or belongs to another user is no copy", () => {
    const cases: Array<[string, unknown]> = [
      ["another user id", { userId: OTHER_USER, preferences: { a: 1 }, copiedAt: "2026-11-04T10:00:00.000Z" }],
      ["no user id", { preferences: { a: 1 }, copiedAt: "2026-11-04T10:00:00.000Z" }],
      ["preferences is a string", { userId: USER, preferences: "{}", copiedAt: "2026-11-04T10:00:00.000Z" }],
      ["preferences is an array", { userId: USER, preferences: [], copiedAt: "2026-11-04T10:00:00.000Z" }],
      ["preferences is null", { userId: USER, preferences: null, copiedAt: "2026-11-04T10:00:00.000Z" }],
      ["no copiedAt", { userId: USER, preferences: { a: 1 } }],
      ["copiedAt is not a date", { userId: USER, preferences: { a: 1 }, copiedAt: "not a date" }],
      ["the copy is a string", "corrupt"],
    ];
    it.each(cases)("%s", async (_label, stored) => {
      mockStored = { user: { id: USER }, preferencesCopy: stored };
      expect(await readPreferencesCopy(USER)).toBeNull();
    });

    it("no session at all", async () => {
      clearSession();
      expect(await readPreferencesCopy(USER)).toBeNull();
    });

    it("a well-formed copy for this user is served (positive control)", async () => {
      mockStored = {
        user: { id: USER },
        preferencesCopy: { userId: USER, preferences: { a: 1 }, copiedAt: "2026-11-04T10:00:00.000Z" },
      };
      expect(await readPreferencesCopy(USER)).toEqual({
        userId: USER,
        preferences: { a: 1 },
        copiedAt: "2026-11-04T10:00:00.000Z",
      });
    });
  });

  // C7
  describe("C7: one session-file write per bag per session", () => {
    it("identical bags write once; a different bag writes again", async () => {
      await writePreferencesCopy(USER, { a: 1 }, USER);
      await writePreferencesCopy(USER, { a: 1 }, USER);
      await writePreferencesCopy(USER, { a: 1 }, USER);
      expect(mockUpdateSession).toHaveBeenCalledTimes(1);

      await writePreferencesCopy(USER, { a: 2 }, USER);
      expect(mockUpdateSession).toHaveBeenCalledTimes(2);
      expect((await readPreferencesCopy(USER))?.preferences).toEqual({ a: 2 });
    });

    it("reads that start together (app launch) queue one write", async () => {
      await Promise.all([
        writePreferencesCopy(USER, { a: 1 }, USER),
        writePreferencesCopy(USER, { a: 1 }, USER),
        writePreferencesCopy(USER, { a: 1 }, USER),
      ]);
      expect(mockUpdateSession).toHaveBeenCalledTimes(1);
    });

    it("after sign-out and sign-in, the same bag is written into the new session file", async () => {
      await writePreferencesCopy(USER, { a: 1 }, USER);
      clearSession();
      saveSession({ user: { id: USER } });
      expect(await readPreferencesCopy(USER)).toBeNull();

      await writePreferencesCopy(USER, { a: 1 }, USER);
      expect(mockUpdateSession).toHaveBeenCalledTimes(2);
      expect((await readPreferencesCopy(USER))?.preferences).toEqual({ a: 1 });
    });

    it("a write with no session yet is retried by the next read", async () => {
      clearSession();
      await expect(writePreferencesCopy(USER, { a: 1 }, USER)).resolves.toBe(false);
      mockStored = { user: { id: USER } }; // session written without a generation change
      await expect(writePreferencesCopy(USER, { a: 1 }, USER)).resolves.toBe(true);
      expect((await readPreferencesCopy(USER))?.preferences).toEqual({ a: 1 });
    });
  });
});
