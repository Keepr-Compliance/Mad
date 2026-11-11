/**
 * @jest-environment node
 */
/**
 * BACKLOG-4185: the PRODUCTION wiring of the device-profile service — the gate
 * is both switches, the UPDATE targets this user's row for this machine id,
 * the state file lands in userData, and OFF (either switch) clears it.
 * Mutations: gate = diagnostics only; .eq filter dropped; counts read on main.
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

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await jest.advanceTimersByTimeAsync(10_000);
  // fs.promises work runs on the real thread pool: let it finish.
  jest.useRealTimers();
  await new Promise((r) => setTimeout(r, 50));
  jest.useFakeTimers();
}

beforeEach(() => {
  jest.useFakeTimers();
  calls.length = 0;
  switches.diag = true;
  switches.crash = true;
  fs.rmSync(stateFile, { force: true });
  svc.__resetDeviceProfileServiceForTests();
});
afterEach(() => jest.useRealTimers());
afterAll(() => fs.rmSync(userData, { recursive: true, force: true }));

it("ON: one UPDATE of devices for (user_id, device_id); counts from the worker; state file written", async () => {
  svc.onDeviceRegistered("u1", "machine-a", "login", ROW);
  await settle();
  expect(calls).toHaveLength(1);
  expect(calls[0].eqs).toEqual([["user_id", "u1"], ["device_id", "machine-a"]]);
  expect(calls[0].update).toMatchObject({ hardware_profile: expect.objectContaining({ cpuCores: 8, contacts: 2 }) });
  expect(mockQueryContacts).toHaveBeenCalledWith("deviceDataSize", "u1", 30_000);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  expect(state.rowId).toBe(ROW);
  expect(fs.readFileSync(stateFile, "utf8")).not.toContain("machine-a");
});

it.each([
  ["diagnostics OFF", { diag: false, crash: true }],
  ["crash reports OFF (diagnostics ON)", { diag: true, crash: false }],
])("%s: no collection; the earlier profile is cleared and the file removed", async (_n, sw) => {
  svc.onDeviceRegistered("u1", "machine-a", "login", ROW);
  await settle();
  expect(fs.existsSync(stateFile)).toBe(true);
  Object.assign(switches, sw);
  svc.onPrivacyGateChanged();
  await settle();
  expect(calls).toHaveLength(2);
  expect(calls[1].update).toMatchObject({ hardware_profile: null });
  expect(fs.existsSync(stateFile)).toBe(false);
});
