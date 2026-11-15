/** @jest-environment node */
/**
 * BACKLOG-4181 PR 3 / BACKLOG-4185: env.health fields and the machine-class
 * keys, at each layer on its own (capture in perf.ts, send in the transport
 * filter), plus the single-declaration pins for the shared value tables.
 *
 * Attribute keys contain dots ("keepr.ramGB"), so absence is asserted with
 * `Object.keys(x).not.toContain(key)`. `not.toHaveProperty("keepr.ramGB")`
 * would read the dot as a path and pass on any flat map.
 */
import fs from "fs";
import os from "os";
import path from "path";
import {
  getDiagnosticsDeviceId,
  loadDiagnosticsSharingPreference,
  setDiagnosticsSharingEnabled,
  __resetDiagnosticsSharingPreferenceForTests,
} from "../../diagnosticsSharingPreference";
import {
  COUNT_BUCKETS,
  DB_MB_BUCKETS,
  DIAG_MACHINE_KEYS,
  DIAG_NUMBER_SETS,
  DIAG_ROUTE_KEYS,
  MAX_CPU_CORES,
  MAX_MAIL_ACCOUNTS,
  RAM_BUCKETS_GB,
  allowedAttributeKeys,
} from "../fields";
import * as perf from "../perf";
import { filterEnvelopeLogs } from "../diagnosticsLogTransport";
import { buildDeviceProfile, ramBucketGB } from "../../deviceProfile/buildDeviceProfile";

const BASE = ["keepr.diag", "keepr.op", "keepr.os", "keepr.appVersion", "keepr.deviceId"];
const HEALTH_ROUTE = ["poolState", "countsState", "contactsBucket", "addressBookBucket", "dbSizeBucketMB", "mailAccounts"].map((k) => `keepr.${k}`);
const MACHINE = ["keepr.ramGB", "keepr.cpuCores", "keepr.diskType", "keepr.softwareRendering"];

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

type Attrs = Record<string, string | number | boolean>;
const sunk: Array<{ body: string; attrs: Attrs }> = [];
let machineClass: Record<string, unknown> | null = null;
beforeEach(() => {
  __resetDiagnosticsSharingPreferenceForTests();
  perf.__resetDiagnosticsForTests();
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-4185-envh-"));
  dirs.push(d);
  loadDiagnosticsSharingPreference(d);
  sunk.length = 0;
  machineClass = null;
  perf.configureDiagnostics({
    sink: (_level, body, attrs) => void sunk.push({ body, attrs: { ...attrs } }),
    appVersion: "2.48.0",
    os: "darwin-24.6.0",
    machineClass: () => machineClass,
  });
});

const attr = (v: unknown) => ({ value: v, type: typeof v === "string" ? "string" : typeof v === "boolean" ? "boolean" : "integer" });
function envOf(attrs: Record<string, unknown>): Parameters<typeof filterEnvelopeLogs>[0] {
  const log = { timestamp: 1, level: "info", body: "x", attributes: Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, attr(v)])) };
  return [{ sent_at: "x" }, [[{ type: "log", item_count: 1 }, { items: [log] }]]];
}
function sentAttrs(env: ReturnType<typeof filterEnvelopeLogs>): Record<string, unknown> {
  expect(env).not.toBeNull();
  const items = (env![1][0][1] as { items: Array<{ attributes: Record<string, { value: unknown }> }> }).items;
  expect(items).toHaveLength(1);
  return Object.fromEntries(Object.entries(items[0].attributes).map(([k, a]) => [k, a.value]));
}
const forged = (extra: Record<string, unknown>) => ({
  "keepr.diag": true,
  "keepr.op": "env.health",
  "keepr.deviceId": getDiagnosticsDeviceId(),
  "keepr.os": "darwin-24.6.0",
  ...extra,
});

