/**
 * @jest-environment node
 */
/**
 * BACKLOG-4185 PR B, SR review B1: "Share diagnostics" or "Send crash reports"
 * turned OFF while the profile UPDATE is in flight. The row on the server
 * holds whatever UPDATE was applied last, so a null must land last, and no
 * pending-clear entry may be left behind once it has.
 * Adapted from the SR probe (scratchpad srProbe-4185); the harness keeps the
 * state file opaque so the test does not depend on its shape.
 */
import { randomUUID } from "crypto";
import { createDeviceProfileService, type ServiceDeps } from "../deviceProfileService";
import { __resetDeviceRowIdForTests } from "../deviceRowId";
import type { CollectedProfile, DeviceProfileRow } from "../buildDeviceProfile";

const USER = "user-a";
const DEVICE = "machine-id-a";
const ROW = randomUUID();
const HW: CollectedProfile = { platform: "darwin", cpuCores: 10, ramBytes: 32 * 1024 ** 3, osVersion: "15.7.3", osBuild: "24G419" };

function harness() {
  const h = {
    updates: [] as Array<DeviceProfileRow | null>,
    file: null as unknown,
    gate: { on: true },
    hw: { ...HW },
    hold: false,
    release: null as null | (() => void),
  };
  const deps: ServiceDeps = {
    isGateOn: () => h.gate.on,
    isPoolReady: () => true,
    getPoolQueryCount: () => 0,
    queryCounts: async () => ({ contacts: 1, addressBook: 1, mailAccounts: 1 }),
    dbBytes: async () => 1024 ** 2,
    collectHardware: async () => ({ ...h.hw }),
    updateRow: async (_u, _d, profile) => {
      if (profile !== null && h.hold) await new Promise<void>((r) => (h.release = r));
      h.updates.push(profile);
      return { ok: true, rows: 1 };
    },
    readState: async () => (h.file === null ? null : JSON.parse(JSON.stringify(h.file))),
    writeState: async (s) => {
      h.file = JSON.parse(JSON.stringify(s));
    },
    removeState: async () => {
      h.file = null;
    },
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    warn: () => undefined,
  };
  return { h, deps };
}

async function settle(p: Promise<unknown>): Promise<void> {
  for (let i = 0; i < 40; i++) await jest.advanceTimersByTimeAsync(10_000);
  await p;
}

async function untilInFlight(h: { release: null | (() => void) }): Promise<void> {
  for (let i = 0; i < 40 && !h.release; i++) await jest.advanceTimersByTimeAsync(10_000);
  expect(typeof h.release).toBe("function"); // the profile UPDATE is in flight
}

const seq = (u: Array<DeviceProfileRow | null>) => u.map((p) => (p === null ? "null" : "profile"));

beforeEach(() => {
  jest.useFakeTimers({ now: 1_700_000_000_000 });
  __resetDeviceRowIdForTests();
});
afterEach(() => jest.useRealTimers());

describe("SR B1: OFF while the profile UPDATE is in flight", () => {
  it("SR D1: OFF then ON while in flight, then OFF later: the row ends cleared", async () => {
    const { h, deps } = harness();
    h.hold = true;
    const svc = createDeviceProfileService(deps);
    const run = svc.onDeviceRegistered(USER, DEVICE, "login", ROW);
    await untilInFlight(h);
    h.gate.on = false;
    await svc.onPrivacyGateChanged();
    h.gate.on = true;
    await svc.onPrivacyGateChanged();
    h.release?.();
    await settle(run);
    h.gate.on = false;
    await svc.onPrivacyGateChanged();
    await jest.advanceTimersByTimeAsync(1000);
    expect({ seq: seq(h.updates), file: h.file !== null }).toEqual({ seq: expect.arrayContaining(["profile"]), file: false });
    expect(seq(h.updates).at(-1)).toBe("null");
  });

  it("D1 variant: the upload reports failure after a clear removed the flag; the flag comes back, a later OFF clears", async () => {
    const { h, deps } = harness();
    h.hold = true;
    const base = deps.updateRow;
    let failProfile = true;
    deps.updateRow = async (u, d, p) => {
      const r = await base(u, d, p);
      return p !== null && failProfile ? { ok: false, rows: 0 } : r; // applied, but reported as failed
    };
    const svc = createDeviceProfileService(deps);
    const run = svc.onDeviceRegistered(USER, DEVICE, "login", ROW);
    await untilInFlight(h);
    h.gate.on = false;
    await svc.onPrivacyGateChanged();
    h.gate.on = true;
    await svc.onPrivacyGateChanged();
    h.release?.();
    await settle(run);
    failProfile = false;
    expect(h.file).not.toBeNull();
    h.gate.on = false;
    await svc.onPrivacyGateChanged();
    expect(seq(h.updates).at(-1)).toBe("null");
    expect(h.file).toBeNull();
  });

  it("first-ever write: a null lands last and nothing is left pending", async () => {
    const { h, deps } = harness();
    h.hold = true;
    const svc = createDeviceProfileService(deps);
    const run = svc.onDeviceRegistered(USER, DEVICE, "login", ROW);
    await untilInFlight(h);
    h.gate.on = false;
    await svc.onPrivacyGateChanged();
    h.release?.();
    await settle(run);
    expect(seq(h.updates).at(-1)).toBe("null");
    expect(h.updates.filter((p) => p !== null)).toHaveLength(1);
    expect(h.file).toBeNull();
  });

  it("a profile already on the row (state file exists): the null still lands last", async () => {
    const { h, deps } = harness();
    await settle(createDeviceProfileService(deps).onDeviceRegistered(USER, DEVICE, "login", ROW));
    expect(h.file).not.toBeNull(); // positive control: a pending-clear flag exists
    h.hw.osBuild = "24G500"; // a change, so the next process writes again
    h.hold = true;
    const svc = createDeviceProfileService(deps);
    const run = svc.onDeviceRegistered(USER, DEVICE, "restore", ROW);
    await untilInFlight(h);
    h.gate.on = false;
    await svc.onPrivacyGateChanged();
    h.release?.();
    await settle(run);
    expect(seq(h.updates)).toEqual(expect.arrayContaining(["profile", "profile", "null"]));
    expect(seq(h.updates).at(-1)).toBe("null");
    expect(h.file).toBeNull();
  });

  it("the in-flight write's own null fails: the flag is kept for the next registration, which clears", async () => {
    const { h, deps } = harness();
    h.hold = true;
    let failNulls = true;
    const base = deps.updateRow;
    deps.updateRow = async (u, d, p) => (p === null && failNulls ? (h.updates.push(p), { ok: false, rows: 0 }) : base(u, d, p));
    const svc = createDeviceProfileService(deps);
    const run = svc.onDeviceRegistered(USER, DEVICE, "login", ROW);
    await untilInFlight(h);
    h.gate.on = false;
    await svc.onPrivacyGateChanged();
    h.release?.();
    await settle(run);
    expect(h.file).not.toBeNull();
    failNulls = false;
    await settle(createDeviceProfileService(deps).onDeviceRegistered(USER, DEVICE, "restore", ROW));
    expect(seq(h.updates).at(-1)).toBe("null");
    expect(h.file).toBeNull();
  });
});
