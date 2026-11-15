/**
 * BACKLOG-4185: one builder for every place the device profile goes.
 *
 * Three targets, each an EXACT key list:
 *   - "row": the devices row's `hardware_profile` jsonb (Supabase, which already
 *     holds the account). Full profile, counts to 2 significant figures.
 *     No message count: COUNT(messages) failed the PR B measurement gate,
 *     so data size is dbMB plus the smaller tables' counts.
 *   - "log": the machine class every diagnostics log may carry (PR C wires it):
 *     ramGB (bucketed), cpuCores, diskType, softwareRendering. Nothing else.
 *   - "health": the env.health log (BACKLOG-4181 PR 3): pool state, counts
 *     state and size BUCKETS, taken from the exact in-process values (never
 *     from the row's 2-significant-figure output).
 *
 * Sentry error / crash EVENTS carry no profile at all: only the devices row id
 * (deviceRowId.ts). There is deliberately no "event" target.
 *
 * Every string is checked against a strict per-field format; a value that fails
 * is sent as absent. The builder picks keys one by one and never spreads its
 * input, so a field added to the collected shape cannot ride along.
 */

import {
  COUNT_BUCKETS,
  DB_MB_BUCKETS,
  MAX_CPU_CORES,
  MAX_MAIL_ACCOUNTS,
  RAM_BUCKETS_GB,
  lowerBucket,
  type DiagFieldKey,
} from "../diagnostics/fields";

export type DiskType = "ssd" | "hdd" | "unknown";
export type DiskBus = "nvme" | "sata" | "usb" | "raid" | "other" | "unknown";
export type GpuVendor = "intel" | "nvidia" | "amd" | "apple" | "microsoft" | "other";
export type CountsState = "ok" | "skippedBusy" | "poolDown";
export type AvProduct =
  | "defender"
  | "norton"
  | "mcafee"
  | "bitdefender"
  | "kaspersky"
  | "avast"
  | "avg"
  | "eset"
  | "sophos"
  | "trendmicro"
  | "malwarebytes"
  | "webroot"
  | "crowdstrike"
  | "sentinelone"
  | "other";

/** What the collector and the service produce. Exact counts / bytes stay in-process. */
export interface CollectedProfile {
  platform: "darwin" | "win32" | "linux" | "other";
  cpuModel?: string;
  cpuCores?: number;
  ramBytes?: number;
  diskType?: DiskType;
  diskBus?: DiskBus;
  osVersion?: string;
  osBuild?: string;
  osDisplayVersion?: string;
  gpuCompositing?: string;
  gpuVendor?: GpuVendor;
  softwareRendering?: boolean;
  /** "notApplicable" on macOS, "unavailable" when Security Center cannot be read. */
  av?: AvProduct[] | "notApplicable" | "unavailable" | "unknown";
  avEnabled?: boolean;
  avDefsCurrent?: boolean;
  poolReady?: boolean;
  contacts?: number;
  addressBook?: number;
  mailAccounts?: number;
  dbBytes?: number;
  countsState?: CountsState;
}

export const PROFILE_VERSION = 1;

export const ROW_KEYS = [
  "v",
  "cpuModel",
  "cpuCores",
  "ramGB",
  "diskType",
  "diskBus",
  "osVersion",
  "osBuild",
  "osDisplayVersion",
  "gpuCompositing",
  "gpuVendor",
  "softwareRendering",
  "av",
  "avEnabled",
  "avDefsCurrent",
  "poolReady",
  "contacts",
  "addressBook",
  "dbMB",
  "mailAccounts",
  "countsState",
] as const;

export const LOG_KEYS = ["ramGB", "cpuCores", "diskType", "softwareRendering"] as const;
/** Typed against the env.health route: a key the allowlist lacks does not compile. */
export const HEALTH_KEYS = [
  "poolState",
  "countsState",
  "contactsBucket",
  "addressBookBucket",
  "dbSizeBucketMB",
  "mailAccounts",
] as const satisfies readonly DiagFieldKey<"env.health">[];
export type HealthFields = Partial<Record<(typeof HEALTH_KEYS)[number], string | number>>;