describe("CT1 send-time value checks on a forged log (closes the R2 gap)", () => {
  it("CT1a a path string in a numeric field is dropped; the log itself survives", () => {
    const out = sentAttrs(filterEnvelopeLogs(envOf(forged({ "keepr.op": "ipc.slow", "keepr.durationMs": "/Users/x/Library", "keepr.ramGB": "/Users/x" }))));
    expect(out["keepr.op"]).toBe("ipc.slow");
    expect(Object.keys(out)).not.toContain("keepr.durationMs");
    expect(Object.keys(out)).not.toContain("keepr.ramGB");
  });

  it("CT1b out-of-set numbers, numbers in boolean fields and bad strings are dropped; in-set values kept", () => {
    const out = sentAttrs(
      filterEnvelopeLogs(
        envOf(
          forged({
            "keepr.contactsBucket": 184231,
            "keepr.ramGB": 17,
            "keepr.cpuCores": 0.5,
            "keepr.softwareRendering": 1,
            "keepr.mailAccounts": MAX_MAIL_ACCOUNTS + 1,
            "keepr.poolState": "up",
            "keepr.countsState": "jane@example.com",
            "keepr.diskType": "Samsung SSD 980",
            "keepr.addressBookBucket": 10_000,
            "keepr.dbSizeBucketMB": 500,
          }),
        ),
      ),
    );
    for (const k of [
      "keepr.contactsBucket",
      "keepr.ramGB",
      "keepr.cpuCores",
      "keepr.softwareRendering",
      "keepr.mailAccounts",
      "keepr.poolState",
      "keepr.countsState",
      "keepr.diskType",
    ]) {
      expect({ k, present: k in out }).toEqual({ k, present: false });
    }
    expect(out["keepr.addressBookBucket"]).toBe(10_000);
    expect(out["keepr.dbSizeBucketMB"]).toBe(500);
  });
});

describe("CT2 capture-time checks (perf.ts on its own)", () => {
  it("out-of-set route numbers and bad machine values never reach the sink", () => {
    machineClass = { ramGB: 17, cpuCores: 10, diskType: "Samsung SSD", softwareRendering: 1 };
    perf.event("env.health", { contactsBucket: 184231, addressBookBucket: 1000, poolState: "ready" });
    expect(sunk).toHaveLength(1);
    const keys = Object.keys(sunk[0].attrs);
    for (const k of ["keepr.contactsBucket", "keepr.ramGB", "keepr.diskType", "keepr.softwareRendering"]) expect(keys).not.toContain(k);
    expect(sunk[0].attrs["keepr.cpuCores"]).toBe(10);
    expect(sunk[0].attrs["keepr.addressBookBucket"]).toBe(1000);
    expect(sunk[0].attrs["keepr.poolState"]).toBe("ready");
  });

  it("sharing OFF: env.health never reaches the sink", () => {
    setDiagnosticsSharingEnabled(false);
    perf.event("env.health", { poolState: "ready" });
    expect(sunk).toHaveLength(0);
  });
});

