/**
 * @jest-environment node
 */

/**
 * BACKLOG-4245: the beta-updates preference drives autoUpdater.allowPrerelease.
 *
 * B1  bag -> value: only an explicit `updates.betaUpdates === true` is on
 * B2  apply: allowPrerelease follows the value both ways, allowDowngrade is
 *     forced false every time, channel is never assigned
 * B3  regular user: with the preference absent or false, the updater's
 *     properties and calls at startup equal the base branch's
 * B4  startup read: every failed leg, slow read, error and wrong type is OFF,
 *     including on a prerelease build (library default on)
 * B5  ordering: the value is set before the startup check is called
 * B6  runtime change: preferences:update / preferences:get re-apply it
 * B7  main.ts wiring (text): the off value is applied when the updater is
 *     configured, before the first check entry point; channel never assigned
 *
 * Updater stand-ins are seeded from electron-updater 6.8.9's constructor
 * defaults (AppUpdater.js:109 autoDownload true, :125/:218 allowPrerelease =
 * "version has a prerelease part", :138 allowDowngrade false, :173 channel
 * null), and record every assignment through setters.
 *
 * Real: updateChannelPolicy, updateDownloadPolicy, preferencesMirror,
 * preferenceHandlers. Stand-ins: electron, electron-updater, the session
 * file, the cloud.
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
  app: { getVersion: () => "2.49.0", isPackaged: true },
}));

type Event = [string, unknown];

/** An updater stand-in with library defaults and an assignment log. */
function makeUpdater(version: string) {
  const log: Event[] = [];
  const state = {
    autoDownload: true,
    allowPrerelease: /^\d+\.\d+\.\d+-/.test(version),
    allowDowngrade: false,
    channel: null as string | null,
  };
  const updater = {
    log,
    get autoDownload() {
      return state.autoDownload;
    },
    set autoDownload(v: boolean) {
      log.push(["autoDownload", v]);
      state.autoDownload = v;
    },
    get allowPrerelease() {
      return state.allowPrerelease;
    },
    set allowPrerelease(v: boolean) {
      log.push(["allowPrerelease", v]);
      state.allowPrerelease = v;
    },
    get allowDowngrade() {
      return state.allowDowngrade;
    },
    set allowDowngrade(v: boolean) {
      log.push(["allowDowngrade", v]);
      state.allowDowngrade = v;
    },
    get channel() {
      return state.channel;
    },
    set channel(v: string | null) {
      // Same side effect as the library setter (AppUpdater.js:44).
      log.push(["channel", v]);
      state.channel = v;
      state.allowDowngrade = true;
    },
    checkForUpdates: jest.fn(() => {
      log.push(["checkForUpdates", { ...state }]);
      return Promise.resolve(null);
    }),
    setFeedURL: jest.fn(),
    snapshot: () => ({ ...state }),
  };
  return updater;
}

let mockUpdater = makeUpdater("2.49.0");
jest.mock("electron-updater", () => ({
  get autoUpdater() {
    return mockUpdater;
  },
}));

jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../failureLogService", () => ({ __esModule: true, default: { logFailure: jest.fn() } }));

type Session = Record<string, unknown>;
let mockStored: Session | null = null;
let mockPeekImpl: (() => Promise<unknown>) | null = null;
jest.mock("../sessionService", () => ({
  __esModule: true,
  default: {
    peekSession: () =>
      mockPeekImpl ? mockPeekImpl() : Promise.resolve(mockStored ? { status: "ok", session: mockStored } : { status: "none" }),
    loadSession: jest.fn(async () => mockStored),
    updateSession: jest.fn(async () => true),
    getGeneration: () => 1,
  },
}));

jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: { getPreferences: jest.fn(), syncPreferences: jest.fn(), getAuthUserId: jest.fn() },
}));

import {
  applyBetaUpdates,
  betaUpdatesFromPreferences,
  betaUpdatesInPartial,
} from "../updateChannelPolicy";
import { applyAutoDownload, runStartupUpdateCheck } from "../updateDownloadPolicy";
import { registerPreferenceHandlers } from "../../handlers/preferenceHandlers";
import supabaseService from "../supabaseService";

const cloud = supabaseService as jest.Mocked<typeof supabaseService>;

// pii-allow-uuid: invented, not from any live row
const USER = "00000000-0000-4000-8000-000000000001";
// pii-allow-uuid: invented, not from any live row
const OTHER_USER = "00000000-0000-4000-8000-000000000002";