export type DeviceProfileRow = Partial<Record<(typeof ROW_KEYS)[number], unknown>>;
export type MachineClass = Partial<Record<(typeof LOG_KEYS)[number], unknown>>;

// ---- strict formats -------------------------------------------------------

export const FORMATS = {
  macVersion: /^1[1-9]\.\d{1,2}(\.\d{1,2})?$|^2\d\.\d{1,2}(\.\d{1,2})?$/,
  macBuild: /^\d{2}[A-Z]\d{1,4}[a-z]?$/,
  winRelease: /^10\.0\.\d{5}$/,
  winUbr: /^\d{1,5}$/,
  winDisplayVersion: /^\d{2}H[12]$/,
  cpuModel: /^[A-Za-z0-9 ()@._-]{1,64}$/,
  gpuCompositing: /^[a-z_]{1,40}$/,
} as const;

const DISK_TYPES: readonly DiskType[] = ["ssd", "hdd", "unknown"];
const DISK_BUSES: readonly DiskBus[] = ["nvme", "sata", "usb", "raid", "other", "unknown"];
const GPU_VENDORS: readonly GpuVendor[] = ["intel", "nvidia", "amd", "apple", "microsoft", "other"];
const COUNTS_STATES: readonly CountsState[] = ["ok", "skippedBusy", "poolDown"];
export const AV_PRODUCTS: readonly AvProduct[] = [
  "defender",
  "norton",
  "mcafee",
  "bitdefender",
  "kaspersky",
  "avast",
  "avg",
  "eset",
  "sophos",
  "trendmicro",
  "malwarebytes",
  "webroot",
  "crowdstrike",
  "sentinelone",
  "other",
];
const AV_MARKERS = ["notApplicable", "unavailable", "unknown"] as const;


function strOk(v: unknown, re: RegExp): v is string {
  return typeof v === "string" && re.test(v);
}

function intOk(v: unknown, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;
}

function oneOf<T extends string>(v: unknown, list: readonly T[]): v is T {
  return typeof v === "string" && (list as readonly string[]).includes(v);
}

/** 184231 -> 180000. Exact values never leave the process. */
export function twoSigFigs(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const digits = Math.floor(Math.log10(n)) + 1;
  if (digits <= 2) return Math.round(n);
  const scale = 10 ** (digits - 2);
  return Math.round(n / scale) * scale;
}

export function ramGBOf(bytes: unknown): number | undefined {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return undefined;
  return Math.max(1, Math.round(bytes / 1024 ** 3));
}

export function ramBucketGB(gb: number): number {
  let out: number = RAM_BUCKETS_GB[0];
  for (const b of RAM_BUCKETS_GB) if (gb >= b * 0.9) out = b;
  return out;
}

function osFields(c: CollectedProfile): { osVersion?: string; osBuild?: string; osDisplayVersion?: string } {
  if (c.platform === "darwin") {
    return {
      osVersion: strOk(c.osVersion, FORMATS.macVersion) ? c.osVersion : undefined,
      osBuild: strOk(c.osBuild, FORMATS.macBuild) ? c.osBuild : undefined,
    };
  }
  if (c.platform === "win32") {
    return {
      osVersion: strOk(c.osVersion, FORMATS.winRelease) ? c.osVersion : undefined,
      osBuild: strOk(c.osBuild, FORMATS.winUbr) ? c.osBuild : undefined,
      osDisplayVersion: strOk(c.osDisplayVersion, FORMATS.winDisplayVersion) ? c.osDisplayVersion : undefined,
    };
  }
  return {};
}

function avField(v: CollectedProfile["av"]): AvProduct[] | (typeof AV_MARKERS)[number] | undefined {
  if (Array.isArray(v)) {
    return [...new Set(v.filter((p) => oneOf(p, AV_PRODUCTS)))].sort();
  }
  return oneOf(v, AV_MARKERS) ? v : undefined;
}

function count(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? twoSigFigs(v) : undefined;
}

function prune<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

type BuiltFor<T extends "row" | "log" | "health"> = T extends "row" ? DeviceProfileRow : T extends "health" ? HealthFields : MachineClass;

