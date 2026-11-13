/**
 * BACKLOG-4181: the ONLY fields a diagnostics log may carry to Sentry Logs.
 *
 * PRIVACY RULE: fixed structured fields only — operation name, durations,
 * counts, app version, OS, random device id. Never free text. Every route's
 * fields are listed in `DIAG_ROUTE_KEYS`; the perf helper (perf.ts) drops
 * anything else at capture, and the transport filter
 * (diagnosticsLogTransport.ts) rebuilds every log from this list at send time.
 *
 * A NEW ROUTE ADDS ITS ENTRY HERE. Route call sites are typed from this
 * constant (`DiagFields<op>`), so a field missing from the entry does not
 * compile at the call site, and the filter would strip it anyway.
 */

/** Channel, phase and endedBy names: no spaces, no `@`, no `/`, at most 120 chars. */
export const DIAG_TOKEN = /^[A-Za-z0-9:_.,-]{1,120}$/;
export const DIAG_TOKEN_MAX_LENGTH = 120;

/** Operation names: `area.name[.sub]`, e.g. `ipc.slow`. */
export const DIAG_OP = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9_-]+)+$/;

/**
 * String-valued route fields and the format each must match. Every other route
 * field must be a finite number or a boolean.
 */
export const DIAG_STRING_FIELDS: Readonly<Record<string, RegExp>> = {
  channel: DIAG_TOKEN,
  sinceLastIpc: DIAG_TOKEN,
  inFlight: DIAG_TOKEN,
  syncPhase: DIAG_TOKEN,
  endedBy: DIAG_TOKEN,
  caller: DIAG_TOKEN,
  poolState: /^(ready|down)$/,
  countsState: /^(ok|skippedBusy|poolDown)$/,
};

/*
 * BACKLOG-4181 PR 3 / BACKLOG-4185: the ONE declaration of every value table
 * the device profile and the diagnostics logs share. buildDeviceProfile.ts
 * imports these; it never declares its own copy.
 */
/** Lower bounds for contact / address-book counts on env.health. */
export const COUNT_BUCKETS = [0, 1, 1_000, 10_000, 50_000, 100_000, 250_000, 500_000, 1_000_000] as const;
/** Lower bounds for the database size (MB) on env.health. */
export const DB_MB_BUCKETS = [0, 10, 100, 500, 1_000, 2_000, 5_000, 10_000, 20_000] as const;
/** Lower bounds for the machine-class RAM (GB). */
export const RAM_BUCKETS_GB = [2, 4, 8, 16, 32, 64, 128] as const;
/** Highest logical core count accepted anywhere (row, machine class, log). */
export const MAX_CPU_CORES = 1024;
/** Connected mail accounts are reported capped at this value. */
export const MAX_MAIL_ACCOUNTS = 10;

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** Numeric fields that may take only these values, at capture AND at send. */
export const DIAG_NUMBER_SETS: Readonly<Record<string, readonly number[]>> = {
  ramGB: RAM_BUCKETS_GB,
  cpuCores: range(1, MAX_CPU_CORES),
  contactsBucket: COUNT_BUCKETS,
  addressBookBucket: COUNT_BUCKETS,
  dbSizeBucketMB: DB_MB_BUCKETS,
  mailAccounts: range(0, MAX_MAIL_ACCOUNTS),
};
/** Fields that must be booleans (a number is not accepted). */
export const DIAG_BOOLEAN_FIELDS: ReadonlySet<string> = new Set(["softwareRendering"]);

/** Largest lower bound <= n. Exact values never leave the caller. */
export function lowerBucket(n: number, bounds: readonly number[]): number | undefined {
  if (!Number.isFinite(n) || n < 0) return undefined;
  let out: number | undefined;
  for (const b of bounds) if (n >= b) out = b;
  return out;
}

/**
 * Machine class (BACKLOG-4185, founder be38b405): optional keys on EVERY
 * diagnostics log once the profile is known. Not required base keys.
 */
export const DIAG_MACHINE_KEYS = ["keepr.ramGB", "keepr.cpuCores", "keepr.diskType", "keepr.softwareRendering"] as const;
export const DIAG_MACHINE_STRING_FORMATS: Readonly<Record<string, RegExp>> = { diskType: /^(ssd|hdd|unknown)$/ };

