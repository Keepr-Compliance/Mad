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
 * (main/sdk.js), and `Sentry.init` (electron/bootstrap/installSentry.ts) keeps that
 * offline transport, so the Sentry event for that same sync is persisted to disk and
 * sent on a later launch — unless the user has turned crash reports off
 * (BACKLOG-3801), in which case it is dropped, not queued. The asymmetry is real and worth stating: an offline run reaches
 * Sentry late and never reaches the corpus. A drop is logged with its own line so
 * "the corpus is thinner than Sentry" is diagnosable rather than mysterious.
 *
 * PII: the column list in the migration IS the allow-list, and `buildSyncOutcomeRow`
 * picks those names and nothing else. A future producer putting a `udid` on the
 * timeline context cannot reach this table, because no code path copies unknown keys.
 *
 * BACKLOG-3440 — THE ROW IS NOW WRITTEN AT THE START AND KEPT CURRENT.
 *
 * Everything above described ONE write, at the end. That is why a run which was killed,
 * quit, or simply never finished left nothing behind: the record was assembled at the
 * end, so a run with no end had no record. There are now three writes against one
 * client-generated primary key — start, heartbeat, terminal — and the verbs differ for
 * reasons spelled out at `writeSyncRun`.
 *
 * The offline rule above is unchanged and now reads more precisely: an offline run drops
 * whichever of its writes were attempted while the network was down. It is no longer
 * all-or-nothing per run, which is a small improvement — a run that goes offline
 * mid-transfer keeps the start row it already wrote.
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
/** Epoch ms -> the ISO string a `timestamptz` column takes. Absent stays absent. */
function ts(epochMs: number | undefined): string | undefined {
  if (typeof epochMs !== "number" || !Number.isFinite(epochMs) || epochMs <= 0) return undefined;
  return new Date(epochMs).toISOString();
}
/** An integer column will not take 208.5 or "208". Absent stays absent. */
function int(fields: TimelineMeta, key: string): number | undefined {
  const v = fields[key];
  return typeof v === "number" && Number.isInteger(v) ? v : undefined;
}

/**
 * BACKLOG-3460 — EVERY `bigint` COLUMN GOES THROUGH HERE.
 *
 * Postgres does not truncate a fractional literal into a `bigint`; it REJECTS THE
 * WHOLE WRITE with `invalid input syntax for type bigint: "4142962380.8"`. One
 * non-integer byte count therefore killed the heartbeat and the terminal write of
 * every run that reached transfer, leaving it `outcome='running'` forever.
 *
 * IT ROUNDS, and that is the whole difference from `int()` above, which DROPS. A byte
 * count rounded to the nearest byte loses nothing worth having; dropping it would
 * write a row whose byte counter is absent — the exact figure this column exists to
 * carry. `int()` keeps its strict semantics for `device_error_code`, where a
 * fractional value is garbage rather than a rounding artefact and rounding it would
 * invent an error code the device never reported.
 *
 * THE SECOND LAYER, NOT THE FIX. The producer is integerised at `syncTimeline`'s
 * `recordBytesTransferred`, so the stall comparison sees the same integer the corpus
 * stores. This exists because the nine other `bigint` columns each rely on a producer
 * being integer by construction, and a future producer need not be.
 */