// One declaration, no overloads: the write-atomicity guard keys units by name.
export function buildDeviceProfile<T extends "row" | "log" | "health">(c: CollectedProfile, target: T): BuiltFor<T> {
  return (target === "log" ? buildMachineClass(c) : target === "health" ? buildHealth(c) : buildRow(c)) as BuiltFor<T>;
}

/** env.health: buckets from the EXACT in-process values (never from the row's 2-sig-fig output). */
function buildHealth(c: CollectedProfile): HealthFields {
  return prune({
    poolState: c.poolReady === true ? "ready" : c.poolReady === false ? "down" : undefined,
    countsState: oneOf(c.countsState, COUNTS_STATES) ? c.countsState : undefined,
    contactsBucket: typeof c.contacts === "number" ? lowerBucket(c.contacts, COUNT_BUCKETS) : undefined,
    addressBookBucket: typeof c.addressBook === "number" ? lowerBucket(c.addressBook, COUNT_BUCKETS) : undefined,
    dbSizeBucketMB: typeof c.dbBytes === "number" ? lowerBucket(c.dbBytes / 1024 ** 2, DB_MB_BUCKETS) : undefined,
    mailAccounts: intOk(c.mailAccounts, 1000) ? Math.min(c.mailAccounts, MAX_MAIL_ACCOUNTS) : undefined,
  }) as HealthFields;
}

function buildMachineClass(c: CollectedProfile): MachineClass {
  const ramGB = ramGBOf(c.ramBytes);
  const cpuCores = intOk(c.cpuCores, MAX_CPU_CORES) && c.cpuCores > 0 ? c.cpuCores : undefined;
  const diskType = oneOf(c.diskType, DISK_TYPES) ? c.diskType : undefined;
  const softwareRendering = typeof c.softwareRendering === "boolean" ? c.softwareRendering : undefined;

  return prune({
    ramGB: ramGB === undefined ? undefined : ramBucketGB(ramGB),
    cpuCores,
    diskType,
    softwareRendering,
  });
}

function buildRow(c: CollectedProfile): DeviceProfileRow {
  const ramGB = ramGBOf(c.ramBytes);
  const cpuCores = intOk(c.cpuCores, MAX_CPU_CORES) && c.cpuCores > 0 ? c.cpuCores : undefined;
  const diskType = oneOf(c.diskType, DISK_TYPES) ? c.diskType : undefined;
  const softwareRendering = typeof c.softwareRendering === "boolean" ? c.softwareRendering : undefined;
  const cpuModel = typeof c.cpuModel === "string" ? c.cpuModel.replace(/\s+/g, " ").trim() : undefined;
  const os = osFields(c);
  const dbMB = typeof c.dbBytes === "number" && c.dbBytes >= 0 ? twoSigFigs(c.dbBytes / 1024 ** 2) : undefined;
  return prune({
    v: PROFILE_VERSION,
    cpuModel: strOk(cpuModel, FORMATS.cpuModel) ? cpuModel : undefined,
    cpuCores,
    ramGB,
    diskType,
    diskBus: oneOf(c.diskBus, DISK_BUSES) ? c.diskBus : undefined,
    osVersion: os.osVersion,
    osBuild: os.osBuild,
    osDisplayVersion: os.osDisplayVersion,
    gpuCompositing: strOk(c.gpuCompositing, FORMATS.gpuCompositing) ? c.gpuCompositing : undefined,
    gpuVendor: oneOf(c.gpuVendor, GPU_VENDORS) ? c.gpuVendor : undefined,
    softwareRendering,
    av: avField(c.av),
    avEnabled: typeof c.avEnabled === "boolean" ? c.avEnabled : undefined,
    avDefsCurrent: typeof c.avDefsCurrent === "boolean" ? c.avDefsCurrent : undefined,
    poolReady: typeof c.poolReady === "boolean" ? c.poolReady : undefined,
    contacts: count(c.contacts),
    addressBook: count(c.addressBook),
    dbMB,
    mailAccounts: intOk(c.mailAccounts, 1000) ? Math.min(c.mailAccounts, MAX_MAIL_ACCOUNTS) : undefined,
    countsState: oneOf(c.countsState, COUNTS_STATES) ? c.countsState : undefined,
  });
}
