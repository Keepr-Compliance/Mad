/**
 * @jest-environment node
 */
/**
 * BACKLOG-4185: the PRODUCTION wiring of the device-profile service — the gate
 * is both switches, the UPDATE targets this user's row for this machine id,
 * the state file lands in userData, and OFF (either switch) clears it.
 * Mutations: gate = diagnostics only; .eq filter dropped; counts read on main.
 * settle() waits for the service's own runs (__whenIdleForTests), not a fixed
 * real-time sleep: a slow state-file write once let the OFF case overlap the
 * ON run's bookkeeping (Windows CI).
 */
import { randomUUID } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-4185-wiring-"));
jest.mock("electron", () => ({ app: { getPath: () => userData } }));

const switches = { diag: true, crash: true };
jest.mock("../../diagnosticsSharingPreference", () => ({ isDiagnosticsSharingEnabled: () => switches.diag }));
jest.mock("../../crashReportingPreference", () => ({ isCrashReportingEnabled: () => switches.crash }));
jest.mock("../../logService", () => ({ __esModule: true, default: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() } }));

const mockQueryContacts = jest.fn(async () => [{ contacts: 2, addressBook: 3, mailAccounts: 1 }]);
jest.mock("../../../workers/contactWorkerPool", () => ({
  isPoolReady: () => true,
  getPoolQueryCount: () => 0,
  queryContacts: (...a: unknown[]) => (mockQueryContacts as unknown as (...x: unknown[]) => unknown)(...a),
}));
jest.mock("../../diagnostics/deviceProfileCollector", () => ({
  defaultCollectorDeps: () => ({}),
  collectHardwareProfile: async () => ({ platform: "darwin", cpuCores: 8, ramBytes: 16 * 1024 ** 3, osBuild: "24G419", osVersion: "15.7.3" }),
}));

interface Call {
  update: unknown;
  eqs: Array<[string, unknown]>;
}
const calls: Call[] = [];
jest.mock("../../supabaseService", () => ({
  __esModule: true,
  default: {
    getClient: () => ({
      from: (table: string) => {
        if (table !== "devices") throw new Error(`unexpected table ${table}`);
        const call: Call = { update: undefined, eqs: [] };
        const q = {
          update: (v: unknown) => ((call.update = v), q),
          eq: (k: string, v: unknown) => (call.eqs.push([k, v]), q),
          select: async () => {
            calls.push(call);
            return { data: [{ id: "row" }], error: null };
          },
        };
        return q;
      },
    }),
  },
}));

import * as svc from "../deviceProfileService";

const ROW = randomUUID();
const stateFile = path.join(userData, "device-profile-state.json");

// Captured before any fake timers are installed.
const realSetTimeout = global.setTimeout;
const realRename = fs.promises.rename.bind(fs.promises);

async function advance(): Promise<void> {
  // The collection's waits (quiet period, count checks) are fake timers.
  for (let i = 0; i < 40; i++) await jest.advanceTimersByTimeAsync(10_000);
}

async function settle(): Promise<void> {
  await advance();
  // fs.promises work runs on the real thread pool: wait for the runs themselves.
  await svc.__whenIdleForTests();
}

beforeEach(() => {
  jest.useFakeTimers();
  calls.length = 0;
  switches.diag = true;
  switches.crash = true;
  fs.rmSync(stateFile, { force: true });
  svc.__resetDeviceProfileServiceForTests();
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});
afterAll(() => fs.rmSync(userData, { recursive: true, force: true }));

it("ON: one UPDATE of devices for (user_id, device_id); counts from the worker; state file written", async () => {
  svc.onDeviceRegistered("u1", "machine-a", "login", ROW);
  await settle();
  expect(calls).toHaveLength(1);
  expect(calls[0].eqs).toEqual([["user_id", "u1"], ["device_id", "machine-a"]]);
  expect(calls[0].update).toMatchObject({ hardware_profile: expect.objectContaining({ cpuCores: 8, contacts: 2 }) });
  expect(mockQueryContacts).toHaveBeenCalledWith("deviceDataSize", "u1", 30_000);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  expect(state.entries[0].rowId).toBe(ROW);
  expect(fs.readFileSync(stateFile, "utf8")).not.toContain("machine-a");
});