function roundToBigint(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined;
}
/** `roundToBigint` over a key of the open `fields` map. */
function bigintNum(fields: TimelineMeta, key: string): number | undefined {
  return roundToBigint(fields[key]);
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
 * BACKLOG-3816: iPhone backup-encryption facts, carried in `source_metrics` (no column,
 * no migration). Allow-listed VALUES only — anything else is dropped — and never a
 * password. Only used when the source supplied no metrics of its own (iPhone rows).
 */
const BACKUP_PASSWORD_SOURCES = new Set(["provided", "stored", "none", "unavailable", "generated"]);
const PHONE_BACKUP_ENCRYPTION = new Set(["on", "off", "unknown"]);
const ENCRYPTION_ENABLE_RESULTS = new Set(["enabled", "not-confirmed", "failed"]);

export function backupEncryptionMetrics(f: TimelineMeta): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  const pick = (key: string, allowed: Set<string>) => {
    const v = str(f, key);
    if (v !== undefined && allowed.has(v)) out[key] = v;
  };
  pick("backupPassword", BACKUP_PASSWORD_SOURCES);
  pick("phoneBackupEncryption", PHONE_BACKUP_ENCRYPTION);
  pick("encryptionEnable", ENCRYPTION_ENABLE_RESULTS);
  return Object.keys(out).length > 0 ? out : undefined;
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
    // BACKLOG-3440: the CLIENT chooses the primary key, so the start write, every
    // heartbeat and the terminal write land on ONE row. Without it the terminal write
    // would have to find the row it is amending, and the only handle it could use is a
    // query the RLS policy does not permit.
    id: row.runId || undefined,
    user_id: userId,

    source: row.source,
    outcome: row.outcome,
    elapsed_ms: roundToBigint(row.elapsedMs),
    phases: row.phases.map((p) => ({ phase: p.phase, elapsed_ms: p.elapsedMs })),

    // BACKLOG-3440: sent on EVERY write, because `created_at` records whichever write
    // landed first and the start write can be dropped offline by design.
    started_at: ts(row.startedAt),
    updated_at: new Date().toISOString(),

    // BACKLOG-3440: the pair that separates "slow" from "stopped dead". `updated_at`
    // advancing while `bytes_last_increased_at` stands still IS the stall; neither
    // advancing is a process or an app that is gone.
    bytes_transferred: bigintNum(f, "bytesTransferred"),
    bytes_last_increased_at: ts(num(f, "bytesLastIncreasedAt")),
    last_phase: str(f, "lastPhase"),

    // BACKLOG-3440: the machine-readable cause the backup path has produced since
    // BACKLOG-2913 and the orchestrator then discarded, forwarding only the sentence it
    // had been rendered into.
    reason_code: str(f, "reasonCode"),
    device_error_code: int(f, "deviceErrorCode"),
    ended_by: str(f, "endedBy"),

    prior_backup: str(f, "priorBackup"),
    backup_mode_source: str(f, "backupModeSource"),
    incremental: bool(f, "incremental"),
    was_encrypted: bool(f, "wasEncrypted"),

    // MODEL identifier only. Never `name`, never `udid`, never `serialNumber`.
    device_model: str(f, "deviceModel"),
    device_ios_version: str(f, "deviceIosVersion"),
    device_used_bytes: bigintNum(f, "deviceUsedBytes"),
    device_free_bytes: bigintNum(f, "deviceFreeBytes"),
    device_capacity_bytes: bigintNum(f, "deviceCapacityBytes"),

    host_os_release: str(f, "hostOsRelease"),
    host_total_mem_bytes: bigintNum(f, "hostTotalMemBytes"),
    host_disk_free_bytes: bigintNum(f, "hostDiskFreeBytes"),
    host_disk_total_bytes: bigintNum(f, "hostDiskTotalBytes"),

    // BACKLOG-3598: space this run reclaimed from unfinished backups (the start sweep
    // plus its own unfinished backup on failure), and whether a removal failed. The
    // cleanup value is `removed` or `failed:<errno>` — never a path.
    leftover_backup_bytes_cleared: bigintNum(f, "leftoverBackupBytesCleared"),
    leftover_cleanup: str(f, "leftoverCleanup"),

    backup_bytes: bigintNum(f, "backupBytes"),
    backup_bytes_unmeasured: bool(f, "backupBytesUnmeasured"),
    messages_extracted: num(f, "messagesExtracted"),
    conversations_extracted: num(f, "conversationsExtracted"),
    contacts_extracted: num(f, "contactsExtracted"),
    extraction_ms: bigintNum(f, "extractionMs"),

    // BACKLOG-3671 P2 (Google Messages): built by rcsSyncOutcome's allow-list
    // builder — the only writer — so nothing unnamed reaches the jsonb.
    source_metrics: row.sourceMetrics ?? backupEncryptionMetrics(f),
    run_kind: str(f, "runKind"),
    extension_version: str(f, "extensionVersion"),
    chrome_version: str(f, "chromeVersion"),

    app_version: env.appVersion,
    // No `?? str(f, "platform")` fallback: `readEnv()` returns `process.platform` on
    // BOTH its success and its catch path, so the right-hand side was unreachable.
    // Removed after SR review rather than left as a fallback that never fires.
    platform: env.platform,
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
 * BACKLOG-3440: the heartbeat payload, WITH NO `outcome` KEY AT ALL.
 *
 * This is the one guard that has to be structural rather than careful, so it is done by
 * removing the key rather than by remembering not to set it.
 *
 * Every write here is fire-and-forget over a network with no ordering guarantee. A
 * heartbeat that was in flight when the terminal write landed would, if it carried
 * `outcome`, overwrite it — leaving a sync that COMPLETED reading `running` forever.
 * That is a new false signal produced by the instrument built to remove false signals,
 * and it would look entirely shipped. With the key absent, the worst a late heartbeat
 * can do is refresh `updated_at` and the byte counters on a finished row, which is
 * harmless and arguably still true.
 */
export function buildSyncRunProgressRow(
  row: SyncOutcomeRow,
  userId: string,
  env: { appVersion?: string; platform?: string; isPackaged?: boolean } = {},
): Record<string, unknown> {
  const { outcome: _outcome, ...rest } = buildSyncOutcomeRow(row, userId, env);
  void _outcome;
  return rest;
}

/** Resolve the session once. `null` means "signed out — drop the write". */
async function authedUserId(client: ReturnType<typeof supabaseService.getClient>) {
  const { data: sessionData } = await client.auth.getSession();
  return sessionData?.session?.user?.id ?? null;
}

/**
 * The actual write. May reject; the exported wrappers catch everything.
 *
 * THREE VERBS, ONE FUNCTION, and the verb is the whole design:
 *
 *   start     `upsert(..., ignoreDuplicates)`  -> INSERT ... ON CONFLICT DO NOTHING
 *   heartbeat `update().eq("id", …)`           -> never carries `outcome`
 *   terminal  `upsert(...)`                    -> INSERT ... ON CONFLICT DO UPDATE
 *
 * The terminal write is an UPSERT and not an UPDATE because the start write can be
 * dropped: this module drops rows when the machine is offline, on purpose, and syncs
 * happen in offices with bad Wi-Fi. If the start row never landed and the terminal write
 * were an UPDATE, a run that SUCCEEDED would leave zero rows — a regression against the
 * guarantee this table already provides.
 *
 * The start write ignores a conflict rather than erroring, because a sync that fails in
 * its first milliseconds (a pre-flight disk or driver check) can land its terminal write
 * first. A plain insert would then raise a duplicate key that the caller logs as "row
 * dropped" when the row is present and correct — and, worse, an upsert-with-update would
 * revert a finished run to `running`.
 *
 * NEVER `.select()` ON ANY OF THESE. A `.select()` chained on to "confirm the write"
 * would ask PostgREST to return the row, and the return is a separate read that a mocked
 * client cannot distinguish from a success. Measured against the real engine while
 * designing the migration: with no SELECT policy for the row's owner, a bare
 * `UPDATE ... WHERE id = $1` affected ZERO rows with no error, and the upsert failed
 * outright with 42501. The migration therefore adds an own-rows SELECT policy; this
 * comment is here so nobody "simplifies" it away.
 */
type SyncRunVerb = "start" | "heartbeat" | "heartbeat-running" | "metrics" | "terminal";

/**
 * BACKLOG-3598: the two columns its migration adds. A desktop build can reach a
 * database where that migration has not been applied yet; PostgREST then refuses the
 * WHOLE write (PGRST204, "Could not find the '<col>' column of '<table>' in the schema
 * cache" — postgrest-js parses the response body into `error`, so `code` is PostgREST's
 * own; template cited from PostgREST, not measured against this table). Without the
 * tolerance below, every heartbeat and the terminal row of a run that removed a leftover
 * are dropped, and the row stays `running`.
 *
 * Narrow on purpose: the retry fires ONLY for an unknown-column error that NAMES one of
 * these two columns. Any other error — another missing column, RLS, network — is thrown
 * unchanged. Contrast `submissionService.ts` (BACKLOG-3519), which deliberately does NOT
 * strip: there the stripped keys are what the agent typed; here they are telemetry.
 */
const LEFTOVER_COLUMNS = ["leftover_backup_bytes_cleared", "leftover_cleanup"] as const;
const UNKNOWN_COLUMN_CODES = new Set(["PGRST204", "42703"]);

/** Set once the database has told us the columns are absent; lives for the process. */
let leftoverColumnsAbsent = false;

/** Test-only: forget what the database told us. */
export function __resetLeftoverColumnsForTests(): void {
  leftoverColumnsAbsent = false;
}

type PostgrestErrorLike = { code?: string; message?: string } | null | undefined;

function isLeftoverColumnMissing(error: PostgrestErrorLike): boolean {
  if (!error || !error.code || !UNKNOWN_COLUMN_CODES.has(error.code)) return false;
  const message = error.message ?? "";
  return LEFTOVER_COLUMNS.some((col) => message.includes(col));
}

function withoutLeftoverColumns(payload: Record<string, unknown>): Record<string, unknown> {
  const out = { ...payload };
  for (const col of LEFTOVER_COLUMNS) delete out[col];
  return out;
}

/**
 * Send `payload`; if the database rejects it ONLY because the leftover columns are
 * absent, remember that and send it once more without them. Throws any other error.
 */
async function sendTolerant(
  payload: Record<string, unknown>,
  send: (p: Record<string, unknown>) => PromiseLike<{ error: PostgrestErrorLike }>,
): Promise<void> {
  const first = await send(leftoverColumnsAbsent ? withoutLeftoverColumns(payload) : payload);
  if (!first.error) return;
  if (leftoverColumnsAbsent || !isLeftoverColumnMissing(first.error)) {
    throw new Error(first.error.message);
  }
  leftoverColumnsAbsent = true;
  log.warn(
    `${LOG_TAG} sync_outcomes has no leftover-cleanup columns yet; writing rows without them for the rest of this session`,
  );
  const retry = await send(withoutLeftoverColumns(payload));
  if (retry.error) throw new Error(retry.error.message);
}

async function writeSyncRun(row: SyncOutcomeRow, verb: SyncRunVerb) {
  const client = supabaseService.getClient();

  // RLS ("Users can insert/update own sync outcomes") requires user_id = auth.uid().
  const userId = await authedUserId(client);
  if (!userId) {
    // Signed out. Nothing to attribute the run to, and RLS would refuse it anyway.
    // The Sentry event for this same sync still went out.
    log.warn(`${LOG_TAG} No authenticated session; sync outcome not recorded to corpus`);
    return;
  }

  const env = readEnv();
  // A fresh builder per send: the retry in `sendTolerant` cannot reuse a consumed one.
  const table = () => client.from(SYNC_OUTCOMES_TABLE);

  if (verb === "heartbeat") {
    const runId = row.runId;
    if (!runId) return;
    await sendTolerant(buildSyncRunProgressRow(row, userId, env), (p) =>
      table().update(p).eq("id", runId),
    );
    return;
  }

  // BACKLOG-3671 P2: a heartbeat that can only touch a row still RUNNING — a
  // late one (fire-and-forget, no ordering) never rewrites a finished row's
  // counts or updated_at, let alone its outcome (which it never carries).
  if (verb === "heartbeat-running") {
    const runId = row.runId;
    if (!runId) return;
    await sendTolerant(buildSyncRunProgressRow(row, userId, env), (p) =>
      table().update(p).eq("id", runId).eq("outcome", "running"),
    );
    return;
  }

  // BACKLOG-3671 P2: a follow-up after the terminal row (e.g. the save's counts
  // arrived after the wait): ONLY source_metrics (+ updated_at). Never outcome,
  // never reason_code.
  if (verb === "metrics") {
    if (!row.runId || !row.sourceMetrics) return;
    const { error } = await table()
      .update({ source_metrics: row.sourceMetrics, updated_at: new Date().toISOString() })
      .eq("id", row.runId);
    if (error) throw new Error(error.message);
    return;
  }

  await sendTolerant(buildSyncOutcomeRow(row, userId, env), (p) =>
    verb === "start"
      ? table().upsert(p, { onConflict: "id", ignoreDuplicates: true })
      : table().upsert(p, { onConflict: "id" }),
  );
}

/** Shared fire-and-forget wrapper. NEVER throws, never awaits, never delays a sync. */
function fireAndForget(row: SyncOutcomeRow, verb: SyncRunVerb): Promise<void> {
  // ONE handler, not two, and the reason is worth stating because the first draft had
  // two. `writeSyncRun` is an ASYNC function, so a throw anywhere inside it —
  // including `supabaseService.getClient()` on a machine with no client configured —
  // becomes a REJECTED PROMISE, never a synchronous throw. A `try/catch` wrapped
  // around this call is therefore unreachable code that reads like a safety net.
  // Proven, not assumed: with the try/catch deleted, all 17 tests in this suite still
  // passed, including "does not throw when the Supabase client is unavailable". The
  // detached catch below is what actually carries the load — deleting THAT reds three
  // tests.
  const write = writeSyncRun(row, verb);
  // The settled write (it never rejects): a caller that must ORDER a later
  // write after this one chains on it (BACKLOG-3671 P2); nobody awaits it on
  // a sync's path.
  return write.catch((error: unknown) => {
    log.warn(
      `${LOG_TAG} ${verb} row dropped (offline, signed out, or write failed); sync unaffected:`,
      error instanceof Error ? error.message : String(error),
    );
  });
}

/**
 * BACKLOG-3440: THE RUN EXISTS IN THE CORPUS BEFORE IT CAN FAIL.
 *
 * The highest-value line in this item. On 2026-09-16 a user lost three hours to a sync
 * that never completed and left NO ROW AT ALL — not a failure row, nothing — because the
 * record was assembled at the end and that run had no end.
 */
export function recordSyncRunStart(row: SyncOutcomeRow): void {
  void fireAndForget(row, "start");
}

/** BACKLOG-3440: the run is still alive, and here is how far it has got. */
export function recordSyncRunProgress(row: SyncOutcomeRow): void {
  void fireAndForget(row, "heartbeat");
}

/** BACKLOG-3671 P2: a heartbeat that never touches a row no longer running. */
export function recordSyncRunProgressWhileRunning(row: SyncOutcomeRow): void {
  void fireAndForget(row, "heartbeat-running");
}

/** BACKLOG-3671 P2: a follow-up that updates source_metrics only (never outcome / reason_code). */
export function recordSyncRunMetrics(row: SyncOutcomeRow): void {
  void fireAndForget(row, "metrics");
}

/**
 * Best-effort, fire-and-forget record of one sync outcome. NEVER throws, never
 * awaits, never delays or fails the sync.
 */
export function recordSyncOutcome(row: SyncOutcomeRow): void {
  void fireAndForget(row, "terminal");
}

/**
 * BACKLOG-3671 P2: the terminal write, with a promise that settles (never
 * rejects) once it has landed or been dropped — so a follow-up can be sent
 * strictly AFTER it, never concurrently (a late follow-up would otherwise be
 * overwritten by the terminal upsert's source_metrics).
 */
export function recordSyncOutcomeSettled(row: SyncOutcomeRow): Promise<void> {
  return fireAndForget(row, "terminal");
}

export default {
  recordSyncOutcome,
  recordSyncRunStart,
  recordSyncRunProgress,
  recordSyncRunProgressWhileRunning,
  recordSyncRunMetrics,
  buildSyncOutcomeRow,
  buildSyncRunProgressRow,
  SYNC_OUTCOMES_TABLE,
};
