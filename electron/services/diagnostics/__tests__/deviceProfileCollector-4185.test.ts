/**
 * @jest-environment node
 */
/**
 * BACKLOG-4185 PR B: the device-profile collector.
 *
 * Fixtures:
 *   - macOS SystemVersion.plist and the diskutil keys are TRANSCRIBED from one
 *     macOS 15.7.3 run (2026-11-11); BuildID zeroed, every other diskutil key
 *     (volume names, sizes, UUIDs) left out.
 *   - Windows: fixtures/win-profile-probe.json, PENDING-TRANSCRIPTION until the
 *     probe script has run once on a Windows client PC. The productState rows
 *     below are built from the bit layout only (UNVERIFIED), not real values.
 */
import { execFile as realExecFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  WINDOWS_PROBE_SCRIPT,
  collectHardwareProfile,
  decodeProductState,
  driveLetterOf,
  mapAvName,
  mapBusType,
  mapMediaType,
  parseDiskutilPlist,
  parseGpu,
  parseMacSystemVersion,
  parseWindowsProbe,
  type CollectorDeps,
} from "../deviceProfileCollector";
import { buildDeviceProfile, AV_PRODUCTS, FORMATS } from "../../deviceProfile/buildDeviceProfile";

const REPO = path.resolve(__dirname, "../../../..");

const SYSTEM_VERSION_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>BuildID</key>
	<string>00000000-0000-0000-0000-000000000000</string>
	<key>ProductBuildVersion</key>
	<string>24G419</string>
	<key>ProductCopyright</key>
	<string>1983-2025 Apple Inc.</string>
	<key>ProductName</key>
	<string>macOS</string>
	<key>ProductUserVisibleVersion</key>
	<string>15.7.3</string>
	<key>ProductVersion</key>
	<string>15.7.3</string>
	<key>iOSSupportVersion</key>
	<string>18.7</string>
</dict>
</plist>`;

const DISKUTIL_KEYS = `<dict>
	<key>BusProtocol</key>
	<string>Apple Fabric</string>
	<key>Internal</key>
	<true/>
	<key>SolidState</key>
	<true/>
