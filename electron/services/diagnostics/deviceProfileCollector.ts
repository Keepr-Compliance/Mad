/**
 * BACKLOG-4185: reads the machine's hardware profile, once per process, after
 * sign-in. Every reader is async or measured-cheap sync; none runs a sync child
 * process (static check: diagnosticsUnits-4181 "deviceProfile" scan).
 *
 * | Field             | macOS                                  | Windows                          |
 * |-------------------|----------------------------------------|----------------------------------|
 * | CPU model / cores | os.cpus()                              | os.cpus()                        |
 * | RAM               | os.totalmem()                          | os.totalmem()                    |
 * | OS version/build  | SystemVersion.plist (async read)       | os.release() + probe UBR/DisplayVersion |
 * | disk type / bus   | execFile diskutil info -plist / (async)| ONE execFile PowerShell probe    |
 * | AV                | "notApplicable"                        | same probe, root/SecurityCenter2 |
 * | GPU               | app.getGPUFeatureStatus / getGPUInfo("basic") | same                      |
 *
 * Never read or returned: hostname, user name, any path, serial, PCI device id,
 * the raw AV display name, productState. Each reader catches its own error, so
 * one failure loses one field.
 */
import { execFile as nodeExecFile } from "child_process";
import { promises as fsp } from "fs";
import os from "os";
import { powershellPath } from "../appleInstallerSignature";
import type { AvProduct, CollectedProfile, DiskBus, DiskType, GpuVendor } from "../deviceProfile/buildDeviceProfile";

export const DISKUTIL_TIMEOUT_MS = 5_000;
export const WINDOWS_PROBE_TIMEOUT_MS = 15_000;

/**
 * The Windows probe. Kept byte-identical to scripts/qa/win-device-profile-probe.ps1
 * from its `param(` line down (pinned by test). The drive letter goes in the
 * KEEPR_PROBE_DRIVE environment variable, never into the command text.
 */
export const WINDOWS_PROBE_SCRIPT = String.raw`param([string]$Drive = $env:KEEPR_PROBE_DRIVE)
$ErrorActionPreference = 'Stop'
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($Drive -notmatch '^[A-Za-z]$') { $Drive = 'C' }
$Drive = $Drive.ToUpperInvariant()

$out = [ordered]@{ v = 1; avState = 'unavailable'; av = @(); disk = [ordered]@{ media = $null; bus = $null }; ubr = $null; displayVersion = $null }

try {
  $out.av = @(Get-CimInstance -Namespace 'root/SecurityCenter2' -ClassName 'AntiVirusProduct' |
    ForEach-Object { [ordered]@{ n = [string]$_.displayName; s = [int64]$_.productState } })
  $out.avState = 'ok'
} catch { $out.avState = 'unavailable' }

try {
  $part = Get-CimInstance -Namespace 'root/Microsoft/Windows/Storage' -ClassName 'MSFT_Partition' |
    Where-Object { [string]$_.DriveLetter -eq $Drive } | Select-Object -First 1
  if ($part) {
    $pd = Get-CimInstance -Namespace 'root/Microsoft/Windows/Storage' -ClassName 'MSFT_PhysicalDisk' |
      Where-Object { [string]$_.DeviceId -eq [string]$part.DiskNumber } | Select-Object -First 1
    if ($pd) { $out.disk.media = [int]$pd.MediaType; $out.disk.bus = [int]$pd.BusType }
  }
} catch { }

try {
  $cv = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -Name 'UBR', 'DisplayVersion' -ErrorAction SilentlyContinue
  if ($cv) { $out.ubr = $cv.UBR; $out.displayVersion = [string]$cv.DisplayVersion }
} catch { }

$out.ms = [int]$sw.ElapsedMilliseconds
$out.ps = [string]$PSVersionTable.PSVersion
$out.is64 = [Environment]::Is64BitProcess
ConvertTo-Json -InputObject $out -Compress -Depth 4`;

