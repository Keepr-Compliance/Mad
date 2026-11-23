/**
 * Request handler for the cloud-blob-erase Edge Function (BACKLOG-4263, sync plan P3).
 *
 * Pure TypeScript with no Deno-specific imports, so Jest can test it.
 * `index.ts` wires it to `Deno.serve` with the real environment and `fetch`.
 *
 * Caller: `public.cloud_blob_erase_invoke()`, run hourly by the cron job `cloud-blob-erase`
 * (migration 20261123120000). It sends `x-webhook-secret`; a request without the matching value gets 401.
 *
 * One run:
 *   1. rpc/cloud_blob_erase_claim  -> fenced blobs to erase, objects with no blob row, owners to scrub
 *      (live mode also hard-deletes rows removed more than 24 h ago and fences unreferenced blobs, in SQL)
 *   2. live only: Storage API remove of the exact object names, chunks of 100
 *   3. rpc/cloud_blob_erase_finish -> deletes only blob rows whose object is gone
 *   4. rpc/cloud_blob_erase_scrub  -> one batch per owner per round, round-robin, oldest move first, until every
 *      owner is done or the time budget is spent (a dry run makes one counting round)
 *   5. rpc/cloud_blob_erase_note   -> adds the scrub counts, and a partial outcome, to the run row
 * Bytes fenced by a scrub batch are erased by the next run's step 2.
 * Which rows and objects qualify is decided in SQL (the service role bypasses RLS, so the rules live in the
 * SECURITY DEFINER functions).
 *
 * Mode: CLOUD_BLOB_ERASE_MODE must be exactly "live" for a live run; anything else is a dry run. A request body can
 * only ask for a dry run.
 *
 * Logs, responses and Sentry events carry counts only. No user id, blob id, path or response body is logged,
 * returned or thrown.
 */

export const WEBHOOK_SECRET_HEADER = "x-webhook-secret";
export const BUCKET = "cloud-deal-files";
export const REMOVE_CHUNK = 100;
export const SCRUB_BATCH = 1000;
export const SCRUB_BUDGET_MS = 60_000;
export const MONITOR_SLUG = "cloud-blob-erase";
export const MONITOR_SCHEDULE = "23 * * * *";

export interface HandlerDeps {
  getEnv: (name: string) => string | undefined;
  fetch: typeof fetch;
  uuid: () => string;
  now: () => number;
  log: (line: string) => void;
}

export interface EraseCounts {
  mode: "dry_run" | "live";
  blobs_listed: number;
  rowless_listed: number;
  objects_removed: number;
  rowless_removed: number;
  remove_errors: number;
  blob_rows_deleted: number;
  blob_rows_kept: number;
  scrub_owners: number;
  scrub_rounds: number;
  scrub_batches: number;
  rows_scrubbed: number;
  rows_would_scrub: number;
  scrub_skipped: number;
  scrub_errors: number;
  scrub_owners_left: number;
  scrub_ms: number;
  note_errors?: number;
}

interface ClaimResult {
  run_id: string;
  blobs: Array<{ id: string; path: string }>;
  rowless: string[];
  scrub_owners: string[];
}

interface ScrubResult {
  state?: string;
  scrubbed?: number;
  would_scrub?: number;
  more?: boolean;
}

