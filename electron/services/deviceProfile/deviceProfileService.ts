/**
 * BACKLOG-4185: writes the device's hardware profile to its own devices row,
 * on sign-in and then only when it changes.
 *
 * Flow (onDeviceRegistered, called by registerDevice on success):
 *   1. Once per process per user: the guard is set SYNCHRONOUSLY, before any
 *      await, so concurrent auth:get-current-user callers collapse to one run.
 *      "login" always runs (and marks the user, so the restores after it are
 *      no-ops).
 *   2. Gate = "Share diagnostics" AND "Send crash reports". OFF -> no
 *      collection; if a profile was written before (the state file exists), its
 *      row is cleared with a null UPDATE and the file is deleted only after that
 *      succeeds (the file IS the pending-clear flag).
 *   3. Wait for the worker pool (up to 60 s), collect hardware, then wait for
 *      quiet (120 s after pool ready, pool idle, up to 10 checks 10 s apart) and
 *      read the data-size counts ON THE WORKER. Never on main.
 *   4. Write when shouldWrite() says so; the state file is replaced only after
 *      the UPDATE succeeds.
 *
 * Never imports deviceService and never calls getDeviceId / machineIdSync: the
 * machine id arrives as an argument from the registration that triggered us.
 * The state file stores only its sha256 (deviceKey).
 */
import crypto from "crypto";
import { promises as fsp } from "fs";
import path from "path";
import { buildDeviceProfile, type CollectedProfile, type CountsState, type DeviceProfileRow, type MachineClass } from "./buildDeviceProfile";
import { DEVICE_PROFILE_STATE_FILE, setDeviceRowId } from "./deviceRowId";

export type RegistrationReason = "login" | "restore";

export const POOL_WAIT_MS = 60_000;
export const POOL_POLL_MS = 2_000;
export const QUIET_MS = 120_000;
export const COUNTS_CHECK_MS = 10_000;
export const COUNTS_MAX_CHECKS = 10;
export const CHANGE_THRESHOLD = 0.2;

export interface DataSizeCounts {
  contacts?: number;
  addressBook?: number;
  mailAccounts?: number;
}

export interface StateFile {
  v: 1;
  deviceKey: string;
  rowId: string | null;
  fp: Fingerprint;
  writtenAt: string;
}

export interface Fingerprint {
  osBuild?: string;
  ramGB?: number;
  contacts?: number;
  addressBook?: number;
  dbMB?: number;
}

export interface UpdateResult {
  ok: boolean;
  rows: number;
}

type Timer = { unref?: () => void };

export interface ServiceDeps {
  isGateOn: () => boolean;
  isPoolReady: () => boolean;
  getPoolQueryCount: () => number;
  queryCounts: (userId: string) => Promise<DataSizeCounts | null>;
  dbBytes: () => Promise<number | undefined>;
  collectHardware: () => Promise<CollectedProfile>;
  updateRow: (userId: string, deviceId: string, profile: DeviceProfileRow | null) => Promise<UpdateResult>;
  readState: () => Promise<StateFile | null>;
  writeState: (state: StateFile) => Promise<void>;
  removeState: () => Promise<void>;
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => Timer;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
}

// ---- pure -------------------------------------------------------------------

export function deviceKeyOf(userId: string, deviceId: string): string {
  return crypto.createHash("sha256").update(`${userId}:${deviceId}`).digest("hex");
}

export function fingerprintOf(row: DeviceProfileRow): Fingerprint {
  const fp: Fingerprint = {};
  if (typeof row.osBuild === "string") fp.osBuild = row.osBuild;
  for (const k of ["ramGB", "contacts", "addressBook", "dbMB"] as const) {
    const v = row[k];
    if (typeof v === "number") fp[k] = v;
  }
  return fp;
}

function movedMoreThan(prev: number | undefined, next: number | undefined): boolean {
  if (prev === undefined || next === undefined) return false; // an absent count is not compared
  if (prev === 0) return next !== 0;
  return Math.abs(next - prev) / prev > CHANGE_THRESHOLD;
}

export function shouldWrite(prev: StateFile | null, next: { deviceKey: string; fp: Fingerprint }, reason: RegistrationReason): boolean {
  if (reason === "login" || prev === null) return true;
  if (prev.deviceKey !== next.deviceKey) return true;
  if (prev.fp.osBuild !== next.fp.osBuild) return true;
  if (prev.fp.ramGB !== next.fp.ramGB) return true;
  return (["contacts", "addressBook", "dbMB"] as const).some((k) => movedMoreThan(prev.fp[k], next.fp[k]));
}

