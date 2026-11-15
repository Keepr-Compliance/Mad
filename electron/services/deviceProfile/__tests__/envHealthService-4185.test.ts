/** @jest-environment node */
/**
 * BACKLOG-4181 PR 3: env.health from the device-profile service.
 *
 * What these tests do NOT prove: that the once-flag is set synchronously. A
 * flag set one microtask later still passes every test here, because
 * advanceTimersByTimeAsync flushes microtasks between timers. The synchronous
 * set (`healthSent = true` before the build and before any await) is checked
 * by code review, not by a test.
 */
import { createDeviceProfileService, POOL_HEALTH_CHECK_MS, type ServiceDeps } from "../deviceProfileService";
import type { CollectedProfile } from "../buildDeviceProfile";
import { __resetDeviceRowIdForTests } from "../deviceRowId";

const HW: CollectedProfile = {
  platform: "darwin",
  cpuModel: "Apple M1 Max",
  cpuCores: 10,
  ramBytes: 32 * 1024 ** 3,
  diskType: "ssd",
  diskBus: "nvme",
  osVersion: "15.7.3",
  osBuild: "24G419",
  av: ["defender"],
  avEnabled: true,
};

interface Harness {
  gate: { on: boolean };
  pool: { ready: boolean };
  health: Array<Record<string, unknown>>;
  writes: { n: number };
  timers: Array<{ ms: number; unref: jest.Mock }>;
  deps: ServiceDeps;
}

function harness(store: { state: unknown } = { state: null }, writes = { n: 0 }): Harness {
  const h = { gate: { on: true }, pool: { ready: true }, health: [], writes, timers: [] } as unknown as Harness;
  h.deps = {
    isGateOn: () => h.gate.on,
    isPoolReady: () => h.pool.ready,
    getPoolQueryCount: () => 0,
    queryCounts: async () => ({ contacts: 184_231, addressBook: 999, mailAccounts: 2 }),
    dbBytes: async () => 1_534 * 1024 ** 2 + 12_345,
    collectHardware: async () => ({ ...HW }),
    updateRow: async () => {
      h.writes.n += 1;
      return { ok: true, rows: 1 };
    },
    readState: async () => (store.state ? JSON.parse(JSON.stringify(store.state)) : null),
    writeState: async (s) => {
      store.state = JSON.parse(JSON.stringify(s));
    },
    removeState: async () => {
      store.state = null;
    },
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
      const real = setTimeout(fn, ms);
      const unref = jest.fn(() => real.unref());
      h.timers.push({ ms, unref });
      return { unref };
    },
    warn: () => undefined,
    emitHealth: (f) => void h.health.push({ ...f }),
  };
  return h;
}

/** Runs registrations to completion under fake timers (pool ready -> quiet -> counts). */
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

describe("once per process", () => {
  it("3 concurrent restores, then a login -> exactly 1 env.health", async () => {
    const h = harness();
    const svc = createDeviceProfileService(h.deps);
    await settle(
      Promise.all([
        svc.onDeviceRegistered("u", "d", "restore", "r"),
        svc.onDeviceRegistered("u", "d", "restore", "r"),
        svc.onDeviceRegistered("u", "d", "restore", "r"),
      ]),
    );
    await settle(svc.onDeviceRegistered("u", "d", "login", "r"));
    expect(h.health).toHaveLength(1);
  });

  it("SRX2 concurrent restore + login + a second user -> exactly 1 env.health", async () => {
    const h = harness();
    const svc = createDeviceProfileService(h.deps);
    await settle(
      Promise.all([
        svc.onDeviceRegistered("u", "d", "restore", "r"),
        svc.onDeviceRegistered("u", "d", "login", "r"),
        svc.onDeviceRegistered("v", "d", "login", "r2"),
      ]),
    );
    expect(h.health).toHaveLength(1);
  });

  it("SRX1 next launch, row unchanged (write skipped) -> env.health still emitted", async () => {
    const store = { state: null as unknown };
    const writes = { n: 0 };
    const first = harness(store, writes);
    await settle(createDeviceProfileService(first.deps).onDeviceRegistered("u", "d", "restore", "r"));
    expect(writes.n).toBe(1);
    expect(first.health).toHaveLength(1);
    const second = harness(store, writes); // a new process, same state file
    await settle(createDeviceProfileService(second.deps).onDeviceRegistered("u", "d", "restore", "r"));
    expect(writes.n).toBe(1); // positive control: the row write WAS skipped
    expect(second.health).toHaveLength(1);
  });
});

describe("fields", () => {
  it("buckets only, exact values; no raw AV, model, build or exact size", async () => {
    const h = harness();
    await settle(createDeviceProfileService(h.deps).onDeviceRegistered("u", "d", "restore", "r"));
    expect(h.health).toEqual([{ poolState: "ready", countsState: "ok", contactsBucket: 100_000, addressBookBucket: 1, dbSizeBucketMB: 1_000, mailAccounts: 2 }]);
    const s = JSON.stringify(h.health);
    for (const bad of ["defender", "M1", "24G419", "nvme", "184231", "180000", "999", "1534", "1500"]) {
      expect({ bad, hit: s.includes(bad) }).toEqual({ bad, hit: false });
    }
  });
});

describe("gate", () => {
  it("OFF at registration: nothing", async () => {
    const h = harness();
    h.gate.on = false;
    await settle(createDeviceProfileService(h.deps).onDeviceRegistered("u", "d", "restore", "r"));
    expect(h.health).toHaveLength(0);
  });

  it("OFF while the counts phase waited: nothing", async () => {
    const h = harness();
    const p = createDeviceProfileService(h.deps).onDeviceRegistered("u", "d", "restore", "r");
    await jest.advanceTimersByTimeAsync(60_000);
    h.gate.on = false;
    await settle(p);
    expect(h.health).toHaveLength(0);
  });
});

describe("pool up/down re-send", () => {
  it("poolState only, once per change, nothing while unchanged", async () => {
    const h = harness();
    await settle(createDeviceProfileService(h.deps).onDeviceRegistered("u", "d", "restore", "r"));
    expect(h.health).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(POOL_HEALTH_CHECK_MS);
    expect(h.health).toHaveLength(1);
    h.pool.ready = false;
    await jest.advanceTimersByTimeAsync(POOL_HEALTH_CHECK_MS);
    await jest.advanceTimersByTimeAsync(POOL_HEALTH_CHECK_MS);
    expect(h.health).toHaveLength(2);
    expect(h.health[1]).toEqual({ poolState: "down" });
    h.pool.ready = true;
    await jest.advanceTimersByTimeAsync(POOL_HEALTH_CHECK_MS);
    expect(h.health[2]).toEqual({ poolState: "ready" });
  });

  it("a change while the gate is OFF sends nothing", async () => {
    const h = harness();
    await settle(createDeviceProfileService(h.deps).onDeviceRegistered("u", "d", "restore", "r"));
    h.gate.on = false;
    h.pool.ready = false;
    await jest.advanceTimersByTimeAsync(POOL_HEALTH_CHECK_MS * 2);
    expect(h.health).toHaveLength(1);
  });

  it("C2 the pool-check timer is unref'd (never keeps the process alive)", async () => {
    const h = harness();
    await settle(createDeviceProfileService(h.deps).onDeviceRegistered("u", "d", "restore", "r"));
    const poolTimers = h.timers.filter((t) => t.ms === POOL_HEALTH_CHECK_MS);
    expect(poolTimers.length).toBeGreaterThan(0);
    for (const t of poolTimers) expect(t.unref).toHaveBeenCalledTimes(1);
  });
});