/** Base attributes every diagnostics log carries, with their formats. */
export const DIAG_BASE_FORMATS = {
  /** `${process.platform}-${os.release()}`, e.g. "darwin-24.6.0". */
  "keepr.os": /^[a-z0-9]+-[A-Za-z0-9._-]{1,40}$/,
  "keepr.appVersion": /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/,
  "keepr.deviceId": /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  /** Set by the SDK from init `release` (app.getVersion()). */
  "sentry.release": /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/,
  /** Set by the SDK from init `environment`. */
  "sentry.environment": /^(production|development)$/,
} as const satisfies Record<string, RegExp>;

/**
 * Every attribute key allowed on every diagnostics log. `keepr.diag` must be
 * true, `keepr.op` a known op, `sentry.timestamp.sequence` an integer the SDK
 * adds at serialization (no content).
 */
export const DIAG_BASE_KEYS = [
  "keepr.diag",
  "keepr.op",
  "keepr.os",
  "keepr.appVersion",
  "keepr.deviceId",
  "sentry.release",
  "sentry.environment",
  "sentry.timestamp.sequence",
] as const;

/** The exact field set per operation (without the `keepr.` prefix). */
export const DIAG_ROUTE_KEYS = {
  "ipc.slow": ["durationMs", "channel", "approxBytes", "threw"],
  "main.lag": [
    "durationMs",
    "sinceLastIpc",
    "lastIpcAgoMs",
    "inFlight",
    "inFlightCount",
    "inFlightTruncated",
    "syncPhase",
    "suppressed",
  ],
  "window.unresponsive": ["durationMs", "endedBy", "syncPhase"],
  "window.unresponsive.start": ["syncPhase"],
  "env.health": ["poolState", "countsState", "contactsBucket", "addressBookBucket", "dbSizeBucketMB", "mailAccounts"],
} as const satisfies Record<string, readonly string[]>;

export type DiagOp = keyof typeof DIAG_ROUTE_KEYS;
export type DiagValue = string | number | boolean;
type RouteKey<Op extends DiagOp> = (typeof DIAG_ROUTE_KEYS)[Op][number];
/** The fields a route may pass (durationMs is the helper's own argument). */
export type DiagFields<Op extends DiagOp> = Partial<Record<Exclude<RouteKey<Op>, "durationMs">, DiagValue | null | undefined>>;
/** A route's field names (durationMs excluded), for exact key lists that must match the route. */
export type DiagFieldKey<Op extends DiagOp> = Exclude<RouteKey<Op>, "durationMs">;

export function isDiagOp(op: unknown): op is DiagOp {
  return typeof op === "string" && Object.prototype.hasOwnProperty.call(DIAG_ROUTE_KEYS, op) && DIAG_OP.test(op);
}

/** The full attribute key set allowed for `op`, or null for an unknown op. */
export function allowedAttributeKeys(op: string): Set<string> | null {
  if (!isDiagOp(op)) return null;
  return new Set<string>([...DIAG_BASE_KEYS, ...DIAG_MACHINE_KEYS, ...DIAG_ROUTE_KEYS[op].map((k) => `keepr.${k}`)]);
}

/**
 * Join names with "," keeping WHOLE names only while the result stays within
 * `max` characters. `truncated` is true when a name was left out. A first name
 * longer than `max` gives `value: null`.
 */
export function joinWholeNames(
  names: readonly string[],
  max: number = DIAG_TOKEN_MAX_LENGTH,
): { value: string | null; truncated: boolean } {
  let value = "";
  let kept = 0;
  for (const name of names) {
    const next = kept === 0 ? name : `${value},${name}`;
    if (next.length > max) break;
    value = next;
    kept += 1;
  }
  return { value: kept > 0 ? value : null, truncated: kept < names.length };
}

/** A non-string field value: number sets, boolean-only fields, else any finite number / boolean. */
export function nonStringFieldAllowed(field: string, value: unknown): boolean {
  if (DIAG_BOOLEAN_FIELDS.has(field)) return typeof value === "boolean";
  const set = DIAG_NUMBER_SETS[field];
  if (set) return typeof value === "number" && set.includes(value);
  return (typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean";
}
