/**
 * @jest-environment node
 */
/**
 * BACKLOG-4185 PR B: the device-profile service — once-guard, gate, pending
 * clear, quiet scheduler, change detector — against injected fakes.
 *
 * Rows map to the plan's controls (pm_comments 0bd20b39 / d74c0c2e):
 *   P6  change detector boundaries      P7/P7c once per process
 *   P8  no sync child process           P9  pending clear (file = flag)
 *   P10 counts gate (C1)                P13 bounded skip + marker (C2)
 *   B1  no main-thread DB / event loop  B3  OFF / ON again
 *   C5  OFF clears immediately
 */
import {
  COUNTS_CHECK_MS,
  COUNTS_MAX_CHECKS,
  POOL_WAIT_MS,
  QUIET_MS,
  countsGate,
  createDeviceProfileService,
  deviceKeyOf,
  shouldWrite,
  type DataSizeCounts,
  type ServiceDeps,
  type StateEntry,
  type StateFile,
} from "../deviceProfileService";
import { randomUUID } from "crypto";
import { __resetDeviceRowIdForTests, getDeviceRowId } from "../deviceRowId";
import type { CollectedProfile, DeviceProfileRow } from "../buildDeviceProfile";

const USER = "user-a";
const DEVICE = "machine-id-a";
const ROW = randomUUID();

const HW: CollectedProfile = {
  platform: "darwin",
  cpuModel: "Apple M1 Max",
  cpuCores: 10,
  ramBytes: 32 * 1024 ** 3,
  diskType: "ssd",
  diskBus: "nvme",
  osVersion: "15.7.3",
  osBuild: "24G419",
  av: "notApplicable",
};

interface Harness {
  deps: ServiceDeps;
  updates: Array<{ userId: string; deviceId: string; profile: DeviceProfileRow | null }>;
  state: { file: StateFile | null };
  gate: { on: boolean };
  pool: { ready: boolean; inflight: number };
  countsCalls: number;
  checks: number;
  collects: number;
  updateOk: { value: boolean };
}

function harness(over: Partial<ServiceDeps> = {}): Harness {
  const h = {
    updates: [] as Harness["updates"],
    state: { file: null as StateFile | null },
    gate: { on: true },
    pool: { ready: true, inflight: 0 },
    countsCalls: 0,
    checks: 0,
    collects: 0,
    updateOk: { value: true },
  } as Harness;
  h.deps = {
    isGateOn: () => h.gate.on,
    isPoolReady: () => h.pool.ready,
    getPoolQueryCount: () => {
      h.checks += 1;
      return h.pool.inflight;
    },
    queryCounts: async (): Promise<DataSizeCounts> => {
      h.countsCalls += 1;
      return { contacts: 2040, addressBook: 512, mailAccounts: 2 };
    },
    dbBytes: async () => 1_500 * 1024 ** 2,
    collectHardware: async () => {
      h.collects += 1;
      return { ...HW };
    },
    updateRow: async (userId, deviceId, profile) => {
      h.updates.push({ userId, deviceId, profile });
      return h.updateOk.value ? { ok: true, rows: 1 } : { ok: false, rows: 0 };
    },
    readState: async () => (h.state.file ? JSON.parse(JSON.stringify(h.state.file)) : null),
    writeState: async (s) => {
      h.state.file = s;
    },
    removeState: async () => {
      h.state.file = null;
    },
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    warn: () => undefined,
    ...over,
  };
  return h;
}

/** Runs a registration to completion under fake timers (pool ready -> quiet -> counts). */
async function settle(p: Promise<unknown>): Promise<void> {
  for (let i = 0; i < 40; i++) await jest.advanceTimersByTimeAsync(10_000);
  await p;
}

beforeEach(() => {
  jest.useFakeTimers({ now: 1_700_000_000_000 });
  __resetDeviceRowIdForTests();
});
afterEach(() => {
  jest.useRealTimers();
});

