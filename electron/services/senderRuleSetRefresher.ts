/**
 * Sender rule-set download — BACKLOG-4175 PR4 (main process only).
 *
 * Calls `sender_rule_set_current()` and hands the classified answer to the
 * portable store (`senderRuleSetStore.ts`). Only `electron/main.ts` imports
 * this module (a guard test enforces it): no consumer can await a download.
 *
 * Cadence: first tick 30 s after start, then every 6 h. Between ticks the
 * store's getter fires `maybeRefresh` at most once a minute; each run ALWAYS
 * reads the session (cached, no network) and reports it to the store, so an
 * account switch is seen within a minute, and only then applies the per-user
 * fetch throttle (6 h; 5 min after offline or a timeout). The 6 h tick goes
 * through the same throttle, so it never repeats a fetch a consumer just made.
 *
 * The session read and the RPC share one 10 s window; `inFlight` is cleared
 * in `finally`, so a hung call never blocks the next attempt.
 *
 * Sentry: two tags, the active version and its source. No content, no user data.
 */
import * as Sentry from "@sentry/electron/main";

import supabaseService from "./supabaseService";
import {
  applyServerOutcome,
  classifyServerAnswer,
  formatSenderRulesSource,
  getActiveSenderRules,
  noteSessionUser,
  setRefreshTrigger,
  shouldFetch,
  subscribe,
  type ActiveSenderRules,
  type RpcAnswer,
} from "./senderRuleSetStore";

export const FETCH_TIMEOUT_MS = 10_000;
const FIRST_TICK_MS = 30_000;
const TICK_MS = 6 * 60 * 60 * 1000;

let started = false;
let inFlight: Promise<void> | null = null;

function setTags(a: ActiveSenderRules): void {
  Sentry.setTag("sender_rules_version", String(a.version));
  Sentry.setTag("sender_rules_source", formatSenderRulesSource(a).replace(" (download rejected)", "_rejected"));
}

async function attempt(): Promise<void> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attemptUser: string | null | undefined;
  const TIMED_OUT = Symbol("timeout");
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), FETCH_TIMEOUT_MS);
    (timer as { unref?: () => void }).unref?.();
  });
  const work = (async (): Promise<RpcAnswer | null> => {
    const session = await supabaseService.getAuthSession();
    const userId = session?.userId ?? null;
    noteSessionUser(userId);
    if (!userId) return null;
    if (!shouldFetch(userId)) return null;
    attemptUser = userId;
    return (await supabaseService
      .getClient()
      .rpc("sender_rule_set_current")
      .abortSignal(ac.signal)) as unknown as RpcAnswer;
  })();
  try {
    const r = await Promise.race([work, timeout]);
    if (r === TIMED_OUT) {
      ac.abort();
      await applyServerOutcome(classifyServerAnswer(null, true), attemptUser);
      return;
    }
    if (r === null) return; // no session, or not due
    await applyServerOutcome(classifyServerAnswer(r, false), attemptUser);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One attempt (joins one already running). Never rejects. */
export function refreshNow(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = attempt()
    .catch(() => undefined)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Called once from electron/main.ts. A no-op under jest unless `force`. */
export function startSenderRuleSetRefresher(deps: { force?: boolean } = {}): void {
  if (started) return;
  if (process.env.NODE_ENV === "test" && !deps.force) return;
  started = true;
  subscribe(setTags);
  setTags(getActiveSenderRules());
  setRefreshTrigger(() => refreshNow());
  const first = setTimeout(() => {
    void refreshNow();
    const every = setInterval(() => void refreshNow(), TICK_MS);
    (every as { unref?: () => void }).unref?.();
  }, FIRST_TICK_MS);
  (first as { unref?: () => void }).unref?.();
}

/** Tests only. */
export function __resetRefresherForTests(): void {
  started = false;
  inFlight = null;
}
