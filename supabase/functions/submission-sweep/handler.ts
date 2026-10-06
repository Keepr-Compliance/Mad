/**
 * Request handler for the submission-sweep Edge Function (BACKLOG-3726).
 *
 * Pure TypeScript with no Deno-specific imports, so Jest can test it.
 * `index.ts` wires it to `Deno.serve` with the real environment and `fetch`.
 *
 * Caller: `public.submission_sweep_invoke()`, run hourly by the cron job
 * `submission-sweep` (migration 20261004232511). It sends `x-webhook-secret`;
 * every request without the matching value gets 401.
 *
 * One run:
 *   1. rpc/submission_sweep_claim  -> work list (fences stalled uploads in live mode)
 *   2. live only: Storage API remove, exact object names, chunks of 100
 *   3. rpc/submission_sweep_finish -> deletes only rows whose files are gone
 * Which rows and files qualify is decided in SQL (the service role bypasses
 * RLS, so the rules live in the SECURITY DEFINER functions).
 *
 * Mode: SUBMISSION_SWEEP_MODE must be exactly "live" for a live run; anything
 * else is a dry run. A request body can only ask for a dry run.
 *
 * Logs, responses and Sentry events carry counts only. No submission id, path,
 * file name or response body is ever logged, returned or thrown.
 */

export const WEBHOOK_SECRET_HEADER = "x-webhook-secret";
export const BUCKET = "submission-attachments";
export const REMOVE_CHUNK = 100;
export const MONITOR_SLUG = "submission-sweep";
export const MONITOR_SCHEDULE = "41 * * * *";

export interface HandlerDeps {
  getEnv: (name: string) => string | undefined;
  fetch: typeof fetch;
  uuid: () => string;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

export interface SweepCounts {
  mode: "dry_run" | "live";
  fenced: number;
  would_fence: number;
  abandoned_listed: number;
  stalled_listed: number;
  referenced_as_parent: number;
  objects_targeted: number;
  objects_removed: number;
  orphans_targeted: number;
  orphans_removed: number;
  rows_deleted: number;
  rows_kept: number;
  unreferenced_in_live_submissions: number;
  remove_errors: number;
}

interface ClaimResult {
  run_id: string;
  fenced_now: number;
  would_fence: number;
  submissions: Array<{ id: string; reason: string; paths: string[] }>;
  orphans: string[];
  unreferenced_in_live_submissions: number;
  referenced_as_parent: number;
}

/** A failure that carries only a stage and a numeric status, never a body. */
export class SweepError extends Error {
  constructor(public stage: string, public status: number) {
    super(`submission sweep failed at ${stage} (status ${status})`);
    this.name = "SweepError";
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
  if (!url || !key) throw new SweepError(stage, 0);
  const res = await deps.fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: serviceHeaders(key),
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new SweepError(stage, res.status);
  return await res.json();
}

async function loadWebhookSecret(deps: HandlerDeps): Promise<string | null> {
  if (cachedSecret) return cachedSecret;
  try {
    const value = await rpc(deps, "secret", "submission_sweep_secret", {});
    if (typeof value !== "string" || value.length < 32) return null;
    cachedSecret = value;
    return value;
  } catch {
    return null;
  }
}

/** Removes exact object names through the Storage API. Returns how many were removed. */
async function removeObjects(deps: HandlerDeps, names: string[]): Promise<number> {
  const url = deps.getEnv("SUPABASE_URL");
  const key = deps.getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new SweepError("remove", 0);
  const res = await deps.fetch(`${url}/storage/v1/object/${BUCKET}`, {
    method: "DELETE",
    headers: serviceHeaders(key),
    body: JSON.stringify({ prefixes: names }),
  });
  if (!res.ok) throw new SweepError("remove", res.status);
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
    auth: `Sentry sentry_version=7, sentry_key=${m[1]}, sentry_client=keepr-submission-sweep/1.0`,
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
    // Sentry must never fail the sweep.
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

function captureFailure(deps: HandlerDeps, stage: string, status: number, counts: SweepCounts, runId: string | null) {
  return sentrySend(deps, { type: "event" }, {
    event_id: deps.uuid().replace(/-/g, ""),
    level: "error",
    platform: "javascript",
    message: "Submission sweep failed",
    tags: { area: "submission_sweep", stage, mode: counts.mode },
    extra: { ...counts, status, run_id: runId },
  });
}

// Local test hook: an injected delay before finish, honoured only when the
// function talks to a local stack (used to prove a run longer than pg_net's
// default 5 s still records its finish row).
const LOCAL_HOSTS = new Set(["kong", "localhost", "127.0.0.1", "host.docker.internal"]);
function localDelayMs(deps: HandlerDeps): number {
  const raw = deps.getEnv("SUBMISSION_SWEEP_TEST_DELAY_MS");
  if (!raw) return 0;
  let host = "";
  try {
    host = new URL(deps.getEnv("SUPABASE_URL") ?? "").hostname;
  } catch {
    return 0;
  }
  if (!LOCAL_HOSTS.has(host)) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 60000) : 0;
}

export function emptyCounts(mode: "dry_run" | "live"): SweepCounts {
  return {
    mode, fenced: 0, would_fence: 0, abandoned_listed: 0, stalled_listed: 0, referenced_as_parent: 0,
    objects_targeted: 0, objects_removed: 0, orphans_targeted: 0, orphans_removed: 0,
    rows_deleted: 0, rows_kept: 0, unreferenced_in_live_submissions: 0, remove_errors: 0,
  };
}

function numericCounts(c: SweepCounts): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(c)) if (typeof v === "number") out[k] = v;
  return out;
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
  const live = deps.getEnv("SUBMISSION_SWEEP_MODE") === "live" && body?.dry_run !== true;
  const counts = emptyCounts(live ? "live" : "dry_run");

