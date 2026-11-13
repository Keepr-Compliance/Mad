/**
 * Learn pilot report: send and withdraw — BACKLOG-4219 PR2 (main process only).
 *
 * When a user has turned on "Help improve Keepr", each Learn score
 * (`learn:score`) may send one numbers-only snapshot (learn/pilotReport.ts) to
 * `learn_pilot_report_submit`. Turning it off — or Learn mode off, or Delete
 * all answers, or the org losing autodetect_eval — calls
 * `learn_pilot_report_withdraw`, which deletes every snapshot of the caller.
 *
 * INJECTED, never imported by the Learn handlers (main.ts passes it to
 * registerLearnModeHandlers), so learnModeHandlers.ts keeps no static edge to
 * the network path (P10).
 *
 * R1, one serial queue per user. Every submit and every withdraw for a user is
 * a job on that user's queue; jobs run one at a time, in order. A withdraw
 * waits for an in-flight submit to settle (resolve, fail, or time out) and
 * only then deletes. A submit re-reads the switch and the owed-withdraw flag
 * immediately before its RPC and drops itself if either says no. A submit that
 * timed out without settling may still land on the server, so the next
 * successful withdraw schedules ONE more withdraw 60 s later.
 *
 * D3 / R7, throttle per (user, sender-rules version), persisted in
 * the Learn settings row's pilot_sent_versions ({version: last successful submit},
 * at most 5, oldest evicted), written ONLY after a successful submit and
 * cleared by a successful withdraw. Send when the version has no entry; or its
 * entry is >= 6 h old AND (an answer was saved after it, or it is >= 24 h old).
 * A restart reads the column, so the throttle survives it.
 *
 * R3, startup and sign-in. `start()` (main.ts) checks 30 s after start, then
 * once a minute reads the session user (cached; no network) and checks again
 * whenever it changes (a sign-in) — and retries an owed withdraw for the
 * signed-in user at most every 5 min. The check is for the SIGNED-IN user only:
 * another user's owed withdraw waits until that user signs in, because a
 * withdraw deletes the caller's rows. Key lost = the strict read says
 * "blocked" (never "unknown": offline must not turn sharing off).
 *
 * Logs carry the step and counts or an error CODE only; never the payload.
 */
import { app } from "electron";

import logService from "./logService";
import supabaseService from "./supabaseService";
import { AUTODETECT_EVAL_FEATURE_KEY, resolveStrictFeatureState } from "../handlers/featureGateHandlers";
import {
  getPilotState,
  latestAnswerAt,
  markPilotWithdrawDone,
  setPilotOffPending,
  setPilotSentVersions,
  setPilotUnsettledAt,
} from "./db/learnModeDbService";
import { buildPilotReport } from "./learn/pilotReport";
import type { LearnScore, SenderCensus } from "./learn/scoring";

export const PILOT_RPC_TIMEOUT_MS = 10_000;
export const PILOT_MIN_RESEND_MS = 6 * 60 * 60 * 1000;
export const PILOT_IDLE_RESEND_MS = 24 * 60 * 60 * 1000;
export const PILOT_EXTRA_WITHDRAW_MS = 60_000;
export const PILOT_MAX_SENT_VERSIONS = 5;
export const PILOT_FIRST_CHECK_MS = 30_000;
export const PILOT_SESSION_TICK_MS = 60_000;
export const PILOT_RETRY_MS = 5 * 60 * 1000;

export const SUBMIT_RPC = "learn_pilot_report_submit";
export const WITHDRAW_RPC = "learn_pilot_report_withdraw";

const MODULE = "LearnPilot";

/**
 * What the Learn handlers see (injected). maybeSend and queueWithdraw are
 * fire-and-forget. idle is awaited only by learn:get-state `{ settle: true }`
 * (capped there), so Settings can show a send or withdraw on the same visit.
 */
export interface LearnPilotReportDeps {
  maybeSend: (userId: string, score: LearnScore, detector: SenderCensus) => void;
  queueWithdraw: (userId: string) => void;
  /** Resolves when every job queued for this user so far has run. */
  idle?: (userId: string) => Promise<void>;
}

type RpcResult = { error: { code?: string } | null };
type RpcCall = (name: string, args: Record<string, unknown> | undefined, signal: AbortSignal) => Promise<RpcResult>;

