/**
 * @jest-environment node
 */

/**
 * BACKLOG-4245 PR 2: beta eligibility read in the main process, combined at
 * apply time with the stored "Get beta versions" value.
 *
 * E1  ineligible user + stored on -> allowPrerelease false
 * E2  eligibility lost at runtime -> false at the next apply (before a check)
 * E3  eligibility read unknown / throws / times out -> false
 * E4  a prerelease build grants nothing
 * E5  E18 startup check runs off while the read is held; on when it lands
 * E6  offline at launch, then online: on within one retry tick
 * E7  regular user: no eligibility read and no timer at startup, periodic,
 *     manual, get, update
 * E8  eligibility for one user never combines with another user's value
 * E9  E15 a session change clears eligibility and stops the retry timer
 * E10 a read in flight across a session change is dropped
 * E11 a preferences read for a user the session does not name records nothing
 * E12 two in-order turn-ons end on
 * E13 only recompute writes allowPrerelease = true (stack of every true write)
 * E16 manual/periodic pre-check: regular user checks at once; beta user's
 *     read runs first
 * E17 one extra check per session, first time eligibility is confirmed
 * E20 in-memory session user differs from the session file user -> unknown
 * V1  V2 visibility decided here: Store, unpackaged, regular, prerelease
 * V3  state carries the stored value and the note
 */

import * as fs from "fs";
import * as path from "path";
import type { IpcMainInvokeEvent } from "electron";

type Handler = (...args: unknown[]) => unknown;
const mockHandles: Record<string, Handler> = {};

jest.mock("electron", () => ({
  ipcMain: {
    handle: (ch: string, fn: Handler) => {
      mockHandles[ch] = fn;
    },
    on: jest.fn(),
  },
  app: { getVersion: () => "2.49.0", isPackaged: true, on: jest.fn() },
}));

type Listener = (...args: unknown[]) => void;

/** Updater stand-in: library defaults, a log, and the stack of every `true` write. */
function makeUpdater(version: string) {
  const log: Array<[string, unknown]> = [];
  const trueWriters: string[] = [];
  const listeners: Record<string, Listener[]> = {};
  const state = {
    allowPrerelease: /^\d+\.\d+\.\d+-/.test(version),
    allowDowngrade: false,
  };
  const u = {
    log,
    trueWriters,
    get allowPrerelease() {
      return state.allowPrerelease;
    },
    set allowPrerelease(v: boolean) {
      log.push(["allowPrerelease", v]);
      if (v === true) trueWriters.push(new Error("trace").stack ?? "");
      state.allowPrerelease = v;
    },
    get allowDowngrade() {
      return state.allowDowngrade;
    },
    set allowDowngrade(v: boolean) {
      state.allowDowngrade = v;
    },
    on: (ev: string, fn: Listener) => {
      (listeners[ev] ??= []).push(fn);
      return u;
    },
    emit: (ev: string, ...args: unknown[]) => {
      for (const fn of listeners[ev] ?? []) fn(...args);
    },
    checkForUpdates: jest.fn(() => {
      log.push(["checkForUpdates", state.allowPrerelease]);
      return Promise.resolve(null);
    }),
  };
  return u;
}
type FakeUpdater = ReturnType<typeof makeUpdater>;

let mockUpdater: FakeUpdater = makeUpdater("2.49.0");
jest.mock("electron-updater", () => ({
  get autoUpdater() {
    return mockUpdater;
  },
}));

jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../services/failureLogService", () => ({ __esModule: true, default: { logFailure: jest.fn() } }));
let mockStoreBuild = false;
jest.mock("../../services/distributionChannelService", () => ({ isStoreBuild: () => mockStoreBuild }));
jest.mock("../featureGateHandlers", () => ({
  resolveStrictFeatureState: jest.fn(async () => "unknown"),
}));