function sessionWith(prefs: Record<string, unknown> | null, opts: { userId?: string; expiresAt?: number } = {}): Session {
  const s: Session = { user: { id: opts.userId ?? USER }, expiresAt: opts.expiresAt ?? Date.now() + 3_600_000 };
  if (prefs) {
    s.preferencesCopy = { userId: USER, preferences: prefs, copiedAt: "2026-11-01T10:00:00.000Z" };
  }
  return s;
}

/**
 * The startup sequence main.ts runs: configure (applyBetaUpdates(false) next
 * to the logger), then the delayed runStartupUpdateCheck. `withBaseline`
 * false reproduces the base branch, which has neither line.
 */
async function startup(updater: ReturnType<typeof makeUpdater>, withBaseline: boolean) {
  if (withBaseline) applyBetaUpdates(false, updater);
  await runStartupUpdateCheck(updater, () => updater.checkForUpdates());
}

/** The base branch's startup (transcribed from int-portal/release-2.49 @ a7023f684:
 * main.ts:1682 sets only `logger`; main.ts:1366 runs runStartupUpdateCheck,
 * which applies autoDownload and then calls the check). */
async function baseStartup(updater: ReturnType<typeof makeUpdater>, storedAutoDownload: boolean) {
  applyAutoDownload(storedAutoDownload, updater);
  await updater.checkForUpdates();
}

beforeAll(() => {
  registerPreferenceHandlers();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockStored = null;
  mockPeekImpl = null;
  mockUpdater = makeUpdater("2.49.0");
});

const event = {} as IpcMainInvokeEvent;

describe("B1 betaUpdatesFromPreferences: only an explicit true is on", () => {
  it.each([
    [undefined, false],
    [null, false],
    ["true", false],
    [[], false],
    [{}, false],
    [{ updates: null }, false],
    [{ updates: {} }, false],
    [{ updates: { betaUpdates: "true" } }, false],
    [{ updates: { betaUpdates: 1 } }, false],
    [{ updates: { betaUpdates: {} } }, false],
    [{ updates: { betaUpdates: false } }, false],
    [{ updates: { betaUpdates: true } }, true],
  ])("%j -> %s", (bag, expected) => {
    expect(betaUpdatesFromPreferences(bag)).toBe(expected);
  });

  it("a bag whose getter throws -> false", () => {
    const bag = {
      get updates(): unknown {
        throw new Error("boom");
      },
    };
    expect(betaUpdatesFromPreferences(bag)).toBe(false);
  });

  it.each([
    [{}, null],
    [{ updates: { autoDownload: false } }, null],
    [{ updates: { betaUpdates: true } }, true],
    [{ updates: { betaUpdates: false } }, false],
    [{ updates: { betaUpdates: "yes" } }, false],
    [{ updates: { betaUpdates: null } }, false],
  ])("partial %j -> %s", (partial, expected) => {
    expect(betaUpdatesInPartial(partial)).toBe(expected);
  });
});

describe("B2 apply: both directions, downgrade forced off, channel never assigned", () => {
  it.each([
    ["stable build, on", "2.49.0", true, true],
    ["stable build, off", "2.49.0", false, false],
    ["beta build, on", "2.50.0-beta.1", true, true],
    ["beta build, off", "2.50.0-beta.1", false, false],
  ])("%s -> allowPrerelease %s", (_label, version, value, expected) => {
    const u = makeUpdater(version);
    applyBetaUpdates(value, u);
    expect(u.allowPrerelease).toBe(expected);
    expect(u.allowDowngrade).toBe(false);
    expect(u.log).toContainEqual(["allowPrerelease", expected]);
    expect(u.log).toContainEqual(["allowDowngrade", false]);
    expect(u.log.filter(([k]) => k === "channel")).toEqual([]);
  });

  it("a downgrade left on by anything earlier is turned off", () => {
    const u = makeUpdater("2.50.0-beta.1");
    u.allowDowngrade = true;
    applyBetaUpdates(true, u);
    expect(u.allowDowngrade).toBe(false);
    applyBetaUpdates(false, u);
    expect(u.allowDowngrade).toBe(false);
  });

  it("a throwing updater does not throw out of apply", () => {
    const u = {
      set allowPrerelease(_v: boolean) {
        throw new Error("boom");
      },
      get allowPrerelease() {
        return false;
      },
      allowDowngrade: true,
    };
    expect(() => applyBetaUpdates(true, u)).not.toThrow();
    expect(u.allowDowngrade).toBe(false);
  });
});