/** A failure that carries only a stage and a numeric status, never a body. */
export class EraseError extends Error {
  constructor(public stage: string, public status: number) {
    super(`cloud blob erase failed at ${stage} (status ${status})`);
    this.name = "EraseError";
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Length-independent-time string comparison. */
export function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

let cachedSecret: string | null = null;
/** Test-only: clears the cached webhook secret. */
export function resetWebhookSecretCache(): void {
  cachedSecret = null;
}

function serviceHeaders(serviceKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
  };
}

async function rpc(deps: HandlerDeps, stage: string, fn: string, args: unknown): Promise<unknown> {
  const url = deps.getEnv("SUPABASE_URL");
  const key = deps.getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new EraseError(stage, 0);
  const res = await deps.fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: serviceHeaders(key),
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new EraseError(stage, res.status);
  return await res.json();
}

async function loadWebhookSecret(deps: HandlerDeps): Promise<string | null> {
  if (cachedSecret) return cachedSecret;
  try {
    const value = await rpc(deps, "secret", "cloud_blob_erase_secret", {});
    if (typeof value !== "string" || value.length < 32) return null;
    cachedSecret = value;
    return value;
  } catch {
    return null;
  }
}

/** Removes exact object names through the Storage API. Returns how many the API reports removed. */
async function removeObjects(deps: HandlerDeps, names: string[]): Promise<number> {
  const url = deps.getEnv("SUPABASE_URL");
  const key = deps.getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new EraseError("remove", 0);
  const res = await deps.fetch(`${url}/storage/v1/object/${BUCKET}`, {
    method: "DELETE",
    headers: serviceHeaders(key),
    body: JSON.stringify({ prefixes: names }),
  });
  if (!res.ok) throw new EraseError("remove", res.status);
  const removed = await res.json().catch(() => null);
  return Array.isArray(removed) ? removed.length : 0;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ── Sentry (envelope over fetch; no SDK) ────────────────────────────────
interface Dsn { endpoint: string; auth: string }
export function parseDsn(dsn: string | undefined): Dsn | null {
  if (!dsn) return null;
  const m = /^https:\/\/([^@/]+)@([^/]+)\/(\d+)$/.exec(dsn.trim());
  if (!m) return null;
  return {
    endpoint: `https://${m[2]}/api/${m[3]}/envelope/`,
    auth: `Sentry sentry_version=7, sentry_key=${m[1]}, sentry_client=keepr-cloud-blob-erase/1.0`,
  };
}

async function sentrySend(deps: HandlerDeps, item: { type: string }, payload: unknown): Promise<void> {
  const dsn = parseDsn(deps.getEnv("SENTRY_DSN"));
  if (!dsn) return;
  try {
    const body = `${JSON.stringify({ sent_at: new Date().toISOString() })}\n${JSON.stringify(item)}\n${JSON.stringify(payload)}\n`;
    await deps.fetch(dsn.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope", "X-Sentry-Auth": dsn.auth },
      body,
    });
  } catch {
    // Sentry must never fail the run.
  }
}

function checkIn(deps: HandlerDeps, id: string, status: "in_progress" | "ok" | "error", durationS?: number) {
  return sentrySend(deps, { type: "check_in" }, {
    check_in_id: id,
    monitor_slug: MONITOR_SLUG,
    status,
    ...(durationS === undefined ? {} : { duration: durationS }),
    monitor_config: {
      schedule: { type: "crontab", value: MONITOR_SCHEDULE },
      checkin_margin: 30,
      max_runtime: 10,
      timezone: "UTC",
    },
  });
}

function captureFailure(deps: HandlerDeps, stage: string, status: number, counts: EraseCounts, runId: string | null) {
  return sentrySend(deps, { type: "event" }, {
    event_id: deps.uuid().replace(/-/g, ""),
    level: "error",
    platform: "javascript",
    message: "Cloud blob erase failed",
    tags: { area: "cloud_blob_erase", stage, mode: counts.mode },
    extra: { ...counts, status, run_id: runId },
  });
}

export function emptyCounts(mode: "dry_run" | "live"): EraseCounts {
  return {
    mode, blobs_listed: 0, rowless_listed: 0, objects_removed: 0, rowless_removed: 0, remove_errors: 0,
    blob_rows_deleted: 0, blob_rows_kept: 0, scrub_owners: 0, scrub_rounds: 0, scrub_batches: 0,
    rows_scrubbed: 0, rows_would_scrub: 0, scrub_skipped: 0, scrub_errors: 0, scrub_owners_left: 0, scrub_ms: 0,
  };
}

const SCRUB_KEY = /^(scrub_|rows_)/;
/** Numeric counts of the erase step (sent to finish) or of the scrub step (sent to note, after the scrub). */
function numericCounts(c: EraseCounts, step: "erase" | "scrub"): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(c)) {
    if (typeof v === "number" && SCRUB_KEY.test(k) === (step === "scrub")) out[k] = v;
  }
  return out;
}

/**
 * Round-robin scrub: each round gives every remaining owner one batch, in the order the claim returned them (oldest
 * move first). An owner leaves the list when its batch reports no more rows, is skipped, does not apply, or fails.
 * A dry run makes one round (nothing changes, so a second round would count the same rows again).
 */
async function scrubRounds(deps: HandlerDeps, live: boolean, runId: string, owners: string[], started: number,
  counts: EraseCounts): Promise<void> {
  let left = owners.slice();
  while (left.length > 0) {
    if (deps.now() - started >= SCRUB_BUDGET_MS) break;
    counts.scrub_rounds += 1;
    const next: string[] = [];
    for (const owner of left) {
      if (deps.now() - started >= SCRUB_BUDGET_MS) {
        next.push(owner);
        continue;
      }
      try {
        const res = (await rpc(deps, "scrub", "cloud_blob_erase_scrub", {
          p_run_id: runId, p_owner: owner, p_dry_run: !live, p_limit: SCRUB_BATCH,
        })) as ScrubResult;
        counts.scrub_batches += 1;
        counts.rows_scrubbed += Number(res?.scrubbed) || 0;
        counts.rows_would_scrub += Number(res?.would_scrub) || 0;
        if (res?.state === "skipped") counts.scrub_skipped += 1;
        if (live && res?.state === "scrubbed" && res?.more === true) next.push(owner);
      } catch {
        counts.scrub_errors += 1;
      }
    }
    left = next;
    if (!live) break;
  }
  counts.scrub_owners_left = left.length;
}