type Session = Record<string, unknown>;
let mockStored: Session | null = null;
jest.mock("../../services/sessionService", () => ({
  __esModule: true,
  default: {
    peekSession: () => Promise.resolve(mockStored ? { status: "ok", session: mockStored } : { status: "none" }),
    loadSession: jest.fn(async () => mockStored),
    updateSession: jest.fn(async () => true),
    getGeneration: () => 1,
  },
}));
jest.mock("../../services/supabaseService", () => ({
  __esModule: true,
  default: { getPreferences: jest.fn(), syncPreferences: jest.fn(), getAuthUserId: jest.fn(), getClient: jest.fn() },
}));

import {
  getBetaUpdatesState,
  refreshBetaEligibility,
  registerBetaUpdatesHandlers,
  resetBetaUpdatesHandlersForTests,
  runAfterBetaEligibility,
  BETA_ELIGIBILITY_RETRY_MS,
  BETA_ELIGIBILITY_TIMEOUT_MS,
  type BetaUpdatesDeps,
} from "../betaUpdatesHandlers";
import * as policy from "../../services/updateChannelPolicy";
import {
  applyBetaUpdatesOff,
  getBetaUpdatesInputs,
  installBetaUpdatesSessionReset,
  recordBetaEligibility,
  recordStoredBetaUpdates,
  resetBetaUpdatesStateForTests,
  type BetaEligibilityState,
} from "../../services/updateChannelPolicy";
import { emitSessionChanged, resetSessionListenersForTests } from "../../services/authEvents";
import { runStartupUpdateCheck } from "../../services/updateDownloadPolicy";
import { registerPreferenceHandlers } from "../preferenceHandlers";
import supabaseService from "../../services/supabaseService";

const cloud = supabaseService as jest.Mocked<typeof supabaseService>;
const event = {} as IpcMainInvokeEvent;

// pii-allow-uuid: invented, not from any live row
const USER = "00000000-0000-4000-8000-000000000001";
// pii-allow-uuid: invented, not from any live row
const OTHER = "00000000-0000-4000-8000-000000000002";

function sessionFor(userId: string, prefs: Record<string, unknown> | null = null): Session {
  const s: Session = { user: { id: userId }, expiresAt: Date.now() + 3_600_000 };
  if (prefs) s.preferencesCopy = { userId, preferences: prefs, copiedAt: "2026-11-01T10:00:00.000Z" };
  return s;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
}

let resolveState: jest.Mock<Promise<BetaEligibilityState>, []>;
let memoryUser: string | null;
let packaged: boolean;
let extraCheck: jest.Mock;
let setIntervalSpy: jest.Mock;
let clearIntervalSpy: jest.Mock;
let intervals: Array<{ fn: () => void; ms: number; cleared: boolean }>;

function register(overrides: Partial<BetaUpdatesDeps> = {}): void {
  registerBetaUpdatesHandlers(mockUpdater as never, {
    resolveState: () => resolveState(),
    memorySessionUserId: async () => memoryUser,
    isPackaged: () => packaged,
    isStoreBuild: () => mockStoreBuild,
    extraCheck: () => extraCheck(),
    setInterval: setIntervalSpy as unknown as BetaUpdatesDeps["setInterval"],
    clearInterval: clearIntervalSpy as unknown as BetaUpdatesDeps["clearInterval"],
    onQuit: () => undefined,
    ...overrides,
  });
}

beforeAll(() => {
  registerPreferenceHandlers();
});

afterEach(() => {
  jest.useRealTimers();
});

beforeEach(() => {
  jest.clearAllMocks();
  resetBetaUpdatesHandlersForTests();
  resetBetaUpdatesStateForTests();
  resetSessionListenersForTests();
  mockUpdater = makeUpdater("2.49.0");
  mockStoreBuild = false;
  packaged = true;
  memoryUser = USER;
  mockStored = sessionFor(USER);
  resolveState = jest.fn(async () => "allowed" as BetaEligibilityState);
  extraCheck = jest.fn();
  intervals = [];
  setIntervalSpy = jest.fn((fn: () => void, ms: number) => {
    const t = { fn, ms, cleared: false };
    intervals.push(t);
    return t;
  });
  clearIntervalSpy = jest.fn((t: { cleared: boolean }) => {
    t.cleared = true;
  });
  applyBetaUpdatesOff(mockUpdater);
  installBetaUpdatesSessionReset();
  register();
});