  const checkInId = deps.uuid();
  const started = Date.now();
  await checkIn(deps, checkInId, "in_progress");

  let runId: string | null = null;
  let stage = "claim";
  try {
    const claim = (await rpc(deps, "claim", "submission_sweep_claim", { p_dry_run: !live })) as ClaimResult;
    runId = typeof claim?.run_id === "string" ? claim.run_id : null;
    const subs = Array.isArray(claim?.submissions) ? claim.submissions : [];
    const orphans = Array.isArray(claim?.orphans) ? claim.orphans : [];
    counts.fenced = Number(claim?.fenced_now) || 0;
    counts.would_fence = Number(claim?.would_fence) || 0;
    counts.abandoned_listed = subs.filter((s) => s.reason === "abandoned").length;
    counts.stalled_listed = subs.filter((s) => s.reason === "stalled").length;
    counts.referenced_as_parent = Number(claim?.referenced_as_parent) || 0;
    counts.unreferenced_in_live_submissions = Number(claim?.unreferenced_in_live_submissions) || 0;
    counts.objects_targeted = subs.reduce((n, s) => n + (Array.isArray(s.paths) ? s.paths.length : 0), 0);
    counts.orphans_targeted = orphans.length;

    const finishIds: string[] = [];
    if (live) {
      stage = "remove";
      for (const s of subs) {
        let allRemoved = true;
        for (const part of chunks(Array.isArray(s.paths) ? s.paths : [], REMOVE_CHUNK)) {
          try {
            counts.objects_removed += await removeObjects(deps, part);
          } catch {
            counts.remove_errors += 1;
            allRemoved = false;
          }
        }
        if (allRemoved) finishIds.push(s.id);
      }
      for (const part of chunks(orphans, REMOVE_CHUNK)) {
        try {
          counts.orphans_removed += await removeObjects(deps, part);
        } catch {
          counts.remove_errors += 1;
        }
      }
    }

    const delay = localDelayMs(deps);
    if (delay > 0) await deps.sleep(delay);

    stage = "finish";
    const outcome = counts.remove_errors > 0 ? "partial" : "ok";
    const fin = (await rpc(deps, "finish", "submission_sweep_finish", {
      p_run_id: runId,
      p_submission_ids: finishIds,
      p_counts: numericCounts(counts),
      p_outcome: outcome,
    })) as { rows_deleted?: number; rows_kept?: number };
    counts.rows_deleted = Number(fin?.rows_deleted) || 0;
    counts.rows_kept = Number(fin?.rows_kept) || 0;

    deps.log(JSON.stringify({ submission_sweep: outcome, ...counts }));
    if (outcome === "partial") await captureFailure(deps, "remove", 0, counts, runId);
    await checkIn(deps, checkInId, outcome === "ok" ? "ok" : "error", (Date.now() - started) / 1000);
    return json({ outcome, ...counts });
  } catch (err) {
    const status = err instanceof SweepError ? err.status : 0;
    const failedStage = err instanceof SweepError ? err.stage : stage;
    if (runId) {
      try {
        await rpc(deps, "finish", "submission_sweep_finish", {
          p_run_id: runId, p_submission_ids: [], p_counts: numericCounts(counts), p_outcome: "failed",
        });
      } catch {
        // the run row stays 'running'; the missed check-in reports it
      }
    }
    deps.log(JSON.stringify({ submission_sweep: "failed", stage: failedStage, status, ...counts }));
    await captureFailure(deps, failedStage, status, counts, runId);
    await checkIn(deps, checkInId, "error", (Date.now() - started) / 1000);
    return json({ outcome: "failed", stage: failedStage, status }, 500);
  }
}
