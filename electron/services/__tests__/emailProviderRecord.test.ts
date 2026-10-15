/**
 * BACKLOG-3888 — recording the connected mailbox provider in the cloud
 * preferences bag as a deduplicated, never-shrinking set.
 *
 * supabaseService is replaced by an in-memory user_preferences row whose
 * get/sync semantics are transcribed from supabaseService.ts:1492-1538
 * (getPreferences returns `data?.preferences || {}`; syncPreferences upserts
 * the WHOLE bag).
 */

const row: { preferences: Record<string, unknown> | null } = { preferences: null };
const mockGetPreferences = jest.fn(async (_userId: string) => row.preferences || {});
const mockSyncPreferences = jest.fn(
  async (_userId: string, preferences: Record<string, unknown>) => {
    row.preferences = JSON.parse(JSON.stringify(preferences));
  },
);

jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: {
    getPreferences: (userId: string) => mockGetPreferences(userId),
    syncPreferences: (userId: string, prefs: Record<string, unknown>) =>
      mockSyncPreferences(userId, prefs),
  },
}));

const mockWarn = jest.fn().mockResolvedValue(undefined);
jest.mock("../logService", () => ({
  __esModule: true,
  default: { warn: (...args: unknown[]) => mockWarn(...args) },
}));

import {
  EMAIL_PROVIDERS_PREFERENCE_KEY,
  addEmailProvider,
  recordEmailProvider,
} from "../emailProviderRecord";

const USER = "user-3888";

beforeEach(() => {
  jest.clearAllMocks();
  row.preferences = null;
});

describe("recordEmailProvider", () => {
  it('uses the key "emailProviders"', () => {
    expect(EMAIL_PROVIDERS_PREFERENCE_KEY).toBe("emailProviders");
  });

  it('connecting Outlook on a new account writes ["outlook"]', async () => {
    await expect(recordEmailProvider(USER, "microsoft")).resolves.toBe(true);
    expect(row.preferences).toEqual({ emailProviders: ["outlook"] });
  });

  it('then Gmail -> ["outlook","gmail"]; a duplicate connect leaves the set unchanged and does not write', async () => {
    await recordEmailProvider(USER, "microsoft");
    await recordEmailProvider(USER, "google");
    expect(row.preferences?.emailProviders).toEqual(["outlook", "gmail"]);
    expect(mockSyncPreferences).toHaveBeenCalledTimes(2);

    await recordEmailProvider(USER, "microsoft");
    await recordEmailProvider(USER, "google");
    expect(row.preferences?.emailProviders).toEqual(["outlook", "gmail"]);
    expect(mockSyncPreferences).toHaveBeenCalledTimes(2);
  });

  it("keeps every other preference key", async () => {
    row.preferences = { phone_type: "iphone", onboarding: { fdaSkipped: true } };
    await recordEmailProvider(USER, "google");
    expect(row.preferences).toEqual({
      phone_type: "iphone",
      onboarding: { fdaSkipped: true },
      emailProviders: ["gmail"],
    });
  });

  it("a failed read never throws; it logs, writes nothing, and the next connect records it", async () => {
    mockGetPreferences.mockRejectedValueOnce(new Error("supabase unreachable"));
    await expect(recordEmailProvider(USER, "microsoft")).resolves.toBe(false);
    expect(mockSyncPreferences).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledTimes(1);

    await expect(recordEmailProvider(USER, "microsoft")).resolves.toBe(true);
    expect(row.preferences).toEqual({ emailProviders: ["outlook"] });
  });

  it("a failed write never throws", async () => {
    mockSyncPreferences.mockRejectedValueOnce(new Error("upsert failed"));
    await expect(recordEmailProvider(USER, "google")).resolves.toBe(false);
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });
});

describe("addEmailProvider", () => {
  it("dedupes an existing malformed set and treats a non-array as empty", () => {
    expect(addEmailProvider(["outlook", "outlook"], "gmail")).toEqual(["outlook", "gmail"]);
    expect(addEmailProvider("outlook", "gmail")).toEqual(["gmail"]);
    expect(addEmailProvider(undefined, "outlook")).toEqual(["outlook"]);
    expect(addEmailProvider(["gmail", 7], "gmail")).toEqual(["gmail"]);
  });
});