const OFF_CASES: Array<[string, Partial<typeof switches>]> = [
  ["diagnostics OFF", { diag: false, crash: true }],
  ["crash reports OFF (diagnostics ON)", { diag: true, crash: false }],
];

async function offClearsTheProfile(sw: Partial<typeof switches>): Promise<void> {
  svc.onDeviceRegistered("u1", "machine-a", "login", ROW);
  await settle();
  expect(fs.existsSync(stateFile)).toBe(true);
  Object.assign(switches, sw);
  svc.onPrivacyGateChanged();
  await settle();
  expect(calls).toHaveLength(2);
  expect(calls[1].update).toMatchObject({ hardware_profile: null });
  expect(fs.existsSync(stateFile)).toBe(false);
}

it.each(OFF_CASES)("%s: no collection; the earlier profile is cleared and the file removed", async (_n, sw) => {
  await offClearsTheProfile(sw);
});

/**
 * Holds the next fs.promises[method] call until release(). Later calls pass
 * straight through.
 */
function holdNext(method: "rename" | "rm"): { reached: Promise<void>; release: () => void } {
  let entered!: () => void;
  const reached = new Promise<void>((r) => (entered = r));
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let held = false;
  const real = (fs.promises[method] as (...a: unknown[]) => Promise<void>).bind(fs.promises);
  jest.spyOn(fs.promises, method).mockImplementation((async (...a: unknown[]) => {
    if (!held) {
      held = true;
      entered();
      await released;
    }
    return real(...a);
  }) as never);
  return { reached, release };
}

/**
 * settle() must still be waiting while the held write is out, longer than any
 * plausible fixed sleep, and must finish once it is released.
 */
async function settleAcross(hold: { reached: Promise<void>; release: () => void }): Promise<void> {
  let resolved = false;
  const settled = settle().then(() => {
    resolved = true;
  });
  await hold.reached;
  await new Promise((r) => realSetTimeout(r, 300));
  expect(resolved).toBe(false);
  hold.release();
  await settled;
}

describe("state-file write held until released (slow disk)", () => {
  it.each(OFF_CASES)("%s: no collection; the earlier profile is cleared and the file removed", async (_n, sw) => {
    const onWrite = holdNext("rename");
    svc.onDeviceRegistered("u1", "machine-a", "login", ROW);
    await settleAcross(onWrite);
    expect(fs.existsSync(stateFile)).toBe(true);
    Object.assign(switches, sw);
    const offRemove = holdNext("rm");
    svc.onPrivacyGateChanged();
    await settleAcross(offRemove);
    expect(calls).toHaveLength(2);
    expect(calls[1].update).toMatchObject({ hardware_profile: null });
    expect(fs.existsSync(stateFile)).toBe(false);
  });
});

it("OFF while the ON run's post-UPDATE bookkeeping is in flight: its own null lands after the toggle's", async () => {
  // Hold the SECOND state-file write: the first is the pending-clear flag
  // written before the UPDATE, the second the bookkeeping after it.
  let renames = 0;
  let entered!: () => void;
  const reached = new Promise<void>((r) => (entered = r));
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  jest.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
    if (++renames === 2) {
      entered();
      await released;
    }
    return realRename(from, to);
  });

  svc.onDeviceRegistered("u1", "machine-a", "login", ROW);
  await advance();
  await reached;
  expect(calls).toHaveLength(1); // the profile UPDATE has returned

  switches.diag = false;
  svc.onPrivacyGateChanged();
  release();
  await settle();

  // Intended (deviceProfileService finally block): the toggle's null AND a
  // fresh null from the run itself, so a null is the last write the row sees.
  expect(calls).toHaveLength(3);
  expect(calls[0].update).toMatchObject({ hardware_profile: expect.objectContaining({ cpuCores: 8 }) });
  expect(calls[1].update).toMatchObject({ hardware_profile: null });
  expect(calls[2].update).toMatchObject({ hardware_profile: null });
  expect(fs.existsSync(stateFile)).toBe(false);
});