describe("P6 shouldWrite", () => {
  const base: StateEntry = {
    deviceKey: "k",
    rowId: null,
    fp: { osBuild: "24G419", ramGB: 32, addressBook: 100_000, contacts: 0, dbMB: 1000 },
    writtenAt: "x",
  };
  const next = (fp: Partial<StateEntry["fp"]>, deviceKey = "k") => ({ deviceKey, fp: { ...base.fp, ...fp } });

  it("login always writes; no previous state writes", () => {
    expect(shouldWrite(base, next({}), "login")).toBe(true);
    expect(shouldWrite(null, next({}), "restore")).toBe(true);
  });
  it("unchanged restore does not write", () => {
    expect(shouldWrite(base, next({}), "restore")).toBe(false);
  });
  it("a new deviceKey, osBuild or ramGB writes", () => {
    expect(shouldWrite(base, next({}, "other"), "restore")).toBe(true);
    expect(shouldWrite(base, next({ osBuild: "24G500" }), "restore")).toBe(true);
    expect(shouldWrite(base, next({ ramGB: 64 }), "restore")).toBe(true);
  });
  it("counts: strictly more than 20% (sweep 119k / 120k / 121k on 100k)", () => {
    expect(shouldWrite(base, next({ addressBook: 119_000 }), "restore")).toBe(false);
    expect(shouldWrite(base, next({ addressBook: 120_000 }), "restore")).toBe(false);
    expect(shouldWrite(base, next({ addressBook: 121_000 }), "restore")).toBe(true);
    expect(shouldWrite(base, next({ addressBook: 79_000 }), "restore")).toBe(true);
    expect(shouldWrite(base, next({ addressBook: 80_000 }), "restore")).toBe(false);
  });
  it("0 -> n is a change; an absent count is not compared", () => {
    expect(shouldWrite(base, next({ contacts: 3 }), "restore")).toBe(true);
    expect(shouldWrite(base, next({ addressBook: undefined }), "restore")).toBe(false);
  });
});

describe("P10 countsGate (C1)", () => {
  const t0 = 1_000_000;
  it("needs pool ready AND idle AND quiet; 120 s boundary at 119_999 / 120_000", () => {
    expect(countsGate(t0 + QUIET_MS - 1, t0, true, 0)).toBe(false);
    expect(countsGate(t0 + QUIET_MS, t0, true, 0)).toBe(true);
    expect(countsGate(t0 + QUIET_MS, t0, true, 1)).toBe(false);
  });
  it("C1: pool not ready with a zero count is NOT a pass", () => {
    expect(countsGate(t0 + QUIET_MS * 2, t0, false, 0)).toBe(false);
  });
});

describe("P7 / P7c once per process", () => {
  it("three concurrent restores collect and write once", async () => {
    const h = harness();
    const s = createDeviceProfileService(h.deps);
    const all = Promise.all([1, 2, 3].map(() => s.onDeviceRegistered(USER, DEVICE, "restore", ROW)));
    await settle(all);
    expect(h.collects).toBe(1);
    expect(h.updates).toHaveLength(1);
  });
  it("login plus two concurrent restores: one run (login marks the user)", async () => {
    const h = harness();
    const s = createDeviceProfileService(h.deps);
    const all = Promise.all([
      s.onDeviceRegistered(USER, DEVICE, "login", ROW),
      s.onDeviceRegistered(USER, DEVICE, "restore", ROW),
      s.onDeviceRegistered(USER, DEVICE, "restore", ROW),
    ]);
    await settle(all);
    expect(h.collects).toBe(1);
    expect(h.updates).toHaveLength(1);
  });
  it("a later login runs again", async () => {
    const h = harness();
    const s = createDeviceProfileService(h.deps);
    await settle(s.onDeviceRegistered(USER, DEVICE, "restore", ROW));
    await settle(s.onDeviceRegistered(USER, DEVICE, "login", ROW));
    expect(h.collects).toBe(2);
  });
});