describe("CT3 every new field ARRIVES through capture AND send; exact key sets", () => {
  it("env.health with machine class: 6 route + 4 machine keys, key set EQUALS", () => {
    machineClass = { ramGB: 16, cpuCores: 10, diskType: "ssd", softwareRendering: false };
    perf.event("env.health", { poolState: "ready", countsState: "ok", contactsBucket: 1000, addressBookBucket: 1, dbSizeBucketMB: 1000, mailAccounts: 2 });
    const out = sentAttrs(filterEnvelopeLogs(envOf(sunk[0].attrs)));
    expect(new Set(Object.keys(out))).toEqual(new Set([...BASE, ...HEALTH_ROUTE, ...MACHINE]));
    expect(sunk[0].body).toBe("env.health");
  });

  it("ipc.slow with no machine class known: no machine key", () => {
    perf.track("ipc.slow", 1200, { channel: "contacts:get-all" });
    const out = sentAttrs(filterEnvelopeLogs(envOf(sunk[0].attrs)));
    expect(new Set(Object.keys(out))).toEqual(new Set([...BASE, "keepr.durationMs", "keepr.channel"]));
  });

  it("ipc.slow with machine class: the 4 machine keys ride along", () => {
    machineClass = { ramGB: 8, cpuCores: 4, diskType: "hdd", softwareRendering: true };
    perf.track("ipc.slow", 1200, { channel: "contacts:get-all" });
    const out = sentAttrs(filterEnvelopeLogs(envOf(sunk[0].attrs)));
    expect(new Set(Object.keys(out))).toEqual(new Set([...BASE, "keepr.durationMs", "keepr.channel", ...MACHINE]));
  });

  it("pin: no route names a machine key; every op allows every machine key", () => {
    expect([...DIAG_MACHINE_KEYS]).toEqual(MACHINE);
    for (const [op, keys] of Object.entries(DIAG_ROUTE_KEYS)) {
      for (const k of keys as readonly string[]) expect(MACHINE).not.toContain(`keepr.${k}`);
      for (const m of DIAG_MACHINE_KEYS) expect(allowedAttributeKeys(op)!.has(m)).toBe(true);
    }
  });
});

describe("C5 one declaration per value table; builder and allowlist agree at the bounds", () => {
  it("the allowlist sets ARE the shared tables", () => {
    expect(DIAG_NUMBER_SETS.ramGB).toBe(RAM_BUCKETS_GB);
    expect(DIAG_NUMBER_SETS.contactsBucket).toBe(COUNT_BUCKETS);
    expect(DIAG_NUMBER_SETS.addressBookBucket).toBe(COUNT_BUCKETS);
    expect(DIAG_NUMBER_SETS.dbSizeBucketMB).toBe(DB_MB_BUCKETS);
  });

  it("buildDeviceProfile.ts declares no bucket table of its own", () => {
    const src = fs.readFileSync(path.join(__dirname, "../../deviceProfile/buildDeviceProfile.ts"), "utf8");
    expect(src).not.toMatch(/\b(COUNT_BUCKETS|DB_MB_BUCKETS|RAM_BUCKETS_GB|MAX_CPU_CORES|MAX_MAIL_ACCOUNTS)\s*=/);
    expect(src).not.toMatch(/\[\s*2,\s*4,\s*8,\s*16/);
    expect(src).not.toMatch(/\b1024\)\s*&&/);
  });

  it("every RAM class the builder can produce is in the allowlist (1..200 GB)", () => {
    for (let gb = 1; gb <= 200; gb++) expect(DIAG_NUMBER_SETS.ramGB).toContain(ramBucketGB(gb));
  });

  it.each([
    [1, true],
    [MAX_CPU_CORES, true],
    [MAX_CPU_CORES + 1, false],
  ])("cpuCores %d: builder keeps it = %s, and so does the log", (cores, kept) => {
    const mc = buildDeviceProfile({ platform: "darwin", cpuCores: cores }, "log");
    expect(mc.cpuCores !== undefined).toBe(kept);
    machineClass = { cpuCores: cores };
    perf.track("ipc.slow", 1200, { channel: "contacts:get-all" });
    const out = sentAttrs(filterEnvelopeLogs(envOf({ ...sunk[0].attrs, "keepr.cpuCores": cores })));
    expect("keepr.cpuCores" in sunk[0].attrs).toBe(kept);
    expect("keepr.cpuCores" in out).toBe(kept);
  });

  it.each([
    [MAX_MAIL_ACCOUNTS, MAX_MAIL_ACCOUNTS],
    [MAX_MAIL_ACCOUNTS + 5, MAX_MAIL_ACCOUNTS],
  ])("mailAccounts %d -> builder %d, which the allowlist accepts", (n, want) => {
    const h = buildDeviceProfile({ platform: "darwin", mailAccounts: n }, "health");
    expect(h.mailAccounts).toBe(want);
    expect(DIAG_NUMBER_SETS.mailAccounts).toContain(h.mailAccounts);
  });
});
