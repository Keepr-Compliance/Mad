/**
 * SR F1 (fixed): an EXISTING account (created before the release cut-over)
 * keeps the old 3-month default — written explicitly for messages and email
 * on ANY machine, so the shared marker never strands another device; a new
 * account gets 1.5 (marker only); an unknown account age writes nothing.
 *
 * Mutations that turn this red:
 *   G1 an existing account not grandfathered                     → "existing account"
 *   G2 a new account written 3 (e.g. local data after an import)  → "new account"
 *   G3 a stored choice overwritten                                → "stored choice"
 *   G4 the marker ignored (runs again)                            → "once"
 *   G5 the marker written while undecided (offline)               → "undecided"
 *   G6 "has data" local again (two-device case)                   → "two devices"
 */
jest.mock("../logService", () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn() } }));
jest.mock("../supabaseService", () => ({ __esModule: true, default: {} }));
jest.mock("../db/core/dbConnection", () => ({ dbGet: jest.fn() }));

import {
  classifyAccount,
  grandfatherLookbackDefaults,
  grandfatherPatch,
  LEGACY_DEFAULT_LOOKBACK_MONTHS,
  LOOKBACK_DEFAULT_CUTOVER_ISO,
  type AccountCreatedAt,
} from "../lookbackGrandfatherService";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Prefs = Record<string, any>;

const OLD: AccountCreatedAt = { known: true, createdAt: "2025-03-01T00:00:00.000Z" };
const NEW: AccountCreatedAt = { known: true, createdAt: "2026-12-01T00:00:00.000Z" };

/** One Supabase preferences row shared by every "device". */
function cloud(initial: Prefs | null) {
  const store = { prefs: initial };
  const saves: Prefs[] = [];
  const device = (account: AccountCreatedAt, hasLocalData: boolean) => ({
    getPreferences: async () => store.prefs,
    savePreferences: async (_id: string, p: Prefs) => {
      saves.push(p);
      store.prefs = p;
    },
    getAccountCreatedAt: async () => account,
    hasLocalData: () => hasLocalData,
  });
  return { store, saves, device };
}

describe("grandfatherLookbackDefaults (SR F1)", () => {
  it("existing account: messages and email kept at 3, explicitly, with the marker (G1)", async () => {
    const c = cloud({ messageImport: { filters: { maxMessages: 10000 } } });
    await grandfatherLookbackDefaults("u", c.device(OLD, true));
    expect(c.saves).toHaveLength(1);
    expect(c.store.prefs!.messageImport.filters).toEqual({ maxMessages: 10000, lookbackMonths: 3 });
    expect(c.store.prefs!.emailCache).toEqual({ durationMonths: 3 });
    expect(c.store.prefs!.defaultsMigrations).toEqual({ lookback15: true });
    expect(LEGACY_DEFAULT_LOOKBACK_MONTHS).toBe(3);
  });

  // The SR's case: a long-time user signs in on a NEW, EMPTY machine first.
  it("two devices: the empty new machine still writes the 3s, so the original one keeps them (G6)", async () => {
    const c = cloud({});
    await grandfatherLookbackDefaults("u", c.device(OLD, false)); // new machine, no local data
    expect(c.store.prefs!.messageImport.filters.lookbackMonths).toBe(3);
    expect(c.store.prefs!.emailCache.durationMonths).toBe(3);
    // The original machine (with data) signs in later: already done, and its window is 3.
    await grandfatherLookbackDefaults("u", c.device(OLD, true));
    expect(c.saves).toHaveLength(1);
    expect(c.store.prefs!.messageImport.filters.lookbackMonths).toBe(3);
  });

  it("new account: only the marker, even with local data after an import (G2)", async () => {
    const c = cloud(null);
    await grandfatherLookbackDefaults("u", c.device(NEW, true));
    expect(c.saves).toEqual([{ defaultsMigrations: { lookback15: true } }]);
  });

  // First sign-in offline, then an import: the account age is unknown → nothing
  // is written (no marker), and the next sign-in decides by created_at.
  it("undecided (account row not read): nothing written, not even the marker; decided next time (G5)", async () => {
    const c = cloud({});
    await grandfatherLookbackDefaults("u", c.device({ known: false }, true));
    expect(c.saves).toEqual([]);
    await grandfatherLookbackDefaults("u", c.device(NEW, true));
    expect(c.saves).toEqual([{ defaultsMigrations: { lookback15: true } }]);
  });

  it("no created_at on the account row: local data decides", () => {
    expect(classifyAccount({ known: true, createdAt: null }, true)).toBe("existing");
    expect(classifyAccount({ known: true, createdAt: null }, false)).toBe("new");
    expect(classifyAccount({ known: true, createdAt: LOOKBACK_DEFAULT_CUTOVER_ISO }, true)).toBe("new");
    expect(classifyAccount({ known: false }, true)).toBe("undecided");
  });

  it("the Android namespace is kept at 3 only when it exists", () => {
    expect(grandfatherPatch({ messageImport: { android: { filters: { maxMessages: 5000 } } } }, true)!.messageImport.android)
      .toEqual({ filters: { lookbackMonths: 3 } });
    expect(grandfatherPatch({}, true)!.messageImport.android).toBeUndefined();
  });

  it("a stored choice (including All time) is never overwritten (G3)", () => {
    const p = grandfatherPatch(
      { messageImport: { filters: { lookbackMonths: null }, android: { filters: { lookbackMonths: 6 } } }, emailCache: { durationMonths: 12 } },
      true,
    );
    expect(p).toEqual({ defaultsMigrations: { lookback15: true } });
    expect(grandfatherPatch({ emailSync: { lookbackMonths: 6 } }, true)!.emailCache).toBeUndefined();
  });

  it("runs once: the marker stops it (G4)", async () => {
    const c = cloud({ defaultsMigrations: { lookback15: true } });
    await grandfatherLookbackDefaults("u", c.device(OLD, true));
    expect(c.saves).toEqual([]);
  });

  it("never throws: a failed save is skipped (retried next sign-in)", async () => {
    const c = cloud({});
    const d = c.device(OLD, true);
    d.savePreferences = async () => {
      throw new Error("offline");
    };
    await expect(grandfatherLookbackDefaults("u", d)).resolves.toBeNull();
  });
});