</dict>`;

/** bit layout only: bits 12-15 = 1 -> on; bits 4-7 = 0 -> signatures current. UNVERIFIED. */
const STATE = { onCurrent: 1 << 12, onStale: (1 << 12) | (1 << 4), off: 0 };

describe("macOS readers (transcribed)", () => {
  it("SystemVersion.plist -> version + build", () => {
    expect(parseMacSystemVersion(SYSTEM_VERSION_PLIST)).toEqual({ osVersion: "15.7.3", osBuild: "24G419" });
  });
  it("diskutil -plist -> ssd / nvme (Apple Fabric)", () => {
    expect(parseDiskutilPlist(DISKUTIL_KEYS)).toEqual({ diskType: "ssd", diskBus: "nvme" });
  });
  it("diskutil variants", () => {
    const p = (ss: string, bus: string) => `<key>SolidState</key><${ss}/><key>BusProtocol</key><string>${bus}</string>`;
    expect(parseDiskutilPlist(p("false", "SATA"))).toEqual({ diskType: "hdd", diskBus: "sata" });
    expect(parseDiskutilPlist(p("true", "USB"))).toEqual({ diskType: "ssd", diskBus: "usb" });
    expect(parseDiskutilPlist(p("true", "Thunderbolt"))).toEqual({ diskType: "ssd", diskBus: "other" });
    expect(parseDiskutilPlist("garbage")).toEqual({ diskType: "unknown", diskBus: "unknown" });
  });
});

describe("Windows mapping", () => {
  it("MSFT_PhysicalDisk BusType / MediaType codes", () => {
    expect([17, 11, 3, 7, 8, 1, null].map(mapBusType)).toEqual(["nvme", "sata", "sata", "usb", "raid", "other", "unknown"]);
    expect(mapMediaType(4, "sata")).toBe("ssd");
    expect(mapMediaType(3, "sata")).toBe("hdd");
    expect(mapMediaType(0, "nvme")).toBe("ssd");
    expect(mapMediaType(0, "sata")).toBe("unknown");
  });
  it("AV display name -> closed enum; unknown vendors are 'other'", () => {
    expect(mapAvName("Windows Defender")).toBe("defender");
    expect(mapAvName("Norton 360")).toBe("norton");
    expect(mapAvName("AVG Antivirus")).toBe("avg");
    expect(mapAvName("Jane's Home Shield")).toBe("other");
    expect(mapAvName(undefined)).toBe("other");
  });
  it("productState decode from the bit layout (UNVERIFIED against a real client)", () => {
    expect(decodeProductState(STATE.onCurrent)).toEqual({ on: true, defsCurrent: true });
    expect(decodeProductState(STATE.onStale)).toEqual({ on: true, defsCurrent: false });
    expect(decodeProductState(STATE.off)).toEqual({ on: false, defsCurrent: true });
    expect(decodeProductState(-1)).toBeNull();
    expect(decodeProductState(0x1000000)).toBeNull();
    expect(decodeProductState("4096")).toBeNull();
  });
  it("probe JSON -> fields; the raw AV name never appears in the output", () => {
    const line = JSON.stringify({
      v: 1,
      avState: "ok",
      av: [
        { n: "Windows Defender", s: STATE.off },
        { n: "Jane's Home Shield", s: STATE.onStale },
      ],
      disk: { media: 4, bus: 17 },
      ubr: 2894,
      displayVersion: "24H2",
    });
    const out = parseWindowsProbe(line);
    expect(out).toEqual({
      av: ["defender", "other"],
      avEnabled: true,
      avDefsCurrent: false,
      diskType: "ssd",
      diskBus: "nvme",
      osBuild: "2894",
      osDisplayVersion: "24H2",
    });
    expect(JSON.stringify(out)).not.toContain("Jane");
  });
  it("Security Center absent (Windows Server) -> unavailable; garbage -> unknown", () => {
    expect(parseWindowsProbe('{"avState":"unavailable","av":[],"disk":{"media":null,"bus":null}}').av).toBe("unavailable");
    expect(parseWindowsProbe("not json")).toEqual({ av: "unknown", diskType: "unknown", diskBus: "unknown" });
  });
  it("drive letter comes from the userData path; the path itself is never kept", () => {
    expect(driveLetterOf("D:\\Users\\x\\AppData\\Roaming\\keepr")).toBe("D");
    expect(driveLetterOf("/Users/x")).toBe("C");
  });
});

describe("Windows fixture (transcribed from one real client run)", () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "win-profile-probe.json"), "utf8")) as {
    status: string;
    line: string | null;
  };
  const transcribed = fixture.status === "TRANSCRIBED" && typeof fixture.line === "string";
  // While PENDING-TRANSCRIPTION these three show as "todo" in every run's summary.
  const itReal = (name: string, fn: () => void): void => (transcribed ? it(name, fn) : it.todo(name));

  it("the fixture is either PENDING-TRANSCRIPTION or a transcribed line", () => {
    expect(["PENDING-TRANSCRIPTION", "TRANSCRIBED"]).toContain(fixture.status);
  });
  itReal("W1 the real line parses: av products in the enum, disk mapped, OS fields well-formed", () => {
    const out = parseWindowsProbe(fixture.line as string);
    if (Array.isArray(out.av)) for (const p of out.av) expect(AV_PRODUCTS).toContain(p);
    else expect(out.av).toBe("unavailable");
    expect(["ssd", "hdd", "unknown"]).toContain(out.diskType);
    expect(out.diskType).not.toBe("unknown");
    if (out.osBuild !== undefined) expect(out.osBuild).toMatch(FORMATS.winUbr);
    if (out.osDisplayVersion !== undefined) expect(out.osDisplayVersion).toMatch(FORMATS.winDisplayVersion);
  });
  itReal("W2 every real productState decodes under the bit layout, and an active product reads as on", () => {
    const raw = JSON.parse(fixture.line as string) as { av: Array<{ s: number }> };
    for (const a of raw.av) expect(decodeProductState(a.s)).not.toBeNull();
    expect(parseWindowsProbe(fixture.line as string).avEnabled).toBe(true);
  });
  itReal("W3 no raw AV display name survives into the row", () => {
    const raw = JSON.parse(fixture.line as string) as { av: Array<{ n: string }> };
    const row = JSON.stringify(buildDeviceProfile({ platform: "win32", ...parseWindowsProbe(fixture.line as string) }, "row"));
    for (const a of raw.av) expect(row).not.toContain(a.n);
  });
});

describe("the embedded script is the checked-in probe", () => {
  it("WINDOWS_PROBE_SCRIPT equals scripts/qa/win-device-profile-probe.ps1 from its param( line down", () => {
    const ps = fs.readFileSync(path.join(REPO, "scripts/qa/win-device-profile-probe.ps1"), "utf8").replace(/\r\n/g, "\n");
    const start = ps.search(/^param\(/m);
    expect(start).toBeGreaterThan(0);
    expect(WINDOWS_PROBE_SCRIPT).toBe(ps.slice(start).replace(/\n+$/, ""));
  });
  it("the script reads no computer name, user name or path", () => {
    expect(WINDOWS_PROBE_SCRIPT).not.toMatch(/ComputerName|USERNAME|UserName|\$env:USERPROFILE|\$HOME|Win32_ComputerSystem|SerialNumber/);
  });
});

describe("GPU", () => {
  it("vendor from the active device; Basic Render Driver or software compositing => software rendering", () => {
    expect(parseGpu({ gpu_compositing: "enabled" }, { gpuDevice: [{ vendorId: 0x10de, active: true }] })).toEqual({
      gpuCompositing: "enabled",
      gpuVendor: "nvidia",
      softwareRendering: false,
    });
    expect(parseGpu({ gpu_compositing: "enabled" }, { gpuDevice: [{ vendorId: 0x1414, active: true }] }).softwareRendering).toBe(true);
    expect(parseGpu({ gpu_compositing: "disabled_software" }, {}).softwareRendering).toBe(true);
  });
});

function fakeDeps(over: Partial<CollectorDeps>): { deps: CollectorDeps; calls: Array<{ file: string; args: string[]; opts: unknown }> } {
  const calls: Array<{ file: string; args: string[]; opts: unknown }> = [];
  const deps: CollectorDeps = {
    platform: "darwin",
    execFile: (file, args, opts, cb) => {
      calls.push({ file, args, opts });
      setImmediate(() => cb(null, DISKUTIL_KEYS));
      return undefined;
    },
    readFile: async () => SYSTEM_VERSION_PLIST,
    cpus: () => [{ model: "Apple M1 Max" }, { model: "Apple M1 Max" }],
    totalmem: () => 32 * 1024 ** 3,
    release: () => "10.0.26100",
    app: { getGPUFeatureStatus: () => ({ gpu_compositing: "enabled" }), getGPUInfo: async () => ({ gpuDevice: [{ vendorId: 0x106b, active: true, deviceId: 0x1234 }] }) },
    userDataDir: path.join(os.homedir(), "Library", "Application Support", "keepr"),
    ...over,
  };
  return { deps, calls };
}

describe("collectHardwareProfile", () => {
  it("macOS: async diskutil with a timeout; av notApplicable", async () => {
    const { deps, calls } = fakeDeps({});
    const out = await collectHardwareProfile(deps);
    expect(calls).toEqual([{ file: "/usr/sbin/diskutil", args: ["info", "-plist", "/"], opts: expect.objectContaining({ timeout: 5000 }) }]);
    expect(out).toMatchObject({ platform: "darwin", cpuCores: 2, osVersion: "15.7.3", osBuild: "24G419", diskType: "ssd", diskBus: "nvme", av: "notApplicable", gpuVendor: "apple" });
  });
  it("Windows: ONE PowerShell call; drive letter in the env, never in the command text", async () => {
    const probeLine = JSON.stringify({ avState: "ok", av: [{ n: "Windows Defender", s: STATE.onCurrent }], disk: { media: 4, bus: 17 }, ubr: 2894, displayVersion: "24H2" });
    const { deps, calls } = fakeDeps({
      platform: "win32",
      userDataDir: "D:\\Users\\x\\AppData\\Roaming\\keepr",
      execFile: (file, args, opts, cb) => {
        calls.push({ file, args, opts });
        setImmediate(() => cb(null, probeLine));
        return undefined;
      },
    });
    const out = await collectHardwareProfile(deps);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROBE_SCRIPT]);
    expect(calls[0].opts).toEqual(expect.objectContaining({ timeout: 15000, windowsHide: true, maxBuffer: 65536 }));
    expect((calls[0].opts as { env: NodeJS.ProcessEnv }).env?.KEEPR_PROBE_DRIVE).toBe("D");
    expect(JSON.stringify(calls[0].args)).not.toContain("Users");
    expect(out).toMatchObject({ osVersion: "10.0.26100", osBuild: "2894", av: ["defender"], avEnabled: true, diskType: "ssd" });
  });
  it("one failing reader loses one field", async () => {
    const { deps } = fakeDeps({ execFile: (_f, _a, _o, cb) => (setImmediate(() => cb(new Error("timeout"), "")), undefined) });
    const out = await collectHardwareProfile(deps);
    expect(out).toMatchObject({ diskType: "unknown", diskBus: "unknown", osBuild: "24G419", cpuCores: 2 });
  });
  it("B5: nothing identifying in the collected profile or the row", async () => {
    const { deps } = fakeDeps({});
    const out = JSON.stringify(await collectHardwareProfile(deps));
    const row = JSON.stringify(buildDeviceProfile(await collectHardwareProfile(deps), "row"));
    expect(row).toContain('"ramGB":32'); // positive control
    for (const s of [os.homedir(), deps.userDataDir, os.hostname(), os.userInfo().username, "mad.db", "4660"]) {
      expect(out).not.toContain(s);
      expect(row).not.toContain(s);
    }
  });
  it("P1: a slow child (500 ms) does not block the event loop", async () => {
    const { deps } = fakeDeps({
      execFile: (_f, _a, opts, cb) =>
        realExecFile(process.execPath, ["-e", "setTimeout(() => process.stdout.write('x'), 500)"], opts, (err) => cb(err, DISKUTIL_KEYS)),
    });
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 5);
    try {
      await collectHardwareProfile(deps);
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(20);
  });
});
