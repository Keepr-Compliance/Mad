/**
 * @jest-environment node
 */
/**
 * BACKLOG-4185 PR B: the one profile builder.
 *   P11 strict per-platform formats (a value that fails is absent)
 *   P12 exact key sets per target; no spread; no "event" target
 */
import fs from "fs";
import path from "path";
import { LOG_KEYS, ROW_KEYS, buildDeviceProfile, ramBucketGB, twoSigFigs, type CollectedProfile } from "../buildDeviceProfile";

const FULL_MAC: CollectedProfile = {
  platform: "darwin",
  cpuModel: "Apple   M1 Max",
  cpuCores: 10,
  ramBytes: 32 * 1024 ** 3,
  diskType: "ssd",
  diskBus: "nvme",
  osVersion: "15.7.3",
  osBuild: "24G419",
  gpuCompositing: "enabled",
  gpuVendor: "apple",
  softwareRendering: false,
  av: "notApplicable",
  avEnabled: true,
  avDefsCurrent: true,
  poolReady: true,
  messages: 184231,
  contacts: 2040,
  addressBook: 512,
  mailAccounts: 2,
  dbBytes: 1_500 * 1024 ** 2,
  countsState: "ok",
};

describe("P12 exact key sets", () => {
  it("row: exactly ROW_KEYS minus the Windows-only display version", () => {
    const row = buildDeviceProfile(FULL_MAC, "row");
    expect(Object.keys(row).sort()).toEqual(ROW_KEYS.filter((k) => k !== "osDisplayVersion").sort());
  });
  it("row on Windows carries osDisplayVersion", () => {
    const row = buildDeviceProfile(
      { ...FULL_MAC, platform: "win32", osVersion: "10.0.26100", osBuild: "2894", osDisplayVersion: "24H2", av: ["defender"] },
      "row",
    );
    expect(Object.keys(row).sort()).toEqual([...ROW_KEYS].sort());
  });
  it("log: exactly the four machine-class keys, nothing else", () => {
    const log = buildDeviceProfile(FULL_MAC, "log");
    expect(Object.keys(log).sort()).toEqual([...LOG_KEYS].sort());
    expect(log).toEqual({ ramGB: 32, cpuCores: 10, diskType: "ssd", softwareRendering: false });
  });
  it("extra input keys never ride along (no spread)", () => {
    const dirty = { ...FULL_MAC, hostname: "jane-mbp", displayName: "Jane", rawPath: "/Users/jane/Library", deviceId: "abc" } as CollectedProfile;
    const row = JSON.stringify(buildDeviceProfile(dirty, "row"));
    const log = JSON.stringify(buildDeviceProfile(dirty, "log"));
    for (const s of ["jane", "Jane", "/Users", "abc", "hostname"]) {
      expect(row).not.toContain(s);
      expect(log).not.toContain(s);
    }
  });
  it("exact sizes never leave: 2 significant figures on the row, absent on the log", () => {
    const row = buildDeviceProfile(FULL_MAC, "row");
    expect(row).toMatchObject({ messages: 180000, contacts: 2000, addressBook: 510, dbMB: 1500, mailAccounts: 2 });
    expect(JSON.stringify(buildDeviceProfile(FULL_MAC, "log"))).not.toMatch(/184231|2040|512/);
  });
  it("there is no event target (events carry the devices row id only)", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "buildDeviceProfile.ts"), "utf8");
    expect(src).not.toMatch(/target:\s*"[^"]*event/);
    expect(src).not.toMatch(/EVENT_KEYS/);
  });
});

describe("P11 strict formats", () => {
  const os = (o: Partial<CollectedProfile>) => buildDeviceProfile({ ...FULL_MAC, ...o }, "row");
  it.each(["15.7.3", "11.0", "26.1", "26.0.1"])("mac version %s accepted", (v) => {
    expect(os({ osVersion: v }).osVersion).toBe(v);
  });
  it.each(["15.7.3.Jane", "jane-mbp", "Jane", "10.15.7", "15", ""])("mac version %p rejected", (v) => {
    expect(os({ osVersion: v })).not.toHaveProperty("osVersion");
  });
  it.each(["24G419", "25A5279m"])("mac build %s accepted", (v) => {
    expect(os({ osBuild: v }).osBuild).toBe(v);
  });
  it.each(["jane-mbp", "Jane", "24G419.Jane", "24g419"])("mac build %p rejected", (v) => {
    expect(os({ osBuild: v })).not.toHaveProperty("osBuild");
  });
  it("windows formats: release, UBR, display version", () => {
    const w = (o: Partial<CollectedProfile>) => buildDeviceProfile({ ...FULL_MAC, platform: "win32", ...o }, "row");
    expect(w({ osVersion: "10.0.26100", osBuild: "2894", osDisplayVersion: "24H2" })).toMatchObject({
      osVersion: "10.0.26100",
      osBuild: "2894",
      osDisplayVersion: "24H2",
    });
    const bad = w({ osVersion: "10.0.26100.Jane", osBuild: "jane", osDisplayVersion: "Jane" });
    expect(bad).not.toHaveProperty("osVersion");
    expect(bad).not.toHaveProperty("osBuild");
    expect(bad).not.toHaveProperty("osDisplayVersion");
  });
  it("cpu model: whitespace collapsed; disallowed characters drop the field", () => {
    expect(os({}).cpuModel).toBe("Apple M1 Max");
    expect(os({ cpuModel: "Intel(R) Core(TM) i7-8700 CPU @ 3.20GHz" }).cpuModel).toBe("Intel(R) Core(TM) i7-8700 CPU @ 3.20GHz");
    expect(os({ cpuModel: "C:\\Users\\jane" })).not.toHaveProperty("cpuModel");
    expect(os({ cpuModel: "x".repeat(65) })).not.toHaveProperty("cpuModel");
  });
  it("enums: an unknown value is absent", () => {
    const row = os({ diskType: "nvme-ssd" as never, gpuVendor: "matrox" as never, countsState: "weird" as never, gpuCompositing: "Enabled!" });
    for (const k of ["diskType", "gpuVendor", "countsState", "gpuCompositing"]) expect(row).not.toHaveProperty(k);
  });
  it("av: only enum products survive, deduped and sorted", () => {
    expect(os({ av: ["norton", "defender", "Jane's AV" as never, "defender"] }).av).toEqual(["defender", "norton"]);
  });
});

describe("rounding", () => {
  it("twoSigFigs", () => {
    expect([0, 7, 42, 184231, 1049, 999].map(twoSigFigs)).toEqual([0, 7, 42, 180000, 1000, 1000]);
  });
  it("ramBucketGB uses lower bounds with 10% slack (a 15.9 GB Mac is 16)", () => {
    expect([2, 4, 7, 8, 15, 16, 24, 36, 64, 192].map(ramBucketGB)).toEqual([2, 4, 4, 8, 16, 16, 16, 32, 64, 128]);
  });
});