/** preferences:update turning the stored value on for USER (save succeeds). */
async function turnOn(userId = USER): Promise<void> {
  cloud.getPreferences.mockResolvedValueOnce({});
  cloud.syncPreferences.mockResolvedValueOnce(undefined);
  await mockHandles["preferences:update"](event, userId, { updates: { betaUpdates: true } });
  await flush();
}

const activeIntervals = () => intervals.filter((t) => !t.cleared);

describe("E1 E3 E4 eligibility at apply time", () => {
  it("E1 ineligible user + stored on -> allowPrerelease false", async () => {
    resolveState.mockResolvedValue("blocked");
    await turnOn();
    expect(getBetaUpdatesInputs().stored).toEqual({ userId: USER, value: true });
    expect(mockUpdater.allowPrerelease).toBe(false);
  });

  it("eligible user + stored on -> allowPrerelease true, downgrade off", async () => {
    await turnOn();
    expect(mockUpdater.allowPrerelease).toBe(true);
    expect(mockUpdater.allowDowngrade).toBe(false);
  });

  it.each<[string, () => void]>([
    ["unknown", () => resolveState.mockResolvedValue("unknown")],
    ["the reader throws", () => resolveState.mockRejectedValue(new Error("boom"))],
    ["the session user cannot be read", () => { memoryUser = null; }],
  ])("E3 %s -> false, recorded as unknown", async (_l, arrange) => {
    arrange();
    await turnOn();
    expect(mockUpdater.allowPrerelease).toBe(false);
    expect(getBetaUpdatesInputs().eligibility).toEqual({ userId: USER, state: "unknown" });
  });

  it("E3 the read times out -> false, and the read is bounded", async () => {
    jest.useFakeTimers();
    try {
      resolveState.mockImplementation(() => new Promise(() => { /* never */ }));
      // Recording the stored value starts the bounded read (10 s).
      recordStoredBetaUpdates(USER, true, mockUpdater);
      const p = refreshBetaEligibility(1_000);
      await jest.advanceTimersByTimeAsync(BETA_ELIGIBILITY_TIMEOUT_MS);
      await expect(p).resolves.toBe("unknown");
      expect(mockUpdater.allowPrerelease).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it("E4 a prerelease build with stored on and ineligible -> false", async () => {
    mockUpdater = makeUpdater("2.50.0-beta.1");
    resetBetaUpdatesHandlersForTests();
    register();
    expect(mockUpdater.allowPrerelease).toBe(true); // library default on a beta build
    applyBetaUpdatesOff(mockUpdater);
    resolveState.mockResolvedValue("blocked");
    await turnOn();
    expect(mockUpdater.allowPrerelease).toBe(false);
  });

  it("E20 in-memory session user differs from the session file user -> unknown, false", async () => {
    memoryUser = OTHER;
    await turnOn();
    expect(getBetaUpdatesInputs().eligibility).toEqual({ userId: USER, state: "unknown" });
    expect(mockUpdater.allowPrerelease).toBe(false);
    expect(resolveState).not.toHaveBeenCalled();
  });
});

describe("E2 E16 before an update check", () => {
  it("E2 eligibility lost at runtime -> the next check runs with false", async () => {
    await turnOn();
    expect(mockUpdater.allowPrerelease).toBe(true);
    resolveState.mockResolvedValue("blocked");
    await runAfterBetaEligibility(() => mockUpdater.checkForUpdates());
    expect(mockUpdater.log.filter(([k]) => k === "checkForUpdates")).toEqual([["checkForUpdates", false]]);
  });

  it("E16 regular user: the check is called at once, with no eligibility read", () => {
    const check = jest.fn(() => Promise.resolve("checked"));
    const out = runAfterBetaEligibility(check);
    expect(check).toHaveBeenCalledTimes(1); // synchronously, before any await
    expect(resolveState).not.toHaveBeenCalled();
    return expect(out).resolves.toBe("checked");
  });

  it("E16 beta user: the read runs before the check", async () => {
    await turnOn();
    resolveState.mockClear();
    let releaseRead!: (v: BetaEligibilityState) => void;
    resolveState.mockImplementation(() => new Promise((r) => { releaseRead = r; }));
    const check = jest.fn(() => Promise.resolve(null));
    const out = runAfterBetaEligibility(check);
    await flush();
    expect(resolveState).toHaveBeenCalledTimes(1);
    expect(check).not.toHaveBeenCalled();
    releaseRead("allowed");
    await out;
    expect(check).toHaveBeenCalledTimes(1);
  });
});

describe("E5 E18 E6 startup and offline", () => {
  it("E5/E18 stored on: the startup check runs off while the read is held, then on", async () => {
    let releaseRead!: (v: BetaEligibilityState) => void;
    resolveState.mockImplementation(() => new Promise((r) => { releaseRead = r; }));
    mockStored = sessionFor(USER, { updates: { betaUpdates: true } });
    await runStartupUpdateCheck(mockUpdater as never, () => mockUpdater.checkForUpdates(), 5_000);
    expect(mockUpdater.log.filter(([k]) => k === "checkForUpdates")).toEqual([["checkForUpdates", false]]);
    await flush();
    releaseRead("allowed");
    await flush();
    expect(mockUpdater.allowPrerelease).toBe(true);
  });

  it("E6 offline at launch (unknown), then online: on within one retry tick", async () => {
    resolveState.mockResolvedValue("unknown");
    mockStored = sessionFor(USER, { updates: { betaUpdates: true } });
    await runStartupUpdateCheck(mockUpdater as never, () => mockUpdater.checkForUpdates(), 5_000);
    await flush();
    expect(mockUpdater.allowPrerelease).toBe(false);
    expect(activeIntervals()).toHaveLength(1);
    expect(activeIntervals()[0].ms).toBe(BETA_ELIGIBILITY_RETRY_MS);
    resolveState.mockResolvedValue("allowed");
    activeIntervals()[0].fn();
    await flush();
    expect(mockUpdater.allowPrerelease).toBe(true);
    expect(activeIntervals()).toHaveLength(0);
  });
});

describe("E7 regular user: no read, no timer, no delay", () => {
  it("startup, get, update and periodic/manual pre-checks make no eligibility read and arm no timer", async () => {
    mockStored = sessionFor(USER, { updates: { autoDownload: true } });
    await runStartupUpdateCheck(mockUpdater as never, () => mockUpdater.checkForUpdates(), 5_000);
    cloud.getPreferences.mockResolvedValueOnce({});
    await mockHandles["preferences:get"](event, USER);
    cloud.getPreferences.mockResolvedValueOnce({});
    cloud.syncPreferences.mockResolvedValueOnce(undefined);
    await mockHandles["preferences:update"](event, USER, { updates: { betaUpdates: false } });
    const check = jest.fn(() => Promise.resolve(null));
    runAfterBetaEligibility(check);
    expect(check).toHaveBeenCalledTimes(1);
    await flush();
    expect(resolveState).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(extraCheck).not.toHaveBeenCalled();
    expect(mockUpdater.allowPrerelease).toBe(false);
  });
});

describe("E8 E9 E15 E10 E11 E12 users, sessions, writes", () => {
  it("E8 eligibility recorded for another user never combines", async () => {
    recordStoredBetaUpdates(USER, true, mockUpdater);
    recordBetaEligibility(OTHER, "allowed", mockUpdater);
    expect(mockUpdater.allowPrerelease).toBe(false);
  });

  it("E9/E15 sign-out clears eligibility, turns off and stops the retry timer", async () => {
    resolveState.mockResolvedValue("unknown");
    await turnOn();
    expect(activeIntervals()).toHaveLength(1);
    emitSessionChanged({ kind: "cleared", userId: null });
    expect(getBetaUpdatesInputs()).toEqual({ stored: null, eligibility: null });
    expect(mockUpdater.allowPrerelease).toBe(false);
    expect(activeIntervals()).toHaveLength(0);
  });

  it("E10 a read in flight across a session change is dropped", async () => {
    await turnOn();
    let releaseRead!: (v: BetaEligibilityState) => void;
    resolveState.mockImplementation(() => new Promise((r) => { releaseRead = r; }));
    const p = refreshBetaEligibility(5_000);
    await flush();
    emitSessionChanged({ kind: "saved", userId: OTHER });
    releaseRead("allowed");
    await p;
    expect(getBetaUpdatesInputs().eligibility).toBeNull();
    expect(mockUpdater.allowPrerelease).toBe(false);
  });

  it("E11 a read for a user the session file does not name records nothing (local copy)", async () => {
    mockStored = sessionFor(USER, null);
    // The copy is stored for OTHER (renderer-supplied id), cloud read fails.
    mockStored.preferencesCopy = { userId: OTHER, preferences: { updates: { betaUpdates: true } }, copiedAt: "2026-11-01T10:00:00.000Z" };
    cloud.getPreferences.mockRejectedValueOnce(new Error("offline"));
    await mockHandles["preferences:get"](event, OTHER);
    await flush();
    expect(getBetaUpdatesInputs().stored).toBeNull();
    expect(mockUpdater.allowPrerelease).toBe(false);
  });

  it("E12 two in-order turn-ons end on", async () => {
    cloud.getPreferences.mockResolvedValue({});
    const saves: Array<() => void> = [];
    cloud.syncPreferences.mockImplementation(() => new Promise<void>((r) => { saves.push(() => r()); }));
    const first = mockHandles["preferences:update"](event, USER, { updates: { betaUpdates: true } }) as Promise<unknown>;
    const second = mockHandles["preferences:update"](event, USER, { updates: { betaUpdates: true } }) as Promise<unknown>;
    while (saves.length < 2) await new Promise((r) => setImmediate(r));
    saves[0]();
    await first;
    saves[1]();
    await second;
    await flush();
    expect(mockUpdater.allowPrerelease).toBe(true);
  });
});

describe("B1 an off write and failed saves", () => {
  it("B1 off at write start, then eligibility 'allowed' before the save resolves -> stays off, no extra check, no timer", async () => {
    resolveState.mockResolvedValue("unknown");
    await turnOn();
    expect(mockUpdater.allowPrerelease).toBe(false);
    expect(extraCheck).not.toHaveBeenCalled();
    cloud.getPreferences.mockResolvedValueOnce({ updates: { betaUpdates: true } });
    let releaseSave!: () => void;
    cloud.syncPreferences.mockImplementationOnce(() => new Promise<void>((r) => { releaseSave = () => r(); }));
    const off = mockHandles["preferences:update"](event, USER, { updates: { betaUpdates: false } }) as Promise<unknown>;
    resolveState.mockResolvedValue("allowed");
    await refreshBetaEligibility(5_000);
    expect(mockUpdater.allowPrerelease).toBe(false);
    expect(extraCheck).not.toHaveBeenCalled();
    expect(activeIntervals()).toHaveLength(0);
    await flush();
    releaseSave();
    await off;
    await refreshBetaEligibility(5_000);
    expect(mockUpdater.allowPrerelease).toBe(false);
    expect(extraCheck).not.toHaveBeenCalled();
  });

  it("failed off save: stays off, the switch shows off (what main holds)", async () => {
    await turnOn();
    expect(mockUpdater.allowPrerelease).toBe(true);
    cloud.getPreferences.mockResolvedValueOnce({ updates: { betaUpdates: true } });
    cloud.syncPreferences.mockRejectedValueOnce(new Error("offline"));
    const r = (await mockHandles["preferences:update"](event, USER, { updates: { betaUpdates: false } })) as { success: boolean };
    expect(r.success).toBe(false);
    await refreshBetaEligibility(5_000);
    expect(mockUpdater.allowPrerelease).toBe(false);
    const state = await getBetaUpdatesState();
    expect(state).toEqual({ visible: true, stored: false, applied: false, eligibility: "allowed", note: null });
  });

  it("failed on save: never on, the switch shows off", async () => {
    cloud.getPreferences.mockResolvedValueOnce({});
    cloud.syncPreferences.mockRejectedValueOnce(new Error("offline"));
    const r = (await mockHandles["preferences:update"](event, USER, { updates: { betaUpdates: true } })) as { success: boolean };
    expect(r.success).toBe(false);
    await refreshBetaEligibility(5_000);
    expect(mockUpdater.allowPrerelease).toBe(false);
    expect(extraCheck).not.toHaveBeenCalled();
    expect((await getBetaUpdatesState()).stored).toBe(false);
  });

  it("Settings state after a sign-in ignores a read in flight for the previous user", async () => {
    let releaseRead!: (v: BetaEligibilityState) => void;
    resolveState.mockImplementation(() => new Promise((r) => { releaseRead = r; }));
    recordStoredBetaUpdates(USER, true, mockUpdater);
    await flush();
    emitSessionChanged({ kind: "saved", userId: OTHER });
    mockStored = sessionFor(OTHER);
    memoryUser = OTHER;
    const statePromise = getBetaUpdatesState();
    await flush();
    releaseRead("allowed");
    const state = await statePromise;
    expect(state.eligibility).toBe("unknown");
    expect(state.visible).toBe(false);
  });
});

describe("E17 one extra update check per session", () => {
  it("beta user: exactly one, the first time eligibility is confirmed", async () => {
    await turnOn();
    expect(extraCheck).toHaveBeenCalledTimes(1);
    await refreshBetaEligibility(5_000);
    await turnOn();
    expect(extraCheck).toHaveBeenCalledTimes(1);
  });

  it("skipped while a check is running, and once an update has been offered", async () => {
    mockUpdater.emit("checking-for-update");
    await turnOn();
    expect(extraCheck).not.toHaveBeenCalled();
    mockUpdater.emit("update-available", { version: "2.49.1" });
    await refreshBetaEligibility(5_000);
    expect(extraCheck).not.toHaveBeenCalled();
  });

  it("after a session change, the next user may get one", async () => {
    await turnOn();
    emitSessionChanged({ kind: "cleared", userId: null });
    mockStored = sessionFor(OTHER);
    memoryUser = OTHER;
    await turnOn(OTHER);
    expect(extraCheck).toHaveBeenCalledTimes(2);
  });
});

describe("V1 V2 V3 Settings state (decided in main)", () => {
  it.each<[string, () => void]>([
    ["Store build", () => { mockStoreBuild = true; }],
    ["unpackaged build", () => { packaged = false; }],
  ])("%s: hidden, and no eligibility read", async (_l, arrange) => {
    arrange();
    recordStoredBetaUpdates(USER, true, mockUpdater);
    await flush();
    resolveState.mockClear();
    const state = await getBetaUpdatesState();
    expect(state.visible).toBe(false);
    expect(resolveState).not.toHaveBeenCalled();
  });

  it("regular user (stored off, not eligible): hidden after one read", async () => {
    resolveState.mockResolvedValue("blocked");
    const state = await getBetaUpdatesState();
    expect(state).toEqual({ visible: false, stored: false, applied: false, eligibility: "blocked", note: null });
    expect(resolveState).toHaveBeenCalledTimes(1);
  });

  it("prerelease build alone (stored off, not eligible): hidden", async () => {
    mockUpdater = makeUpdater("2.50.0-beta.1");
    resetBetaUpdatesHandlersForTests();
    register();
    resolveState.mockResolvedValue("blocked");
    expect((await getBetaUpdatesState()).visible).toBe(false);
  });

  it("eligible, stored off: visible, unchecked, no note", async () => {
    const state = await getBetaUpdatesState();
    expect(state).toEqual({ visible: true, stored: false, applied: false, eligibility: "allowed", note: null });
  });

  it("stored on, not eligible: visible, stored true, note not_available", async () => {
    resolveState.mockResolvedValue("blocked");
    await turnOn();
    expect(await getBetaUpdatesState()).toEqual({ visible: true, stored: true, applied: false, eligibility: "blocked", note: "not_available" });
  });

  it("stored on, unknown: visible, stored true, note unreachable", async () => {
    resolveState.mockResolvedValue("unknown");
    await turnOn();
    expect(await getBetaUpdatesState()).toEqual({ visible: true, stored: true, applied: false, eligibility: "unknown", note: "unreachable" });
  });

  it("stored on, eligible: applied, no note", async () => {
    await turnOn();
    expect(await getBetaUpdatesState()).toEqual({ visible: true, stored: true, applied: true, eligibility: "allowed", note: null });
  });

  it("stored value not yet recorded: read from the local copy", async () => {
    mockStored = sessionFor(USER, { updates: { betaUpdates: true } });
    resolveState.mockResolvedValue("blocked");
    const state = await getBetaUpdatesState();
    expect(state.stored).toBe(true);
    expect(state.visible).toBe(true);
  });

  it("the IPC channel answers the same state", async () => {
    resolveState.mockResolvedValue("blocked");
    expect(await mockHandles["updates:get-beta-state"]()).toEqual(await getBetaUpdatesState());
  });
});

describe("E13 only recompute writes allowPrerelease = true", () => {
  it("every true write in this file's paths comes from recompute", async () => {
    await turnOn();
    cloud.getPreferences.mockResolvedValueOnce({ updates: { betaUpdates: true } });
    await mockHandles["preferences:get"](event, USER);
    mockStored = sessionFor(USER, { updates: { betaUpdates: true } });
    await runStartupUpdateCheck(mockUpdater as never, () => mockUpdater.checkForUpdates(), 5_000);
    await refreshBetaEligibility(5_000);
    await flush();
    expect(mockUpdater.trueWriters.length).toBeGreaterThan(0);
    for (const stack of mockUpdater.trueWriters) {
      const frame = stack.split("\n").find((l) => l.includes("updateChannelPolicy"));
      expect(frame).toMatch(/at recompute /);
    }
  });

  it("the policy exports no value-taking apply function", () => {
    const exported = Object.keys(policy);
    expect(exported).toContain("recompute");
    expect(exported).toContain("applyBetaUpdatesOff");
    expect(exported).not.toContain("applyBetaUpdates");
    expect(exported).not.toContain("applyBetaUpdatesFor");
  });

  it("no production file under electron/ assigns allowPrerelease outside the policy", () => {
    const root = path.resolve(__dirname, "../..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "__tests__" || e.name === "node_modules") continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) files.push(full);
      }
    };
    walk(root);
    const assigns = /allowPrerelease\s*=[^=]|\[\s*["'`]allowPrerelease["'`]\s*\]\s*=[^=]|Object\.assign\([^)]*allowPrerelease/;
    expect(assigns.test("updater.allowPrerelease = true")).toBe(true);
    expect(assigns.test('u["allowPrerelease"] = x')).toBe(true);
    const hits = files
      .filter((f) => assigns.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(root, f).split(path.sep).join("/"));
    expect(hits).toEqual(["services/updateChannelPolicy.ts"]);
    const src = fs.readFileSync(path.join(root, "services/updateChannelPolicy.ts"), "utf8");
    const trueWrites = src.match(/allowPrerelease = true;/g) ?? [];
    expect(trueWrites).toHaveLength(1);
    const recomputeBody = src.slice(src.indexOf("export function recompute("), src.indexOf("export function recordStoredBetaUpdates("));
    expect(recomputeBody).toContain("updater.allowPrerelease = true;");
  });
});

describe("R6 manual and periodic wiring (text)", () => {
  const ELECTRON = path.resolve(__dirname, "../..");
  it("the manual check runs inside the existing timeout race", () => {
    const src = fs.readFileSync(path.join(ELECTRON, "handlers/updaterHandlers.ts"), "utf8");
    expect(src).toMatch(/Promise\.race\(\[\s*(?:\/\/[^\n]*\n\s*)*runAfterBetaEligibility\(\(\) => autoUpdater\.checkForUpdates\(\)\),/);
    expect(src.match(/autoUpdater\.checkForUpdates\(\)/g)).toHaveLength(1);
  });
  it("the periodic check goes through runAfterBetaEligibility", () => {
    const main = fs.readFileSync(path.join(ELECTRON, "main.ts"), "utf8");
    expect(main).toMatch(/runAfterBetaEligibility\(\(\) => checkForUpdatesUnlessStore\(autoUpdater, "periodic"\)\)/);
  });
});