type ExecFileFn = (
  file: string,
  args: string[],
  options: { timeout: number; windowsHide?: boolean; maxBuffer?: number; encoding: "utf8"; env?: NodeJS.ProcessEnv },
  cb: (error: Error | null, stdout: string) => void,
) => unknown;

interface GpuApp {
  getGPUFeatureStatus(): object;
  getGPUInfo(infoType: "basic"): Promise<unknown>;
}

export interface CollectorDeps {
  platform: NodeJS.Platform;
  execFile: ExecFileFn;
  readFile: (p: string, enc: "utf8") => Promise<string>;
  cpus: () => Array<{ model: string }>;
  totalmem: () => number;
  release: () => string;
  app: GpuApp | null;
  /** The userData directory: only its drive letter is used, on Windows. */
  userDataDir: string;
}

// ---- pure parsers ---------------------------------------------------------

export function parseMacSystemVersion(plist: string): { osVersion?: string; osBuild?: string } {
  const pick = (key: string): string | undefined => {
    const m = plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]{1,32})</string>`));
    return m ? m[1] : undefined;
  };
  return { osVersion: pick("ProductVersion"), osBuild: pick("ProductBuildVersion") };
}

export function parseDiskutilPlist(plist: string): { diskType: DiskType; diskBus: DiskBus } {
  const ss = /<key>SolidState<\/key>\s*<(true|false)\/>/.exec(plist);
  const bus = /<key>BusProtocol<\/key>\s*<string>([^<]{1,40})<\/string>/.exec(plist);
  const diskType: DiskType = ss ? (ss[1] === "true" ? "ssd" : "hdd") : "unknown";
  let diskBus: DiskBus = "unknown";
  if (bus) {
    const b = bus[1];
    // Apple Fabric = the internal Apple silicon SSD (an NVMe device on the fabric).
    if (b === "PCI-Express" || b === "PCI" || b === "Apple Fabric" || b === "NVMe") diskBus = "nvme";
    else if (b === "SATA") diskBus = "sata";
    else if (b === "USB") diskBus = "usb";
    else diskBus = "other";
  }
  return { diskType, diskBus };
}

/** MSFT_PhysicalDisk.BusType (documented Storage Management API enum). */
export function mapBusType(code: unknown): DiskBus {
  if (typeof code !== "number") return "unknown";
  if (code === 17) return "nvme";
  if (code === 11 || code === 3) return "sata";
  if (code === 7) return "usb";
  if (code === 8) return "raid";
  return "other";
}

/** MSFT_PhysicalDisk.MediaType: 3 HDD, 4 SSD, 5 SCM, 0 unspecified. */
export function mapMediaType(code: unknown, bus: DiskBus): DiskType {
  if (code === 4 || code === 5) return "ssd";
  if (code === 3) return "hdd";
  // Unspecified on an NVMe bus is still solid-state; otherwise we do not know.
  return bus === "nvme" ? "ssd" : "unknown";
}

const AV_NAME_RULES: ReadonlyArray<[RegExp, AvProduct]> = [
  [/windows defender|microsoft defender/i, "defender"],
  [/norton|symantec/i, "norton"],
  [/mcafee/i, "mcafee"],
  [/bitdefender/i, "bitdefender"],
  [/kaspersky/i, "kaspersky"],
  [/avast/i, "avast"],
  [/\bavg\b/i, "avg"],
  [/\beset\b/i, "eset"],
  [/sophos/i, "sophos"],
  [/trend\s*micro/i, "trendmicro"],
  [/malwarebytes/i, "malwarebytes"],
  [/webroot/i, "webroot"],
  [/crowdstrike|falcon/i, "crowdstrike"],
  [/sentinel\s*one/i, "sentinelone"],
];

/** Vendor display name -> closed enum. The raw name never leaves this module. */
export function mapAvName(name: unknown): AvProduct {
  if (typeof name !== "string") return "other";
  for (const [re, product] of AV_NAME_RULES) if (re.test(name)) return product;
  return "other";
}

/**
 * Security Center `productState` decode. UNVERIFIED: Microsoft does not
 * document this field; the layout below is the widely used community decode
 * and has not yet been checked against a transcribed Windows client run
 * (fixture: __tests__/fixtures/win-profile-probe.json, PENDING-TRANSCRIPTION).
 *   bits 12-15 (0x0000F000): 1 = protection on
 *   bits  4-7  (0x000000F0): 0 = signatures up to date
 */
export function decodeProductState(state: unknown): { on: boolean; defsCurrent: boolean } | null {
  if (typeof state !== "number" || !Number.isInteger(state) || state < 0 || state > 0xffffff) return null;
  return { on: ((state >> 12) & 0xf) === 1, defsCurrent: ((state >> 4) & 0xf) === 0 };
}

export interface WindowsProbeFields {
  av: AvProduct[] | "unavailable" | "unknown";
  avEnabled?: boolean;
  avDefsCurrent?: boolean;
  diskType: DiskType;
  diskBus: DiskBus;
  osBuild?: string;
  osDisplayVersion?: string;
}

/** Parse the probe's one JSON line. Anything unexpected -> "unknown" fields, never a throw. */
export function parseWindowsProbe(stdout: string): WindowsProbeFields {
  const unknown: WindowsProbeFields = { av: "unknown", diskType: "unknown", diskBus: "unknown" };
  let j: unknown;
  try {
    j = JSON.parse(stdout.trim());
  } catch {
    return unknown;
  }
  if (!j || typeof j !== "object") return unknown;
  const o = j as {
    avState?: unknown;
    av?: unknown;
    disk?: { media?: unknown; bus?: unknown } | null;
    ubr?: unknown;
    displayVersion?: unknown;
  };
  const out: WindowsProbeFields = { ...unknown };
  if (o.avState === "unavailable") {
    out.av = "unavailable";
  } else if (o.avState === "ok" && Array.isArray(o.av)) {
    const products: AvProduct[] = [];
    const states: Array<{ on: boolean; defsCurrent: boolean }> = [];
    for (const entry of o.av) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as { n?: unknown; s?: unknown };
      products.push(mapAvName(e.n));
      const d = decodeProductState(e.s);
      if (d) states.push(d);
    }
    out.av = [...new Set(products)].sort();
    if (states.length > 0) {
      const active = states.filter((s) => s.on);
      out.avEnabled = active.length > 0;
      out.avDefsCurrent = active.length > 0 ? active.every((s) => s.defsCurrent) : undefined;
    }
  }
  const bus = mapBusType(o.disk?.bus);
  out.diskBus = bus;
  out.diskType = mapMediaType(o.disk?.media, bus);
  if (typeof o.ubr === "number" && Number.isInteger(o.ubr)) out.osBuild = String(o.ubr);
  if (typeof o.displayVersion === "string") out.osDisplayVersion = o.displayVersion;
  return out;
}

/** Chromium vendor ids. Only the vendor is mapped; device ids are never read out. */
export function mapGpuVendor(vendorId: unknown): GpuVendor {
  switch (vendorId) {
    case 0x8086:
      return "intel";
    case 0x10de:
      return "nvidia";
    case 0x1002:
    case 0x1022:
      return "amd";
    case 0x106b:
      return "apple";
    case 0x1414:
      return "microsoft";
    default:
      return "other";
  }
}

export function parseGpu(
  featureStatus: Record<string, string> | null,
  info: unknown,
): { gpuCompositing?: string; gpuVendor?: GpuVendor; softwareRendering?: boolean } {
  const compositing = featureStatus?.gpu_compositing;
  const devices = (info as { gpuDevice?: Array<{ vendorId?: unknown; active?: unknown }> } | null)?.gpuDevice;
  const active = Array.isArray(devices) ? devices.find((d) => d?.active === true) ?? devices[0] : undefined;
  const gpuVendor = active ? mapGpuVendor(active.vendorId) : undefined;
  const softwareComposite = typeof compositing === "string" ? /software|disabled|unavailable/.test(compositing) : undefined;
  const basicRender = gpuVendor === "microsoft";
  return {
    gpuCompositing: typeof compositing === "string" ? compositing : undefined,
    gpuVendor,
    softwareRendering: softwareComposite === undefined && gpuVendor === undefined ? undefined : Boolean(softwareComposite) || basicRender,
  };
}

/** Drive letter of the userData path, validated; the path itself goes nowhere. */
export function driveLetterOf(dir: string): string {
  const m = /^([A-Za-z]):/.exec(dir);
  return m ? m[1].toUpperCase() : "C";
}

// ---- readers ----------------------------------------------------------------

function run(deps: CollectorDeps, file: string, args: string[], timeout: number, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    deps.execFile(file, args, { timeout, windowsHide: true, maxBuffer: 65_536, encoding: "utf8", env }, (err, out) =>
      err ? reject(err) : resolve(String(out)),
    );
  });
}

async function safe<T>(fn: () => Promise<T> | T, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

export async function collectHardwareProfile(deps: CollectorDeps): Promise<CollectedProfile> {
  const platform: CollectedProfile["platform"] =
    deps.platform === "darwin" || deps.platform === "win32" || deps.platform === "linux" ? deps.platform : "other";
  const out: CollectedProfile = { platform };

  const cpu = await safe(() => deps.cpus(), [] as Array<{ model: string }>);
  if (cpu.length > 0) {
    out.cpuCores = cpu.length;
    out.cpuModel = typeof cpu[0]?.model === "string" ? cpu[0].model : undefined;
  }
  out.ramBytes = await safe(() => deps.totalmem(), undefined as number | undefined);

  const gpu = await safe(async () => {
    if (!deps.app) return {};
    const status = deps.app.getGPUFeatureStatus() as Record<string, string>;
    const info = await deps.app.getGPUInfo("basic");
    return parseGpu(status, info);
  }, {} as ReturnType<typeof parseGpu>);
  Object.assign(out, gpu);

  if (platform === "darwin") {
    Object.assign(
      out,
      await safe(async () => parseMacSystemVersion(await deps.readFile("/System/Library/CoreServices/SystemVersion.plist", "utf8")), {}),
    );
    Object.assign(
      out,
      await safe(
        async () => parseDiskutilPlist(await run(deps, "/usr/sbin/diskutil", ["info", "-plist", "/"], DISKUTIL_TIMEOUT_MS)),
        { diskType: "unknown" as DiskType, diskBus: "unknown" as DiskBus },
      ),
    );
    out.av = "notApplicable";
  } else if (platform === "win32") {
    out.osVersion = await safe(() => deps.release(), undefined as string | undefined);
    const probe = await safe(
      async () =>
        parseWindowsProbe(
          await run(
            deps,
            powershellPath(),
            ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROBE_SCRIPT],
            WINDOWS_PROBE_TIMEOUT_MS,
            { ...process.env, KEEPR_PROBE_DRIVE: driveLetterOf(deps.userDataDir) },
          ),
        ),
      { av: "unknown", diskType: "unknown", diskBus: "unknown" } as WindowsProbeFields,
    );
    Object.assign(out, probe);
  }
  return out;
}

/** Production dependencies. `app` is passed in so this module never imports electron. */
export function defaultCollectorDeps(app: GpuApp | null, userDataDir: string): CollectorDeps {
  return {
    platform: process.platform,
    execFile: nodeExecFile as unknown as ExecFileFn,
    readFile: (p, enc) => fsp.readFile(p, enc),
    cpus: () => os.cpus(),
    totalmem: () => os.totalmem(),
    release: () => os.release(),
    app,
    userDataDir,
  };
}
