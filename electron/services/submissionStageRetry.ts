/**
 * BACKLOG-3403 — retry one stage of a submission, and tell a temporary failure
 * from a permanent one.
 *
 * supabase-js answers with `{ data, error }` rather than throwing, and a
 * dropped connection reaches us either as a rejected promise or as an error
 * with no Postgres code. The rule:
 *
 *   retry      no answer at all, a timeout, an HTTP 5xx / 408 / 429, a fetch or
 *              socket failure, or an error with neither a code nor a status
 *   never      a Postgres SQLSTATE (42501 policy, 23505 duplicate, 23503 FK,
 *              22P02 bad input, …) or a PostgREST `PGRST…` code — asking again
 *              gets the same answer
 *
 * Three attempts, 1 s then 2 s apart (the same as the uploader).
 */

export type SubmissionStageName =
  | "gather"
  | "preflight"
  | "sweep"
  | "parent"
  | "messages"
  | "attachment_rows"
  | "uploads"
  | "checklists"
  | "finalize"
  | "read_back"
  | "abandon";

export interface StageErrorLike {
  code?: string | null;
  message?: string | null;
  status?: number | null;
  statusCode?: string | number | null;
}

/** A stage that ran out of attempts, or failed permanently. */
export class SubmissionStageError extends Error {
  readonly stage: SubmissionStageName;
  /** SQLSTATE / PostgREST code, or the HTTP status as text. Never driver prose. */
  readonly code: string | null;
  readonly transient: boolean;
  readonly attempts: number;
  /**
   * The driver's own text, for the LOCAL log only. Never Sentry, never
   * error_logs, never the user: it can name a constraint, a path or a file.
   */
  readonly driverMessage: string | null;
  constructor(
    stage: SubmissionStageName,
    code: string | null,
    transient: boolean,
    attempts: number,
    message: string,
    driverMessage: string | null = null
  ) {
    super(message);
    this.name = "SubmissionStageError";
    this.stage = stage;
    this.code = code;
    this.transient = transient;
    this.attempts = attempts;
    this.driverMessage = driverMessage;
  }
}

/** The submission was cancelled by the user (BACKLOG-3398). */
export class SubmissionCancelledError extends Error {
  constructor() {
    super("Submission cancelled");
    this.name = "SubmissionCancelledError";
  }
}

const SQLSTATE = /^[0-9A-Z]{5}$/;
const TRANSPORT_WORDS =
  /fetch failed|failed to fetch|network|timed? ?out|timeout|socket|econn|etimedout|enotfound|eai_again|aborted/i;

function numericStatus(err: StageErrorLike): number | null {
  if (typeof err.status === "number") return err.status;
  if (typeof err.statusCode === "number") return err.statusCode;
  if (typeof err.statusCode === "string" && /^\d{3}$/.test(err.statusCode)) {
    return Number(err.statusCode);
  }
  return null;
}

/** True when asking again could get a different answer. */
export function isTransientStageError(err: unknown): boolean {
  if (err === null || err === undefined) return true;
  if (typeof err !== "object") return true;
  const e = err as StageErrorLike;
  const code = typeof e.code === "string" ? e.code : "";
  if (code.startsWith("PGRST")) return false;
  if (SQLSTATE.test(code)) return false;
  const status = numericStatus(e);
  if (status !== null) {
    return status >= 500 || status === 408 || status === 429;
  }
  if (TRANSPORT_WORDS.test(String(e.message ?? ""))) return true;
  // No code and no status: the request never got a database answer.
  return code === "";
}

/** The code we may report (never the driver's prose). */
function driverText(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const m = (err as StageErrorLike).message;
  return typeof m === "string" ? m : null;
}

export function stageErrorCode(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const e = err as StageErrorLike;
  if (typeof e.code === "string" && e.code.length > 0 && e.code.length <= 16) {
    return e.code;
  }
  const status = numericStatus(e);
  return status !== null ? String(status) : null;
}

export interface StageRetryOptions {
  attempts?: number;
  delaysMs?: number[];
  signal?: AbortSignal;
  /** Injected in tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Delays used by every stage. Tests replace them through {@link setStageRetryDelaysForTests}. */
let stageDelaysMs: number[] = [1000, 2000];

/** Tests only: make retries instant. */
export function setStageRetryDelaysForTests(delays: number[]): void {
  stageDelaysMs = delays;
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SubmissionCancelledError();
}

/**
 * Run `fn` until it answers without an error, up to `attempts` times.
 * `fn` returns the supabase-js `{ data, error }` envelope; a thrown error counts
 * as "no answer". Returns `data`; throws {@link SubmissionStageError}.
 */
export async function withStageRetry<T>(
  stage: SubmissionStageName,
  fn: () => PromiseLike<{ data: T; error: unknown }>,
  options: StageRetryOptions = {}
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const delays = options.delaysMs ?? stageDelaysMs;
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    throwIfCancelled(options.signal);
    let error: unknown;
    let data: T | undefined;
    try {
      const result = await fn();
      error = result.error;
      data = result.data;
    } catch (thrown) {
      error = thrown ?? new Error("no answer");
    }
    if (!error) return data as T;
    lastError = error;
    if (!isTransientStageError(error)) {
      throw new SubmissionStageError(
        stage,
        stageErrorCode(error),
        false,
        attempt,
        `${stage} failed permanently`,
        driverText(error)
      );
    }
    if (attempt < attempts) {
      await sleep(delays[Math.min(attempt - 1, delays.length - 1)] ?? 0);
    }
  }
  throw new SubmissionStageError(
    stage,
    stageErrorCode(lastError),
    true,
    attempts,
    `${stage} failed after ${attempts} attempts`,
    driverText(lastError)
  );
}