describe("write path", () => {
  it("writes the row profile for (userId, deviceId) and the state file stores only sha256 + row id", async () => {
    const h = harness();
    const s = createDeviceProfileService(h.deps);
    await settle(s.onDeviceRegistered(USER, DEVICE, "login", ROW));
    expect(h.updates).toHaveLength(1);
    const { userId, deviceId, profile } = h.updates[0];
    expect([userId, deviceId]).toEqual([USER, DEVICE]);
    expect(profile).toMatchObject({ contacts: 2000, addressBook: 510, dbMB: 1500, mailAccounts: 2, countsState: "ok", poolReady: true });
    const raw = JSON.stringify(h.state.file);
    expect(raw).not.toContain(DEVICE);
    expect(h.state.file?.entries).toHaveLength(1);
    expect(h.state.file?.entries[0].deviceKey).toBe(deviceKeyOf(USER, DEVICE));
    expect(h.state.file?.entries[0].rowId).toBe(ROW);
    expect(getDeviceRowId()).toBe(ROW);
  });
  it("a failed UPDATE keeps only the pending-clear entry (empty fingerprint), so the next launch retries", async () => {
    const h = harness();
    h.updateOk.value = false;
    await settle(createDeviceProfileService(h.deps).onDeviceRegistered(USER, DEVICE, "login", ROW));
    expect(h.updates).toHaveLength(1);
    expect(h.state.file?.entries).toEqual([expect.objectContaining({ deviceKey: deviceKeyOf(USER, DEVICE), fp: {} })]);
    h.updateOk.value = true;
    await settle(createDeviceProfileService(h.deps).onDeviceRegistered(USER, DEVICE, "restore", ROW));
    expect(h.updates).toHaveLength(2);
    expect(h.state.file?.entries[0].fp).toMatchObject({ osBuild: "24G419", ramGB: 32 });
  });
  it("the pending-clear entry is written BEFORE the profile UPDATE", async () => {
    const h = harness();
    let fileAtUpdate: unknown = "unset";
    const base = h.deps.updateRow;
    h.deps.updateRow = async (u, d, p) => {
      fileAtUpdate = JSON.parse(JSON.stringify(h.state.file));
      return base(u, d, p);
    };
    await settle(createDeviceProfileService(h.deps).onDeviceRegistered(USER, DEVICE, "login", ROW));
    expect(fileAtUpdate).toEqual({ v: 2, entries: [expect.objectContaining({ deviceKey: deviceKeyOf(USER, DEVICE) })] });
  });
  it("an unchanged restore in a NEW process does not write", async () => {
    const h = harness();
    await settle(createDeviceProfileService(h.deps).onDeviceRegistered(USER, DEVICE, "login", ROW));
    await settle(createDeviceProfileService(h.deps).onDeviceRegistered(USER, DEVICE, "restore", ROW));
    expect(h.updates).toHaveLength(1);
  });
});

describe("P13 bounded counts scheduler (C2)", () => {
  it("pool busy on every check: exactly 10 checks, no query, counts absent, marker skippedBusy, no timer left", async () => {
    const h = harness();
    h.pool.inflight = 1;
    const s = createDeviceProfileService(h.deps);
    await settle(s.onDeviceRegistered(USER, DEVICE, "login", ROW));
    expect(h.checks).toBe(COUNTS_MAX_CHECKS);
    expect(h.countsCalls).toBe(0);
    expect(h.updates[0].profile).not.toHaveProperty("contacts");
    expect(h.updates[0].profile).toMatchObject({ countsState: "skippedBusy" });
    expect(s.getCountsState()).toBe("skippedBusy");
    expect(jest.getTimerCount()).toBe(0);
  });
  it("pool goes down after ready: marker poolDown, no query", async () => {
    const h = harness();
    const s = createDeviceProfileService({
      ...h.deps,
      collectHardware: async () => {
        h.pool.ready = false; // dies after the wait
        return { ...HW };
      },
    });
    await settle(s.onDeviceRegistered(USER, DEVICE, "login", ROW));
    expect(h.countsCalls).toBe(0);
    expect(h.updates[0].profile).toMatchObject({ countsState: "poolDown", poolReady: true });
  });
  it("pool never ready within the wait: hardware written, counts absent, poolDown", async () => {
    const h = harness();
    h.pool.ready = false;
    const s = createDeviceProfileService(h.deps);
    await settle(s.onDeviceRegistered(USER, DEVICE, "login", ROW));
    expect(h.countsCalls).toBe(0);
    expect(h.updates[0].profile).toMatchObject({ countsState: "poolDown", poolReady: false, cpuCores: 10 });
  });
  it("the query is issued only once quiet has elapsed (not at pool ready)", async () => {
    const h = harness();
    const s = createDeviceProfileService(h.deps);
    const p = s.onDeviceRegistered(USER, DEVICE, "login", ROW);
    await jest.advanceTimersByTimeAsync(QUIET_MS - 1);
    expect(h.countsCalls).toBe(0);
    await jest.advanceTimersByTimeAsync(1);
    expect(h.countsCalls).toBe(1);
    await settle(p);
  });
  it("constants are the plan's", () => {
    expect([QUIET_MS, COUNTS_CHECK_MS, COUNTS_MAX_CHECKS, POOL_WAIT_MS]).toEqual([120_000, 10_000, 10, 60_000]);
  });
});