/** C1: counts may be read only when the pool is up, idle, and quiet for QUIET_MS. */
export function countsGate(now: number, poolReadyAt: number, ready: boolean, inflight: number): boolean {
  return ready && inflight === 0 && now - poolReadyAt >= QUIET_MS;
}

// ---- stateful ---------------------------------------------------------------

export interface DeviceProfileService {
  onDeviceRegistered(userId: string, deviceId: string, reason: RegistrationReason, rowId: unknown): Promise<void>;
  onPrivacyGateChanged(): Promise<void>;
  getMachineClass(): MachineClass | null;
  getCountsState(): CountsState | null;
}

export function createDeviceProfileService(deps: ServiceDeps): DeviceProfileService {
  const done = new Set<string>();
  let lastRegistration: { userId: string; deviceId: string } | null = null;
  let machineClass: MachineClass | null = null;
  let countsState: CountsState | null = null;
  let clearing: Promise<void> | null = null;

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const t = deps.setTimeout(resolve, ms);
      t.unref?.();
    });

  async function waitForPool(): Promise<boolean> {
    const start = deps.now();
    while (!deps.isPoolReady()) {
      if (deps.now() - start >= POOL_WAIT_MS) return false;
      await sleep(POOL_POLL_MS);
    }
    return true;
  }

  /** C2: bounded. Exactly COUNTS_MAX_CHECKS checks after quiet, then give up. */
  async function readCountsWhenQuiet(userId: string, poolReadyAt: number): Promise<{ counts: DataSizeCounts | null; state: CountsState }> {
    const untilQuiet = poolReadyAt + QUIET_MS - deps.now();
    if (untilQuiet > 0) await sleep(untilQuiet);
    let lastReady = false;
    for (let check = 0; check < COUNTS_MAX_CHECKS; check++) {
      if (check > 0) await sleep(COUNTS_CHECK_MS);
      lastReady = deps.isPoolReady();
      if (countsGate(deps.now(), poolReadyAt, lastReady, deps.getPoolQueryCount())) {
        try {
          const counts = await deps.queryCounts(userId);
          return counts ? { counts, state: "ok" } : { counts: null, state: "poolDown" };
        } catch {
          return { counts: null, state: "poolDown" };
        }
      }
    }
    return { counts: null, state: lastReady ? "skippedBusy" : "poolDown" };
  }

  async function clearIfPending(userId: string, deviceId: string): Promise<void> {
    if (clearing) return clearing;
    clearing = (async () => {
      try {
        const state = await deps.readState();
        if (!state) return;
        const res = await deps.updateRow(userId, deviceId, null);
        if (!res.ok) return; // file kept: the next registration retries
        await deps.removeState();
      } catch (err) {
        deps.warn("[DeviceProfile] Clear failed; will retry", { error: err instanceof Error ? err.message : String(err) });
      } finally {
        clearing = null;
      }
    })();
    return clearing;
  }

  async function collectAndWrite(userId: string, deviceId: string, reason: RegistrationReason, rowId: string | null): Promise<void> {
    const poolOk = await waitForPool();
    const poolReadyAt = deps.now();
    const hw = await deps.collectHardware();
    hw.poolReady = poolOk;
    machineClass = buildDeviceProfile(hw, "log");

    const { counts, state } = poolOk ? await readCountsWhenQuiet(userId, poolReadyAt) : { counts: null, state: "poolDown" as const };
    countsState = state;
    hw.countsState = state;
    if (counts) Object.assign(hw, counts);
    hw.dbBytes = await deps.dbBytes().catch(() => undefined);

    const row = buildDeviceProfile(hw, "row");
    const next = { deviceKey: deviceKeyOf(userId, deviceId), fp: fingerprintOf(row) };
    const prev = await deps.readState().catch(() => null);
    if (!shouldWrite(prev, next, reason)) return;
    if (!deps.isGateOn()) return; // turned off while we waited
    const res = await deps.updateRow(userId, deviceId, row);
    if (!res.ok || res.rows < 1) return; // state untouched: the next launch retries
    if (!deps.isGateOn()) return;
    await deps.writeState({ v: 1, deviceKey: next.deviceKey, rowId, fp: next.fp, writtenAt: new Date(deps.now()).toISOString() });
  }

  return {
    async onDeviceRegistered(userId, deviceId, reason, rawRowId) {
      // Synchronous part: nothing below may move above an await.
      if (reason === "restore" && done.has(userId)) return;
      done.add(userId);
      lastRegistration = { userId, deviceId };
      setDeviceRowId(rawRowId);
      const rowId = typeof rawRowId === "string" ? rawRowId : null;
      try {
        if (!deps.isGateOn()) {
          await clearIfPending(userId, deviceId);
          return;
        }
        await collectAndWrite(userId, deviceId, reason, rowId);
      } catch (err) {
        deps.warn("[DeviceProfile] Profile update failed", { error: err instanceof Error ? err.message : String(err) });
      }
    },

    /** C5: called after either privacy switch changes. OFF -> clear now, not at the next launch. */
    async onPrivacyGateChanged() {
      if (deps.isGateOn()) return;
      done.clear(); // ON again later writes once at the next registration
      if (!lastRegistration) return;
      await clearIfPending(lastRegistration.userId, lastRegistration.deviceId);
    },

    getMachineClass: () => machineClass,
    getCountsState: () => countsState,
  };
}

