/**
 * BACKLOG-2914 — THE SECOND SINK. The outcome row, into Postgres.
 *
 * Sentry answers "did this release break something". It cannot answer the duration
 * question: no SQL, no joins, and 30-90 day retention would expire the corpus long
 * before there is enough of it to fit a model against. This writes the SAME row to
 * the founder's own Supabase, which is where BACKLOG-2894's per-phase duration model
 * gets fitted months from now, and which is a better home for the data than a third
 * party.
 *
 * The model is later work. The CORPUS has to start now: a run that is not recorded
 * is gone, and by the time 50 users have synced it is too late to collect it.
 *
 * THE WRITE MUST NEVER AFFECT THE SYNC. This is not a preference. It runs at the end
 * of an operation that can take the user an hour, and no telemetry is worth failing
 * that. So:
 *   - `recordSyncOutcome` is SYNCHRONOUS and returns void. The caller cannot await it
 *     even by accident, so nothing on the sync's critical path can stall on a socket.
 *   - the async work is fired and forgotten with a detached `.catch`, exactly as
 *     `lifecycleEventService` does, so a rejection never surfaces as an
 *     unhandledRejection in the main process.
 *   - every failure mode (offline, signed out, no client, RLS refusal, table absent)
 *     is logged at warn and swallowed.
 *
 * OFFLINE: THE ROW IS DROPPED, and that is a deliberate v1 choice, not an oversight.
 * Syncs happen in offices with bad Wi-Fi, so this is a normal case rather than an
 * edge case. Queuing would need a durable local store, a flush trigger, and
 * de-duplication -- a meaningfully larger change with its own failure surface. What
 * makes dropping acceptable is that the run is NOT actually lost: `@sentry/electron`
 * defaults to `makeElectronOfflineTransport` with `flushAtStartup: true`
 * (main/sdk.js), and `Sentry.init` in electron/main.ts does not override the
 * transport, so the Sentry event for that same sync is persisted to disk and sent on
 * a later launch. The asymmetry is real and worth stating: an offline run reaches
 * Sentry late and never reaches the corpus. A drop is logged with its own line so
 * "the corpus is thinner than Sentry" is diagnosable rather than mysterious.
 *
 * PII: the column list in the migration IS the allow-list, and `buildSyncOutcomeRow`
 * picks those names and nothing else. A future producer putting a `udid` on the
 * timeline context cannot reach this table, because no code path copies unknown keys.
 */

import { app } from "electron";
import log from "electron-log";
import supabaseService from "./supabaseService";
import type { SyncOutcomeRow } from "./syncTimeline";
import type { TimelineMeta } from "./syncTimeline";

const LOG_TAG = "[SyncOutcome]";

/** The destination table. Created by 20260828143000_backlog_2914_sync_outcomes.sql. */
export const SYNC_OUTCOMES_TABLE = "sync_outcomes";