describe("P9 / B3 gate OFF and the pending clear", () => {
  const prior: StateFile = { v: 2, entries: [{ deviceKey: deviceKeyOf(USER, DEVICE), rowId: ROW, fp: {}, writtenAt: "x" }] };

  it("OFF: no collection, one null UPDATE, file deleted after success", async () => {
    const h = harness();
    h.gate.on = false;
    h.state.file = JSON.parse(JSON.stringify(prior));
    const s = createDeviceProfileService(h.deps);
    await settle(s.onDeviceRegistered(USER, DEVICE, "restore", ROW));
    expect(h.collects).toBe(0);
    expect(h.updates).toEqual([{ userId: USER, deviceId: DEVICE, profile: null }]);
    expect(h.state.file).toBeNull();
  });
  it("OFF while offline: file kept; next launch clears exactly once; then no further calls", async () => {
    const h = harness();
    h.gate.on = false;
    h.state.file = JSON.parse(JSON.stringify(prior));
    h.updateOk.value = false;
    await settle(createDeviceProfileService(h.deps).onDeviceRegistered(USER, DEVICE, "restore", ROW));
    expect(h.state.file).not.toBeNull();
    h.updateOk.value = true;
    await settle(createDeviceProfileService(h.deps).onDeviceRegistered(USER, DEVICE, "restore", ROW));
    expect(h.state.file).toBeNull();
    expect(h.updates).toHaveLength(2);
    await settle(createDeviceProfileService(h.deps).onDeviceRegistered(USER, DEVICE, "restore", ROW));
    expect(h.updates).toHaveLength(2);
  });
  it("crash reporting OFF alone (diagnostics ON) also clears: the gate is both switches", async () => {
    const h = harness();
    const switches = { diag: true, crash: false };
    h.state.file = JSON.parse(JSON.stringify(prior));
    const s = createDeviceProfileService({ ...h.deps, isGateOn: () => switches.diag && switches.crash });
    await settle(s.onDeviceRegistered(USER, DEVICE, "restore", ROW));
    expect(h.collects).toBe(0);
    expect(h.updates).toEqual([{ userId: USER, deviceId: DEVICE, profile: null }]);
  });
  it("OFF with no prior profile: nothing is sent", async () => {
    const h = harness();
    h.gate.on = false;
    await settle(createDeviceProfileService(h.deps).onDeviceRegistered(USER, DEVICE, "restore", ROW));
    expect(h.updates).toHaveLength(0);
  });
  it("turned OFF while the run waited: no profile UPDATE", async () => {
    const h = harness();
    const s = createDeviceProfileService(h.deps);
    const p = s.onDeviceRegistered(USER, DEVICE, "login", ROW);
    await jest.advanceTimersByTimeAsync(1_000);
    h.gate.on = false;
    await settle(p);
    expect(h.updates.filter((u) => u.profile !== null)).toHaveLength(0);
  });
});

describe("C5 OFF clears immediately", () => {
  it("toggle OFF after a write: null UPDATE now, using this process's registration", async () => {
    const h = harness();
    const s = createDeviceProfileService(h.deps);
    await settle(s.onDeviceRegistered(USER, DEVICE, "login", ROW));
    expect(h.state.file).not.toBeNull();
    h.gate.on = false;
    await s.onPrivacyGateChanged();
    expect(h.updates.at(-1)).toEqual({ userId: USER, deviceId: DEVICE, profile: null });
    expect(h.state.file).toBeNull();
  });
  it("toggle OFF then ON: the next registration writes once", async () => {
    const h = harness();
    const s = createDeviceProfileService(h.deps);
    await settle(s.onDeviceRegistered(USER, DEVICE, "login", ROW));
    h.gate.on = false;
    await s.onPrivacyGateChanged();
    h.gate.on = true;
    await s.onPrivacyGateChanged();
    await settle(s.onDeviceRegistered(USER, DEVICE, "restore", ROW));
    expect(h.updates.filter((u) => u.profile !== null)).toHaveLength(2);
  });
  it("toggle OFF with no registration yet: nothing is sent", async () => {
    const h = harness();
    h.gate.on = false;
    await createDeviceProfileService(h.deps).onPrivacyGateChanged();
    expect(h.updates).toHaveLength(0);
  });
});

describe("P8 no sync child process anywhere on the service path", () => {
  it("execSync / execFileSync / spawnSync are never called", async () => {
    // Spy on the CJS module object (an ES namespace import cannot be redefined).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cp = require("child_process") as typeof import("child_process");
    const spies = [jest.spyOn(cp, "execSync"), jest.spyOn(cp, "execFileSync"), jest.spyOn(cp, "spawnSync")];
    try {
      const h = harness();
      const s = createDeviceProfileService(h.deps);
      await settle(s.onDeviceRegistered(USER, DEVICE, "login", ROW));
      h.gate.on = false;
      await s.onPrivacyGateChanged();
      expect(h.updates.length).toBeGreaterThan(0); // positive control: the path ran
      expect(spies.map((sp) => sp.mock.calls.length)).toEqual([0, 0, 0]);
    } finally {
      spies.forEach((sp) => sp.mockRestore());
    }
  });
});