describe("B3 regular user: identical to the base branch", () => {
  it.each<[string, Record<string, unknown> | null]>([
    ["signed out", null],
    ["preference absent", { export: { defaultFormat: "pdf" } }],
    ["preference false", { updates: { betaUpdates: false } }],
    ["auto-download off, preference absent", { updates: { autoDownload: false } }],
  ])("%s: same properties and same calls", async (_label, prefs) => {
    mockStored = prefs ? sessionWith(prefs) : null;
    const storedAutoDownload = !(prefs && (prefs.updates as { autoDownload?: boolean } | undefined)?.autoDownload === false);

    const base = makeUpdater("2.49.0");
    await baseStartup(base, storedAutoDownload);
    const now = makeUpdater("2.49.0");
    await startup(now, true);

    expect(now.snapshot()).toEqual(base.snapshot());
    expect(now.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(now.setFeedURL).not.toHaveBeenCalled();
    // What the check saw, field by field.
    const seen = (u: typeof now) => u.log.filter(([k]) => k === "checkForUpdates").map(([, s]) => s);
    expect(seen(now)).toEqual(seen(base));
    expect(seen(now)).toEqual([{ autoDownload: storedAutoDownload, allowPrerelease: false, allowDowngrade: false, channel: null }]);
  });
});

describe("B4 startup read: every failure leaves prereleases OFF", () => {
  it("stored true -> on", async () => {
    mockStored = sessionWith({ updates: { betaUpdates: true } });
    const u = makeUpdater("2.49.0");
    await startup(u, true);
    expect(u.allowPrerelease).toBe(true);
    expect(u.allowDowngrade).toBe(false);
  });

  it.each<[string, () => void]>([
    ["no session file", () => { mockStored = null; }],
    ["unreadable session", () => { mockPeekImpl = async () => ({ status: "unreadable" }); }],
    ["expired session", () => { mockStored = sessionWith({ updates: { betaUpdates: true } }, { expiresAt: Date.now() - 1000 }); }],
    ["session without a copy", () => { mockStored = sessionWith(null); }],
    ["copy for another user", () => { mockStored = sessionWith({ updates: { betaUpdates: true } }, { userId: OTHER_USER }); }],
    ["copy without the field", () => { mockStored = sessionWith({ updates: { autoDownload: true } }); }],
    ["field is a string", () => { mockStored = sessionWith({ updates: { betaUpdates: "true" } }); }],
    ["field is a number", () => { mockStored = sessionWith({ updates: { betaUpdates: 1 } }); }],
    ["updates is not an object", () => { mockStored = sessionWith({ updates: "on" }); }],
    ["peek rejects", () => { mockPeekImpl = async () => { throw new Error("boom"); }; }],
    ["peek throws synchronously", () => { mockPeekImpl = () => { throw new Error("boom"); }; }],
  ])("beta build, %s -> OFF at the check", async (_label, arrange) => {
    arrange();
    const u = makeUpdater("2.50.0-beta.1");
    await startup(u, true);
    const atCheck = u.log.filter(([k]) => k === "checkForUpdates").map(([, s]) => s);
    expect(atCheck).toEqual([expect.objectContaining({ allowPrerelease: false, allowDowngrade: false, channel: null })]);
  });

  it("beta build, read slower than the timeout -> OFF, and the check still runs", async () => {
    mockPeekImpl = () => new Promise(() => { /* never resolves */ });
    const u = makeUpdater("2.50.0-beta.1");
    await runStartupUpdateCheck(u, () => u.checkForUpdates(), 20);
    expect(u.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(u.allowPrerelease).toBe(false);
  });

  it("an updater that throws on assignment does not stop the check", async () => {
    mockStored = sessionWith({ updates: { betaUpdates: true } });
    const u = {
      autoDownload: true,
      allowDowngrade: false,
      get allowPrerelease() {
        return false;
      },
      set allowPrerelease(_v: boolean) {
        throw new Error("boom");
      },
    };
    const runCheck = jest.fn(() => "checked");
    await expect(runStartupUpdateCheck(u, runCheck)).resolves.toBe("checked");
    expect(runCheck).toHaveBeenCalledTimes(1);
  });
});

describe("B5 ordering: the value is applied before the startup check", () => {
  it("stored true: allowPrerelease true is assigned before checkForUpdates", async () => {
    mockStored = sessionWith({ updates: { betaUpdates: true } });
    const u = makeUpdater("2.49.0");
    await startup(u, true);
    const keys = u.log.map(([k, v]) => (k === "checkForUpdates" ? k : `${k}=${String(v)}`));
    const check = keys.indexOf("checkForUpdates");
    expect(check).toBeGreaterThan(-1);
    expect(keys.lastIndexOf("allowPrerelease=true")).toBeGreaterThan(-1);
    expect(keys.lastIndexOf("allowPrerelease=true")).toBeLessThan(check);
    expect(keys.lastIndexOf("allowDowngrade=false")).toBeLessThan(check);
    expect(u.log[check][1]).toEqual(expect.objectContaining({ allowPrerelease: true, allowDowngrade: false }));
  });

  it("the check is not called until the stored read has finished", async () => {
    let release!: (v: unknown) => void;
    mockPeekImpl = () => new Promise((r) => { release = r; });
    const u = makeUpdater("2.49.0");
    const done = runStartupUpdateCheck(u, () => u.checkForUpdates(), 5_000);
    await new Promise((r) => setImmediate(r));
    expect(u.checkForUpdates).not.toHaveBeenCalled();
    mockStored = sessionWith({ updates: { betaUpdates: true } });
    release({ status: "ok", session: mockStored });
    await done;
    expect(u.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(u.log.find(([k]) => k === "checkForUpdates")?.[1]).toEqual(expect.objectContaining({ allowPrerelease: true }));
  });
});

describe("B6 runtime change: the preference is re-applied", () => {
  it("preferences:update on -> on (after the save), then off -> off", async () => {
    cloud.getPreferences.mockResolvedValue({});
    cloud.syncPreferences.mockResolvedValue(undefined);
    await mockHandles["preferences:update"](event, USER, { updates: { betaUpdates: true } });
    expect(mockUpdater.allowPrerelease).toBe(true);
    expect(mockUpdater.allowDowngrade).toBe(false);
    await mockHandles["preferences:update"](event, USER, { updates: { betaUpdates: false } });
    expect(mockUpdater.allowPrerelease).toBe(false);
    expect(mockUpdater.allowDowngrade).toBe(false);
    expect(mockUpdater.log.filter(([k]) => k === "channel")).toEqual([]);
  });

  it("preferences:update on, save fails -> stays off", async () => {
    cloud.getPreferences.mockResolvedValue({});
    cloud.syncPreferences.mockRejectedValue(new Error("offline"));
    await mockHandles["preferences:update"](event, USER, { updates: { betaUpdates: true } });
    expect(mockUpdater.allowPrerelease).toBe(false);
  });

  it("preferences:update on, then off before the first save finishes -> off", async () => {
    cloud.getPreferences.mockResolvedValue({});
    const saves: Array<() => void> = [];
    cloud.syncPreferences.mockImplementation(
      () => new Promise<void>((resolve) => { saves.push(() => resolve()); }),
    );
    const on = mockHandles["preferences:update"](event, USER, { updates: { betaUpdates: true } }) as Promise<unknown>;
    const off = mockHandles["preferences:update"](event, USER, { updates: { betaUpdates: false } }) as Promise<unknown>;
    while (saves.length < 2) await new Promise((r) => setImmediate(r));
    expect(mockUpdater.allowPrerelease).toBe(false);
    saves[0]();
    await on;
    expect(mockUpdater.allowPrerelease).toBe(false);
    saves[1]();
    await off;
    expect(mockUpdater.allowPrerelease).toBe(false);
  });

  it("preferences:update on twice, saves finishing out of order -> on", async () => {
    cloud.getPreferences.mockResolvedValue({});
    const saves: Array<() => void> = [];
    cloud.syncPreferences.mockImplementation(
      () => new Promise<void>((resolve) => { saves.push(() => resolve()); }),
    );
    const first = mockHandles["preferences:update"](event, USER, { updates: { betaUpdates: true } }) as Promise<unknown>;
    const second = mockHandles["preferences:update"](event, USER, { updates: { betaUpdates: true } }) as Promise<unknown>;
    while (saves.length < 2) await new Promise((r) => setImmediate(r));
    saves[1]();
    await second;
    expect(mockUpdater.allowPrerelease).toBe(true);
    saves[0]();
    await first;
    expect(mockUpdater.allowPrerelease).toBe(true);
  });

  it("preferences:update with a non-boolean value -> off", async () => {
    mockUpdater = makeUpdater("2.50.0-beta.1");
    cloud.getPreferences.mockResolvedValue({});
    cloud.syncPreferences.mockResolvedValue(undefined);
    await mockHandles["preferences:update"](event, USER, { updates: { betaUpdates: "true" } });
    expect(mockUpdater.allowPrerelease).toBe(false);
  });

  it("preferences:update for another field leaves the value alone", async () => {
    cloud.getPreferences.mockResolvedValue({});
    cloud.syncPreferences.mockResolvedValue(undefined);
    applyBetaUpdates(true, mockUpdater);
    await mockHandles["preferences:update"](event, USER, { updates: { autoDownload: false } });
    expect(mockUpdater.allowPrerelease).toBe(true);
  });

  it("preferences:get applies the cloud value both ways", async () => {
    cloud.getPreferences.mockResolvedValueOnce({ updates: { betaUpdates: true } });
    await mockHandles["preferences:get"](event, USER);
    expect(mockUpdater.allowPrerelease).toBe(true);
    cloud.getPreferences.mockResolvedValueOnce({});
    await mockHandles["preferences:get"](event, USER);
    expect(mockUpdater.allowPrerelease).toBe(false);
    expect(mockUpdater.allowDowngrade).toBe(false);
  });

  it("preferences:get offline applies the local copy's value", async () => {
    cloud.getPreferences.mockRejectedValue(new Error("offline"));
    mockStored = sessionWith({ updates: { betaUpdates: true } });
    const result = (await mockHandles["preferences:get"](event, USER)) as { source?: string };
    expect(result.source).toBe("copy");
    expect(mockUpdater.allowPrerelease).toBe(true);
  });

  it("preferences:get failed with no copy -> off", async () => {
    applyBetaUpdates(true, mockUpdater);
    cloud.getPreferences.mockRejectedValue(new Error("offline"));
    mockStored = null;
    const result = (await mockHandles["preferences:get"](event, USER)) as { success: boolean };
    expect(result.success).toBe(false);
    expect(mockUpdater.allowPrerelease).toBe(false);
  });
});

const ELECTRON_DIR = path.resolve(__dirname, "../..");
const MAIN = fs.readFileSync(path.join(ELECTRON_DIR, "main.ts"), "utf8");

function productionSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...productionSources(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("B7 main.ts wiring (text)", () => {
  it("the off value is applied right after the updater is configured", () => {
    expect(MAIN).toMatch(/autoUpdater\.logger = log;[\s\S]{0,400}?applyBetaUpdates\(false, autoUpdater\);/);
  });

  it("the off value is applied before every check entry point in the file", () => {
    const baseline = MAIN.indexOf("applyBetaUpdates(false, autoUpdater);");
    expect(baseline).toBeGreaterThan(-1);
    const whenReady = MAIN.indexOf("app.whenReady().then(");
    expect(whenReady).toBeGreaterThan(-1);
    expect(baseline).toBeGreaterThan(whenReady);
    for (const marker of ["createWindow();", "registerUpdaterHandlers();", 'checkForUpdatesUnlessStore(autoUpdater, "periodic")']) {
      const at = MAIN.indexOf(marker, whenReady);
      expect([marker, at > baseline]).toEqual([marker, true]);
    }
  });

  it("no production file under electron/ assigns an updater channel", () => {
    const files = productionSources(ELECTRON_DIR);
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(path.join(ELECTRON_DIR, "main.ts"));
    // Any `<name>pdater.channel =` / `<name>pdater["channel"] =` assignment.
    const assigns = /[Uu]pdater(?:\.channel|\[\s*["'`]channel["'`]\s*\])\s*=[^=]/;
    // The pattern finds the shapes it is meant to find.
    expect(assigns.test('autoUpdater.channel = "beta"')).toBe(true);
    expect(assigns.test("updater['channel'] = x")).toBe(true);
    expect(assigns.test("autoUpdater.channel === null")).toBe(false);
    const hits = files.filter((f) => assigns.test(fs.readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
});