export interface PilotServiceOptions {
  now?: () => number;
  appVersion?: () => string;
  /** The RPC as the signed-in Supabase user. */
  rpc?: RpcCall;
  /** The Supabase auth user the RPC runs as (null = signed out). */
  authUserId?: () => Promise<string | null>;
  featureState?: () => Promise<"allowed" | "blocked" | "unknown">;
  setTimer?: (fn: () => void, ms: number) => void;
  timeoutMs?: number;
}

const defaultRpc: RpcCall = async (name, args, signal) =>
  (await supabaseService
    .getClient()
    .rpc(name, args)
    .abortSignal(signal)) as unknown as RpcResult;

async function defaultAuthUserId(): Promise<string | null> {
  try {
    return (await supabaseService.getAuthSession())?.userId ?? null;
  } catch {
    return null;
  }
}

function unrefTimer(fn: () => void, ms: number): void {
  const t = setTimeout(fn, ms);
  (t as { unref?: () => void }).unref?.();
}

/**
 * A class so each job is its own unit for the write-atomicity guard
 * (BACKLOG-2530): every job issues at most ONE local write on any path, and the
 * jobs run at different times around awaited RPCs, so no transaction could
 * span them anyway.
 */
export class LearnPilotReportService {
  private readonly now: () => number;
  private readonly appVersion: () => string;
  private readonly rpc: RpcCall;
  private readonly authUserId: () => Promise<string | null>;
  private readonly featureState: () => Promise<"allowed" | "blocked" | "unknown">;
  private readonly setTimer: (fn: () => void, ms: number) => void;
  private readonly timeoutMs: number;
  private readonly queues = new Map<string, Promise<void>>();
  private lastUser: string | null = null;
  private lastCheckMs = 0;

  constructor(opts: PilotServiceOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.appVersion = opts.appVersion ?? (() => app.getVersion());
    this.rpc = opts.rpc ?? defaultRpc;
    this.authUserId = opts.authUserId ?? defaultAuthUserId;
    this.featureState = opts.featureState ?? (() => resolveStrictFeatureState(AUTODETECT_EVAL_FEATURE_KEY));
    this.setTimer = opts.setTimer ?? unrefTimer;
    this.timeoutMs = opts.timeoutMs ?? PILOT_RPC_TIMEOUT_MS;
  }

  private enqueue(userId: string, job: () => Promise<void>): Promise<void> {
    const prev = this.queues.get(userId) ?? Promise.resolve();
    const next = prev.then(job).catch((error: unknown) => {
      logService.warn("Learn pilot job failed", MODULE, {
        errorName: error instanceof Error ? error.name : typeof error,
      });
    });
    this.queues.set(userId, next);
    void next.then(() => {
      if (this.queues.get(userId) === next) this.queues.delete(userId);
    });
    return next;
  }

