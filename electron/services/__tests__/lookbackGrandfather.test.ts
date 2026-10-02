/**
 * SR F1: an EXISTING user with no stored window keeps the old 3-month
 * default (written explicitly, messages and email each on its own); a new
 * user gets 1.5 (nothing written); the marker makes it run once.
 *
 * Mutations that turn this red:
 *   G1 an existing user not grandfathered (messages or email)   → "existing user"
 *   G2 a new user written 3                                      → "new user"
 *   G3 a stored choice overwritten                               → "stored choice"
 *   G4 no marker / the marker ignored (runs again later)         → "once"
 */
jest.mock("../logService", () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn() } }));
jest.mock("../supabaseService", () => ({ __esModule: true, default: {} }));
jest.mock("../db/core/dbConnection", () => ({ dbGet: jest.fn() }));

import { grandfatherLookbackDefaults, grandfatherPatch, LEGACY_DEFAULT_LOOKBACK_MONTHS } from "../lookbackGrandfatherService";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Prefs = Record<string, any>;

function deps(prefs: Prefs | null, has: { messages: boolean; email: boolean }) {
  const saved: Prefs[] = [];
  return {
    saved,
    d: {
      getPreferences: async () => prefs,
      savePreferences: async (_id: string, p: Prefs) => void saved.push(p),
      hasMessageData: () => has.messages,
      hasEmailData: () => has.email,
    },
  };
}

describe("grandfatherLookbackDefaults (SR F1)", () => {
  it("existing user, nothing stored: messages and email both kept at 3, explicitly (G1)", async () => {
    const t = deps({ messageImport: { filters: { maxMessages: 10000 } } }, { messages: true, email: true });
    await grandfatherLookbackDefaults("u", t.d);
    expect(t.saved).toHaveLength(1);
    expect(t.saved[0].messageImport.filters).toEqual({ maxMessages: 10000, lookbackMonths: 3 });
    expect(t.saved[0].emailCache).toEqual({ durationMonths: 3 });
    expect(t.saved[0].defaultsMigrations).toEqual({ lookback15: true });
    expect(LEGACY_DEFAULT_LOOKBACK_MONTHS).toBe(3);
  });

  it("each key on its own: email data only → email kept, messages left to the new default", () => {
    const p = grandfatherPatch({}, { messages: false, email: true })!;
    expect(p.emailCache).toEqual({ durationMonths: 3 });
    expect(p.messageImport).toBeUndefined();
    const q = grandfatherPatch({}, { messages: true, email: false })!;
    expect(q.messageImport).toEqual({ filters: { lookbackMonths: 3 } });
    expect(q.emailCache).toBeUndefined();
  });

  it("the Android namespace is kept at 3 only when it exists", () => {
    const withNs = grandfatherPatch({ messageImport: { android: { filters: { maxMessages: 5000 } } } }, { messages: true, email: false })!;
    expect(withNs.messageImport.android).toEqual({ filters: { lookbackMonths: 3 } });
    const without = grandfatherPatch({}, { messages: true, email: false })!;
    expect(without.messageImport.android).toBeUndefined();
  });

  it("new user (no data): only the marker — the 1.5 default applies (G2)", async () => {
    const t = deps(null, { messages: false, email: false });
    await grandfatherLookbackDefaults("u", t.d);
    expect(t.saved).toEqual([{ defaultsMigrations: { lookback15: true } }]);
  });

  it("a stored choice (including All time) is never overwritten (G3)", () => {
    const p = grandfatherPatch(
      { messageImport: { filters: { lookbackMonths: null }, android: { filters: { lookbackMonths: 6 } } }, emailCache: { durationMonths: 12 } },
      { messages: true, email: true },
    )!;
    expect(p).toEqual({ defaultsMigrations: { lookback15: true } });
    // The legacy email key counts as a stored choice too.
    expect(grandfatherPatch({ emailSync: { lookbackMonths: 6 } }, { messages: false, email: true })!.emailCache).toBeUndefined();
  });

  it("runs once: the marker stops it, even once data exists (G4)", async () => {
    const t = deps({ defaultsMigrations: { lookback15: true } }, { messages: true, email: true });
    await grandfatherLookbackDefaults("u", t.d);
    expect(t.saved).toEqual([]);
  });

  it("never throws: a failed save is skipped (retried next sign-in)", async () => {
    const t = deps({}, { messages: true, email: true });
    t.d.savePreferences = async () => {
      throw new Error("offline");
    };
    await expect(grandfatherLookbackDefaults("u", t.d)).resolves.toBeNull();
  });
});