// ---- production wiring ---------------------------------------------------------

let instance: DeviceProfileService | null = null;

/** Lazily built so importing this module (from deviceService) loads nothing heavy. */
function productionService(): DeviceProfileService {
  if (instance) return instance;
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { app } = require("electron") as typeof import("electron");
  const pool = require("../../workers/contactWorkerPool") as typeof import("../../workers/contactWorkerPool");
  const supabaseService = (require("../supabaseService") as typeof import("../supabaseService")).default;
  const logService = (require("../logService") as typeof import("../logService")).default;
  const { isDiagnosticsSharingEnabled } = require("../diagnosticsSharingPreference") as typeof import("../diagnosticsSharingPreference");
  const { isCrashReportingEnabled } = require("../crashReportingPreference") as typeof import("../crashReportingPreference");
  const collector = require("../diagnostics/deviceProfileCollector") as typeof import("../diagnostics/deviceProfileCollector");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const userData = app.getPath("userData");
  const statePath = path.join(userData, DEVICE_PROFILE_STATE_FILE);

  instance = createDeviceProfileService({
    isGateOn: () => isDiagnosticsSharingEnabled() && isCrashReportingEnabled(),
    isPoolReady: pool.isPoolReady,
    getPoolQueryCount: pool.getPoolQueryCount,
    queryCounts: async (userId) => {
      const rows = await pool.queryContacts("deviceDataSize", userId, 30_000);
      const r = rows[0] as DataSizeCounts | undefined;
      return r ?? null;
    },
    dbBytes: async () => {
      let total = 0;
      for (const name of ["mad.db", "mad.db-wal"]) {
        try {
          total += (await fsp.stat(path.join(userData, name))).size;
        } catch {
          // -wal absent after a checkpoint
        }
      }
      return total > 0 ? total : undefined;
    },
    collectHardware: () => collector.collectHardwareProfile(collector.defaultCollectorDeps(app, userData)),
    updateRow: async (userId, deviceId, profile) => {
      const { data, error } = await supabaseService
        .getClient()
        .from("devices")
        .update({ hardware_profile: profile, profile_updated_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("device_id", deviceId)
        .select("id");
      if (error) {
        void logService.warn("[DeviceProfile] devices update failed", "DeviceProfile", { code: error.code });
        return { ok: false, rows: 0 };
      }
      return { ok: true, rows: Array.isArray(data) ? data.length : 0 };
    },
    readState: async () => {
      try {
        const parsed = JSON.parse(await fsp.readFile(statePath, "utf8")) as StateFile;
        return parsed && parsed.v === 1 && typeof parsed.deviceKey === "string" ? parsed : null;
      } catch {
        return null;
      }
    },
    writeState: async (state) => {
      const tmp = `${statePath}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
      await fsp.rename(tmp, statePath);
    },
    removeState: async () => {
      await fsp.rm(statePath, { force: true });
    },
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    warn: (msg, meta) => {
      void logService.warn(msg, "DeviceProfile", meta);
    },
  });
  return instance;
}

/** registerDevice's hook. Fire-and-forget; never throws into registration. */
export function onDeviceRegistered(userId: string, deviceId: string, reason: RegistrationReason, rowId: unknown): void {
  try {
    void productionService().onDeviceRegistered(userId, deviceId, reason, rowId);
  } catch {
    // wiring failed (tests, early shutdown): registration is unaffected
  }
}

/** The privacy switches' hook (ccpaHandlers). */
export function onPrivacyGateChanged(): void {
  try {
    void productionService().onPrivacyGateChanged();
  } catch {
    // never affects saving the setting
  }
}

/** PR C reads these for the machine-class log keys and the env.health marker. */
export function getMachineClass(): MachineClass | null {
  return instance?.getMachineClass() ?? null;
}

export function getCountsState(): CountsState | null {
  return instance?.getCountsState() ?? null;
}

export function __resetDeviceProfileServiceForTests(): void {
  instance = null;
}