  /** "timeout" when the call did not settle in time (it was aborted, but may have landed). */
  private async call(name: string, args?: Record<string, unknown>): Promise<RpcResult | "timeout"> {
    const ac = new AbortController();
    const TIMED_OUT = Symbol("timeout");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), this.timeoutMs);
      (timer as { unref?: () => void }).unref?.();
    });
    try {
      const r = await Promise.race([this.rpc(name, args, ac.signal), timeout]);
      if (r === TIMED_OUT) {
        ac.abort();
        return "timeout";
      }
      return r;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Sharing is ON and no withdraw is owed. The ONE check both reads use. */
  private sharingOn(st: { enabled: boolean; pendingWithdraw: boolean }): boolean {
    return st.enabled && !st.pendingWithdraw;
  }

  private isDue(userId: string, version: number, sentVersions: Record<string, string>): boolean {
    const last = sentVersions[String(version)];
    if (!last) return true;
    const lastMs = Date.parse(last);
    const age = this.now() - lastMs;
    if (age < PILOT_MIN_RESEND_MS) return false;
    if (age >= PILOT_IDLE_RESEND_MS) return true;
    const latest = latestAnswerAt(userId);
    return latest !== null && Date.parse(latest) > lastMs;
  }

  private recordSent(userId: string, version: number): void {
    const map = { ...getPilotState(userId).sentVersions, [String(version)]: new Date(this.now()).toISOString() };
    const kept = Object.entries(map)
      .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
      .slice(0, PILOT_MAX_SENT_VERSIONS);
    setPilotSentVersions(userId, Object.fromEntries(kept));
  }

  private async submitJob(userId: string, score: LearnScore, detector: SenderCensus): Promise<void> {
    const before = getPilotState(userId);
    if (!this.sharingOn(before)) return;
    if (!this.isDue(userId, score.senderRulesVersion, before.sentVersions)) return;
    const built = buildPilotReport(score, detector, this.appVersion());
    if (!built.ok) {
      logService.warn("Learn pilot report not built", MODULE, { reason: built.reason });
      return;
    }
    if ((await this.authUserId()) !== userId) return;
    // R1: re-read immediately before the RPC; a switch-off since then wins.
    if (!this.sharingOn(getPilotState(userId))) return;
    const r = await this.call(SUBMIT_RPC, { p_report: built.report });
    if (r === "timeout") {
      setPilotUnsettledAt(userId, new Date(this.now()).toISOString());
      logService.warn("Learn pilot submit timed out", MODULE, {});
      return;
    }
    if (r.error) {
      logService.warn("Learn pilot submit refused", MODULE, { code: r.error.code ?? "unknown" });
      return;
    }
    this.recordSent(userId, score.senderRulesVersion);
    logService.info("Learn pilot report sent", MODULE, { senderRulesVersion: score.senderRulesVersion });
  }

  private async withdrawJob(userId: string, extra: boolean): Promise<void> {
    const st = getPilotState(userId);
    if (extra ? st.enabled : !st.pendingWithdraw) return;
    // A withdraw deletes the CALLER's rows: only ever as the user who owes it.
    if ((await this.authUserId()) !== userId) return;
    const r = await this.call(WITHDRAW_RPC);
    if (r === "timeout" || r.error) {
      logService.warn("Learn pilot withdraw not done", MODULE, {
        code: r === "timeout" ? "timeout" : (r.error?.code ?? "unknown"),
      });
      return;
    }
    if (extra) return;
    const unsettled = getPilotState(userId).unsettledAt !== null;
    markPilotWithdrawDone(userId); // also clears the unsettled mark (one statement)
    logService.info("Learn pilot report withdrawn", MODULE, {});
    if (unsettled) {
      this.setTimer(() => void this.enqueue(userId, () => this.withdrawJob(userId, true)), PILOT_EXTRA_WITHDRAW_MS);
    }
  }

  maybeSend(userId: string, score: LearnScore, detector: SenderCensus): Promise<void> {
    return this.enqueue(userId, () => this.submitJob(userId, score, detector));
  }

  queueWithdraw(userId: string): Promise<void> {
    return this.enqueue(userId, () => this.withdrawJob(userId, false));
  }

  /** R3: the startup / sign-in check, for the signed-in user only. */
  async checkPendingPilotWork(userId: string): Promise<void> {
    if ((await this.authUserId()) !== userId) return;
    if (getPilotState(userId).enabled && (await this.featureState()) === "blocked") {
      setPilotOffPending(userId);
      logService.info("Learn pilot sharing turned off: feature not allowed", MODULE, {});
    }
    // Owed withdraws are paid even if sharing was turned back on since: the
    // submit refuses to run while one is owed, so the delete always goes first.
    if (getPilotState(userId).pendingWithdraw) await this.queueWithdraw(userId);
  }

  /** One session tick: a new signed-in user is a sign-in; an owed withdraw is retried every 5 min. */
  async tick(): Promise<void> {
    const u = await this.authUserId();
    const changed = u !== this.lastUser;
    this.lastUser = u;
    if (!u) return;
    if (changed || (getPilotState(u).pendingWithdraw && this.now() - this.lastCheckMs >= PILOT_RETRY_MS)) {
      this.lastCheckMs = this.now();
      await this.checkPendingPilotWork(u);
    }
  }

  /**
   * Resolves when every queued job of this user has run. Used by
   * learn:get-state `{ settle: true }` (capped there) and by tests.
   */
  idle(userId: string): Promise<void> {
    return this.queues.get(userId) ?? Promise.resolve();
  }
}

export function createLearnPilotReportService(opts: PilotServiceOptions = {}): LearnPilotReportService {
  return new LearnPilotReportService(opts);
}

let started = false;

/** Called once from electron/main.ts. A no-op under jest unless `force`. */
export function startLearnPilotReportService(
  service: LearnPilotReportService,
  deps: { force?: boolean } = {},
): void {
  if (started) return;
  if (process.env.NODE_ENV === "test" && !deps.force) return;
  started = true;
  const runTick = () => void service.tick().catch(() => undefined);
  setTimeout(() => {
    runTick();
    const every = setInterval(runTick, PILOT_SESSION_TICK_MS);
    (every as { unref?: () => void }).unref?.();
  }, PILOT_FIRST_CHECK_MS);
}