describe("B1 counts only through the worker query", () => {
  it("counts come from deps.queryCounts (the pool), never from a main-thread db", async () => {
    const h = harness();
    const s = createDeviceProfileService(h.deps);
    await settle(s.onDeviceRegistered(USER, DEVICE, "login", ROW));
    expect(h.countsCalls).toBe(1);
  });
});

describe("wiring (source checks)", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("fs") as typeof import("fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("path") as typeof import("path");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("B1: the service never opens the database on main (no databaseService / sqlite import)", () => {
    const src = strip(fs.readFileSync(path.join(__dirname, "..", "deviceProfileService.ts"), "utf8"));
    expect(src).toContain('queryContacts("deviceDataSize"'); // positive control: counts go to the worker
    expect(src).not.toMatch(/databaseService|getRawDatabase|better-sqlite3|\.prepare\(/);
  });

  it("C5: both privacy switches call onPrivacyGateChanged after saving", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../../handlers/ccpaHandlers.ts"), "utf8");
    for (const [channel, setter] of [
      ["privacy:set-crash-reporting", "setCrashReportingEnabled(enabled)"],
      ["privacy:set-diagnostics-sharing", "setDiagnosticsSharingEnabled(enabled)"],
    ]) {
      const block = src.slice(src.indexOf(`"${channel}"`), src.indexOf("}, { module", src.indexOf(`"${channel}"`)));
      expect(block.indexOf(setter)).toBeGreaterThan(0);
      expect(block.indexOf("onPrivacyGateChanged()")).toBeGreaterThan(block.indexOf(setter));
    }
  });
});

describe("S1 one machine, two users: each user's pending clear is kept separately", () => {
  const OTHER = "user-b";
  it("B signs in after A; OFF clears B now, and A's row is cleared when A next registers", async () => {
    const h = harness();
    await settle(createDeviceProfileService(h.deps).onDeviceRegistered(USER, DEVICE, "login", ROW));
    await settle(createDeviceProfileService(h.deps).onDeviceRegistered(OTHER, DEVICE, "login", ROW));
    expect(h.state.file?.entries.map((e) => e.deviceKey).sort()).toEqual([deviceKeyOf(USER, DEVICE), deviceKeyOf(OTHER, DEVICE)].sort());
    const s = createDeviceProfileService(h.deps);
    await settle(s.onDeviceRegistered(OTHER, DEVICE, "restore", ROW)); // unchanged: no write
    h.gate.on = false;
    await s.onPrivacyGateChanged();
    expect(h.updates.at(-1)).toEqual({ userId: OTHER, deviceId: DEVICE, profile: null });
    expect(h.state.file?.entries.map((e) => e.deviceKey)).toEqual([deviceKeyOf(USER, DEVICE)]); // A still pending
    await settle(createDeviceProfileService(h.deps).onDeviceRegistered(USER, DEVICE, "restore", ROW));
    expect(h.updates.at(-1)).toEqual({ userId: USER, deviceId: DEVICE, profile: null });
    expect(h.state.file).toBeNull();
  });
  it("A and B registering at the same moment in one process both keep their entry (state writes are serialized)", async () => {
    const h = harness();
    // A slow disk read, so the two read-modify-writes would interleave if unserialized.
    const read = h.deps.readState;
    h.deps.readState = async () => {
      await new Promise((r) => setTimeout(r, 5));
      return read();
    };
    const s = createDeviceProfileService(h.deps);
    await settle(Promise.all([s.onDeviceRegistered(USER, DEVICE, "login", ROW), s.onDeviceRegistered(OTHER, DEVICE, "login", ROW)]));
    expect(h.updates.filter((u) => u.profile !== null)).toHaveLength(2); // positive control: both wrote
    expect(h.state.file?.entries.map((e) => e.deviceKey).sort()).toEqual([deviceKeyOf(USER, DEVICE), deviceKeyOf(OTHER, DEVICE)].sort());
  });
  it("B's later write does not erase A's entry", async () => {
    const h = harness();
    await settle(createDeviceProfileService(h.deps).onDeviceRegistered(USER, DEVICE, "login", ROW));
    await settle(createDeviceProfileService(h.deps).onDeviceRegistered(OTHER, DEVICE, "login", ROW));
    expect(h.state.file?.entries).toHaveLength(2);
  });
});