/** Read a field only if it really is the type the column expects. */
function num(fields: TimelineMeta, key: string): number | undefined {
  const v = fields[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function str(fields: TimelineMeta, key: string): string | undefined {
  const v = fields[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function bool(fields: TimelineMeta, key: string): boolean | undefined {
  const v = fields[key];
  return typeof v === "boolean" ? v : undefined;
}

/** Drop keys whose value was never established, so absent stays absent in Postgres. */
function defined(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Map the outcome row onto the table's columns.
 *
 * EXPLICIT, KEY BY KEY, AND NEVER A SPREAD. This function is the PII boundary: the
 * row's `fields` is an open map that BACKLOG-2952's sources will add to, and
 * `{ ...row.fields }` here would carry whatever a future producer put on it into
 * durable storage. Everything below is named, and a name that is not below does not
 * travel.
 */
export function buildSyncOutcomeRow(
  row: SyncOutcomeRow,
  userId: string,
  env: { appVersion?: string; platform?: string; isPackaged?: boolean } = {},
): Record<string, unknown> {
  const f = row.fields;
  return defined({
    user_id: userId,

    source: row.source,
    outcome: row.outcome,
    elapsed_ms: row.elapsedMs,
    phases: row.phases.map((p) => ({ phase: p.phase, elapsed_ms: p.elapsedMs })),

    prior_backup: str(f, "priorBackup"),
    backup_mode_source: str(f, "backupModeSource"),
    incremental: bool(f, "incremental"),
    was_encrypted: bool(f, "wasEncrypted"),

    // MODEL identifier only. Never `name`, never `udid`, never `serialNumber`.
    device_model: str(f, "deviceModel"),
    device_ios_version: str(f, "deviceIosVersion"),
    device_used_bytes: num(f, "deviceUsedBytes"),
    device_free_bytes: num(f, "deviceFreeBytes"),
    device_capacity_bytes: num(f, "deviceCapacityBytes"),

    host_os_release: str(f, "hostOsRelease"),
    host_total_mem_bytes: num(f, "hostTotalMemBytes"),
    host_disk_free_bytes: num(f, "hostDiskFreeBytes"),
    host_disk_total_bytes: num(f, "hostDiskTotalBytes"),

    backup_bytes: num(f, "backupBytes"),
    backup_bytes_unmeasured: bool(f, "backupBytesUnmeasured"),
    messages_extracted: num(f, "messagesExtracted"),
    conversations_extracted: num(f, "conversationsExtracted"),
    contacts_extracted: num(f, "contactsExtracted"),
    extraction_ms: num(f, "extractionMs"),

    app_version: env.appVersion,
    platform: env.platform ?? (str(f, "platform") as string | undefined),
    is_packaged: env.isPackaged,
  });
}

/** `app` is unavailable in some test contexts; never let reading it break a sync. */
function readEnv(): { appVersion?: string; platform?: string; isPackaged?: boolean } {
  try {
    return {
      appVersion: app?.getVersion?.(),
      platform: process.platform,
      isPackaged: app?.isPackaged,
    };
  } catch {
    return { platform: process.platform };
  }
}

/**
 * The actual insert. May reject; `recordSyncOutcome` catches everything.
 */
async function writeSyncOutcome(row: SyncOutcomeRow): Promise<void> {
  const client = supabaseService.getClient();

  // RLS ("Users can insert own sync outcomes") requires user_id = auth.uid().
  const { data: sessionData } = await client.auth.getSession();
  const userId = sessionData?.session?.user?.id ?? null;
  if (!userId) {
    // Signed out. Nothing to attribute the run to, and RLS would refuse it anyway.
    // The Sentry event for this same sync still went out.
    log.warn(`${LOG_TAG} No authenticated session; sync outcome not recorded to corpus`);
    return;
  }

  const payload = buildSyncOutcomeRow(row, userId, readEnv());
  const { error } = await client.from(SYNC_OUTCOMES_TABLE).insert(payload);
  if (error) throw new Error(error.message);
}

/**
 * Best-effort, fire-and-forget record of one sync outcome. NEVER throws, never
 * awaits, never delays or fails the sync.
 */
export function recordSyncOutcome(row: SyncOutcomeRow): void {
  // ONE handler, not two, and the reason is worth stating because the first draft had
  // two. `writeSyncOutcome` is an ASYNC function, so a throw anywhere inside it —
  // including `supabaseService.getClient()` on a machine with no client configured —
  // becomes a REJECTED PROMISE, never a synchronous throw. A `try/catch` wrapped
  // around this call is therefore unreachable code that reads like a safety net.
  // Proven, not assumed: with the try/catch deleted, all 17 tests in this suite still
  // passed, including "does not throw when the Supabase client is unavailable". The
  // detached catch below is what actually carries the load — deleting THAT reds three
  // tests.
  const write = writeSyncOutcome(row);
  void write.catch((error: unknown) => {
    log.warn(
      `${LOG_TAG} Outcome row dropped (offline, signed out, or write failed); sync unaffected:`,
      error instanceof Error ? error.message : String(error),
    );
  });
}

export default { recordSyncOutcome, buildSyncOutcomeRow, SYNC_OUTCOMES_TABLE };