export async function handleRequest(req: Request, deps: HandlerDeps): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // ── Authenticate the caller (fail closed) ─────────────────────────────
  const presented = req.headers.get(WEBHOOK_SECRET_HEADER);
  if (!presented) return json({ error: "Unauthorized" }, 401);
  const expected = await loadWebhookSecret(deps);
  if (!expected || !timingSafeEqual(presented, expected)) return json({ error: "Unauthorized" }, 401);

  // ── Mode: env decides; the body can only downgrade ────────────────────
  const body = (await req.json().catch(() => null)) as { dry_run?: unknown } | null;
  const live = deps.getEnv("CLOUD_BLOB_ERASE_MODE") === "live" && body?.dry_run !== true;
  const counts = emptyCounts(live ? "live" : "dry_run");

  const checkInId = deps.uuid();
  const started = deps.now();
  await checkIn(deps, checkInId, "in_progress");

  let runId: string | null = null;
  let stage = "claim";
  try {
    const claim = (await rpc(deps, "claim", "cloud_blob_erase_claim", { p_dry_run: !live })) as ClaimResult;
    runId = typeof claim?.run_id === "string" ? claim.run_id : null;
    if (!runId) throw new EraseError("claim", 0);
    const blobs = live && Array.isArray(claim?.blobs) ? claim.blobs : [];
    const rowless = live && Array.isArray(claim?.rowless) ? claim.rowless : [];
    const owners = Array.isArray(claim?.scrub_owners) ? claim.scrub_owners.filter((o) => typeof o === "string") : [];
    counts.blobs_listed = blobs.length;
    counts.rowless_listed = rowless.length;
    counts.scrub_owners = owners.length;

    // ── Erase bytes first ─────────────────────────────────────────────────
    const finishIds: string[] = [];
    if (live) {
      stage = "remove";
      for (const part of chunks(blobs, REMOVE_CHUNK)) {
        try {
          counts.objects_removed += await removeObjects(deps, part.map((b) => b.path));
          for (const b of part) finishIds.push(b.id);
        } catch {
          counts.remove_errors += 1;
        }
      }
      for (const part of chunks(rowless, REMOVE_CHUNK)) {
        try {
          counts.rowless_removed += await removeObjects(deps, part);
        } catch {
          counts.remove_errors += 1;
        }
      }
    }

    stage = "finish";
    // A rowless object is listed from storage.objects, so each one listed must come back removed.
    const removeShort = counts.remove_errors > 0 || counts.rowless_removed < counts.rowless_listed;
    const fin = (await rpc(deps, "finish", "cloud_blob_erase_finish", {
      p_run_id: runId,
      p_blob_ids: finishIds,
      p_counts: numericCounts(counts, "erase"),
      p_outcome: removeShort ? "partial" : "ok",
    })) as { blob_rows_deleted?: number; blob_rows_kept?: number };
    counts.blob_rows_deleted = Number(fin?.blob_rows_deleted) || 0;
    counts.blob_rows_kept = Number(fin?.blob_rows_kept) || 0;

    // ── Then scrub non-active computers' rows ─────────────────────────────
    stage = "scrub";
    const scrubStarted = deps.now();
    await scrubRounds(deps, live, runId, owners, started, counts);
    counts.scrub_ms = deps.now() - scrubStarted;

    // A blob row kept after its remove succeeded means the object is still there: bytes not erased.
    const eraseShort = removeShort || counts.blob_rows_kept > 0;
    const failed = eraseShort || counts.scrub_errors > 0;
    stage = "note";
    try {
      await rpc(deps, "note", "cloud_blob_erase_note", {
        p_run_id: runId, p_counts: numericCounts(counts, "scrub"), p_outcome: failed ? "partial" : "ok",
      });
    } catch {
      counts.note_errors = 1;
    }
    deps.log(JSON.stringify({ cloud_blob_erase: failed ? "partial" : "ok", ...counts }));
    if (failed) await captureFailure(deps, eraseShort ? "remove" : "scrub", 0, counts, runId);
    await checkIn(deps, checkInId, failed ? "error" : "ok", (deps.now() - started) / 1000);
    return json({ outcome: failed ? "partial" : "ok", ...counts });
  } catch (err) {
    const status = err instanceof EraseError ? err.status : 0;
    const failedStage = err instanceof EraseError ? err.stage : stage;
    if (runId && failedStage !== "finish") {
      try {
        await rpc(deps, "finish", "cloud_blob_erase_finish", {
          p_run_id: runId, p_blob_ids: [], p_counts: numericCounts(counts, "erase"), p_outcome: "failed",
        });
      } catch {
        // the run row stays 'running'; the missed check-in reports it
      }
    }
    deps.log(JSON.stringify({ cloud_blob_erase: "failed", stage: failedStage, status, ...counts }));
    await captureFailure(deps, failedStage, status, counts, runId);
    await checkIn(deps, checkInId, "error", (deps.now() - started) / 1000);
    return json({ outcome: "failed", stage: failedStage, status }, 500);
  }
}
