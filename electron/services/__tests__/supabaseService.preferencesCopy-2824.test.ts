/**
 * @jest-environment node
 */

/**
 * BACKLOG-2824: supabaseService writes the local preferences copy after a
 * successful cloud read or save, never after a failed one, and still throws
 * when the cloud read fails (the copy is served only by the preferences:get
 * handler). Real supabaseService + real preferencesMirror; the Supabase client
 * and the session file are stand-ins.
 */

type Session = Record<string, unknown>;

let mockStored: Session | null = null;
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
    getGeneration: () => 1,
  },
}));

const mockSupabaseClient = {
  from: jest.fn(),
  rpc: jest.fn(),
  auth: {
    getSession: jest.fn().mockResolvedValue({ data: { session: null }, error: null }),
    onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
    signOut: jest.fn().mockResolvedValue({ error: null }),
  },
  functions: { invoke: jest.fn() },
};

jest.mock("@supabase/supabase-js", () => ({
  createClient: jest.fn(() => mockSupabaseClient),
}));
jest.mock("dotenv", () => ({ config: jest.fn() }));

process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_ANON_KEY = "test-anon-key";

import supabaseService from "../supabaseService";
import { readPreferencesCopy, resetPreferencesCopyMemoForTests } from "../preferencesMirror";

// pii-allow-uuid: invented, not from any live row
const USER = "00000000-0000-4000-8000-000000000001";

/** A `.from("user_preferences").select().eq().single()` read. */
interface ReadQuery {
  select: jest.Mock;
  eq: jest.Mock;
  single: jest.Mock;
}
function readQuery(data: unknown, error: { code?: string; message?: string } | null): ReadQuery {
  const q: ReadQuery = {
    select: jest.fn(() => q),
    eq: jest.fn(() => q),
    single: jest.fn(async () => ({ data, error })),
  };
  return q;
}

/** A `.from("user_preferences").upsert()` write. */
function upsertQuery(error: { code?: string; message?: string } | null) {
  return { upsert: jest.fn(async () => ({ data: null, error })) };
}

/** Let the fire-and-forget copy write finish. */
const flush = () => new Promise((r) => setTimeout(r, 0));

const COPY_A = {
  userId: USER,
  preferences: { messages: { source: "android-companion" } },
  copiedAt: "2026-11-01T10:00:00.000Z",
};

beforeAll(() => {
  supabaseService.initialize();
});

beforeEach(() => {
  mockUpdateSession.mockClear();
  mockSupabaseClient.from.mockReset();
  resetPreferencesCopyMemoForTests();
  mockStored = { user: { id: USER }, preferencesCopy: COPY_A };
  (supabaseService as unknown as { authSession: unknown }).authSession = { userId: USER };
});

describe("BACKLOG-2824 supabaseService keeps the local preferences copy", () => {
  // C3, second half: the cloud wins and replaces the copy.
  it("C3: a successful read returns the cloud bag and replaces the copy with it", async () => {
    const cloud = { messages: { source: "iphone-sync" } };
    mockSupabaseClient.from.mockReturnValue(readQuery({ preferences: cloud }, null));

    await expect(supabaseService.getPreferences(USER)).resolves.toEqual(cloud);
    await flush();
    expect((await readPreferencesCopy(USER))?.preferences).toEqual(cloud);
  });

  // C8
  it("C8: no row (PGRST116) is copied as {}", async () => {
    mockSupabaseClient.from.mockReturnValue(readQuery(null, { code: "PGRST116" }));

    await expect(supabaseService.getPreferences(USER)).resolves.toEqual({});
    await flush();
    expect((await readPreferencesCopy(USER))?.preferences).toEqual({});
  });

  // C5 + C9a
  it("C5/C9a: a failed read still throws and leaves the copy as it was", async () => {
    mockSupabaseClient.from.mockReturnValue(
      readQuery(null, { code: "", message: "TypeError: fetch failed" }),
    );

    await expect(supabaseService.getPreferences(USER)).rejects.toEqual({
      code: "",
      message: "TypeError: fetch failed",
    });
    await flush();
    expect(mockUpdateSession).not.toHaveBeenCalled();
    expect(await readPreferencesCopy(USER)).toEqual(COPY_A);
  });

  // C6
  it("C6: a successful save becomes the copy", async () => {
    const saved = { messages: { source: "macos-native" }, theme: "dark" };
    mockSupabaseClient.from.mockReturnValue(upsertQuery(null));

    await supabaseService.syncPreferences(USER, saved);
    await flush();
    expect((await readPreferencesCopy(USER))?.preferences).toEqual(saved);
  });

  it("C6: a failed save leaves the copy as it was", async () => {
    mockSupabaseClient.from.mockReturnValue(upsertQuery({ code: "", message: "TypeError: fetch failed" }));

    await expect(
      supabaseService.syncPreferences(USER, { messages: { source: "macos-native" } }),
    ).rejects.toBeTruthy();
    await flush();
    expect(mockUpdateSession).not.toHaveBeenCalled();
    expect(await readPreferencesCopy(USER)).toEqual(COPY_A);
  });

  it("a read for a user who is not the signed-in user does not write the copy", async () => {
    (supabaseService as unknown as { authSession: unknown }).authSession = {
      // pii-allow-uuid: invented, not from any live row
      userId: "00000000-0000-4000-8000-000000000002",
    };
    mockSupabaseClient.from.mockReturnValue(readQuery({ preferences: { a: 1 } }, null));

    await supabaseService.getPreferences(USER);
    await flush();
    expect(mockUpdateSession).not.toHaveBeenCalled();
    expect(await readPreferencesCopy(USER)).toEqual(COPY_A);
  });
});
