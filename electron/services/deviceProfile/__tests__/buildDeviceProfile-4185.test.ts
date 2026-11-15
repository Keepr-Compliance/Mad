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
import { HEALTH_KEYS, LOG_KEYS, ROW_KEYS, buildDeviceProfile, ramBucketGB, twoSigFigs, type CollectedProfile } from "../buildDeviceProfile";
import { COUNT_BUCKETS, DB_MB_BUCKETS } from "../../diagnostics/fields";

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
    expect(row).toMatchObject({ contacts: 2000, addressBook: 510, dbMB: 1500, mailAccounts: 2 });
    expect(JSON.stringify(buildDeviceProfile(FULL_MAC, "log"))).not.toMatch(/2040|512/);
    expect(row).not.toHaveProperty("messages");
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

describe("BACKLOG-4181 PR 3: the env.health target", () => {
  const health = (c: Partial<CollectedProfile>) => buildDeviceProfile({ platform: "darwin", ...c }, "health");

  it("exactly HEALTH_KEYS, buckets only; no hardware, AV or exact size rides along", () => {
    const dirty = { ...FULL_MAC, av: ["defender"], hostname: "jane-mbp" } as CollectedProfile;
    const h = buildDeviceProfile(dirty, "health");
    expect(Object.keys(h).sort()).toEqual([...HEALTH_KEYS].sort());
    expect(h).toEqual({ poolState: "ready", countsState: "ok", contactsBucket: 1_000, addressBookBucket: 1, dbSizeBucketMB: 1_000, mailAccounts: 2 });
    const s = JSON.stringify(h);
    for (const bad of ["defender", "M1", "24G419", "2040", "512", "1500", "jane", "nvme", "apple"]) expect({ bad, hit: s.includes(bad) }).toEqual({ bad, hit: false });
  });

  it("poolReady false -> down; absent inputs are absent, not zero", () => {
    expect(health({ poolReady: false })).toEqual({ poolState: "down" });
    expect(health({})).toEqual({});
  });

  it("buckets come from the EXACT value: 999 -> 1, never 1000 via 2-sig-fig rounding", () => {
    expect(twoSigFigs(999)).toBe(1000); // the trap the row target would set
    expect(health({ contacts: 999 }).contactsBucket).toBe(1);
    expect(health({ addressBook: 9_960 }).addressBookBucket).toBe(1_000);
  });

  const sweep = (bounds: readonly number[]) =>
    bounds
      .filter((b) => b > 0)
      .flatMap((b) => {
        const below = bounds[bounds.indexOf(b) - 1];
        return [
          [b - 1, below],
          [b, b],
          [b + 1, b],
        ];
      });
  it.each(sweep(COUNT_BUCKETS))("contacts %d -> %d (addressBook the same)", (n, want) => {
    expect(health({ contacts: n }).contactsBucket).toBe(want);
    expect(health({ addressBook: n }).addressBookBucket).toBe(want);
  });
  it.each(sweep(DB_MB_BUCKETS))("db %d MB -> %d", (mb, want) => {
    expect(health({ dbBytes: mb * 1024 ** 2 }).dbSizeBucketMB).toBe(want);
  });
});
