/**
 * At-rest startup runner (BACKLOG-3816 S0).
 *
 * An ordered queue of background jobs that run once per launch, after the local
 * database is open. Other slices register their jobs here; S0 registers the data
 * key job and a placeholder for each slice that has not landed yet.
 *
 *   order  id                    owner
 *   ─────  ────────────────────  ─────
 *     0    data-key              S0  — open or create the file-data key
 *    10    logs                  S5  — retain/scrub/seal log files, then start sealing new lines
 *    20    temp-sweep            S6  — remove stale app-owned temp files
 *    30    attachments           S3  — encrypt message attachments
 *    40    email-attachments     S3  — encrypt email attachments
 *    50    backups               S4  — iPhone backup at rest
 *    60    legacy-sweep          S6  — remove the legacy magic-audit directories (LAST)
 *
 * Filling a placeholder is one line in registerDefaultJobs, e.g.
 *   startup.register({ id: "temp-sweep", order: 20, run: async () => { await runTempSweep(); } });
 * The slice that merges SECOND (once S0 and its own module are both on the branch)
 * adds its import and that line in place of the placeholder call.
 *
 * A slice replaces a placeholder by registering the same id. Jobs run one at a
 * time in order. A failing job is logged and the queue moves on — no job may
 * block the app, and no job may assume an earlier one succeeded (a writer that
 * finds the data key unavailable fails closed on its own).
 *
 * ## Why it polls
 *
 * The database is opened from the renderer (the KeychainExplanation step calls
 * `system:initialize-secure-storage`), well after `app.whenReady`. The init
 * broadcaster's `whenDbReady()` resolves `{ ready: false }` at once while the stage
 * is still `idle` (BACKLOG-2171), so it cannot be used to wait from `whenReady`.
 * {@link AtRestStartup.scheduleAfterDbReady} therefore checks an injected readiness
 * probe on an unref'd interval and runs the queue once, the first time it is true.
 * Waiting for the database also means the keychain has already been consented to,
 * so opening the data key cannot raise an unexplained keychain prompt.
 */
import { hostLogger } from "../../capabilities/loggerProvider";
import { DataKeyUnavailableError, getDataKeyService } from "./dataKeyService";
import { getConfiguredLogDirectory, runConfiguredLogMaintenance, runDeferredLogRetention } from "../logScrub";
import { getLogSink, isLogSealingEnabled } from "../sealedLogSink";
import type { AtRestKey } from "./fileCrypto";
import { runLegacySweep } from "./legacySweep";
import { SCOPE_EMAIL_ATTACHMENTS, SCOPE_MESSAGE_ATTACHMENTS } from "./markers";
import { getAtRestMigration } from "./migration";
import { runTempSweep } from "./tempSweep";

export interface AtRestJobContext {
  log: (level: "info" | "warn" | "error", message: string) => void;
}

export interface AtRestJob {
  id: string;
  order: number;
  run(ctx: AtRestJobContext): Promise<void>;
  /** true = placeholder; a registration with the same id replaces it. */
  placeholder?: boolean;
}

export interface AtRestJobOutcome {
  id: string;
  status: "ok" | "failed" | "placeholder";
  ms: number;
  error?: string;
}

export interface AtRestStartupDeps {
  log?: (level: "info" | "warn" | "error", message: string) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export class AtRestStartup {
  private readonly jobs = new Map<string, AtRestJob>();
  private runPromise: Promise<AtRestJobOutcome[]> | null = null;
  private pollHandle: unknown = null;
  private readonly log: (level: "info" | "warn" | "error", message: string) => void;

  constructor(private readonly deps: AtRestStartupDeps = {}) {
    this.log = deps.log ?? ((level, message) => hostLogger[level](message));
  }

  register(job: AtRestJob): void {
    const existing = this.jobs.get(job.id);
    if (existing && !existing.placeholder) {
      throw new Error(`at-rest job "${job.id}" is already registered`);
    }
    if (this.runPromise) {
      this.log("warn", `[AtRest] job "${job.id}" registered after the queue started; it runs next launch`);
    }
    this.jobs.set(job.id, job);
  }

  /** Job ids in run order. */
  listJobs(): Array<{ id: string; order: number; placeholder: boolean }> {
    return this.ordered().map((j) => ({ id: j.id, order: j.order, placeholder: !!j.placeholder }));
  }

  private ordered(): AtRestJob[] {
    return [...this.jobs.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }

  /** Runs the queue once per process. Later calls return the first run's promise. Never rejects. */
  run(): Promise<AtRestJobOutcome[]> {
    if (!this.runPromise) this.runPromise = this.runQueue();
    return this.runPromise;
  }

  private async runQueue(): Promise<AtRestJobOutcome[]> {
    const outcomes: AtRestJobOutcome[] = [];
    const ctx: AtRestJobContext = { log: this.log };
    for (const job of this.ordered()) {
      const started = Date.now();
      if (job.placeholder) {
        outcomes.push({ id: job.id, status: "placeholder", ms: 0 });
        continue;
      }
      try {
        await job.run(ctx);
        outcomes.push({ id: job.id, status: "ok", ms: Date.now() - started });
      } catch (error) {
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        this.log("error", `[AtRest] job "${job.id}" failed: ${message}`);
        outcomes.push({ id: job.id, status: "failed", ms: Date.now() - started, error: message });
      }
    }
    this.log(
      "info",
      `[AtRest] startup queue finished: ${outcomes.map((o) => `${o.id}=${o.status}`).join(", ")}`,
    );
    return outcomes;
  }

  /**
   * Run the queue once `isReady()` first returns true, checking every `pollMs`.
   * Idempotent: a second call while waiting (or after running) does nothing.
   */
  scheduleAfterDbReady(isReady: () => boolean, pollMs = 1000): void {
    if (this.pollHandle || this.runPromise) return;
    const setI = this.deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
    const clearI = this.deps.clearInterval ?? ((h: unknown) => clearInterval(h as NodeJS.Timeout));
    const check = () => {
      let ready = false;
      try {
        ready = isReady();
      } catch {
        ready = false;
      }
      if (!ready) return;
      if (this.pollHandle) clearI(this.pollHandle);
      this.pollHandle = null;
      void this.run();
    };
    this.pollHandle = setI(check, pollMs);
    const handle = this.pollHandle as { unref?: () => void } | null;
    if (handle && typeof handle.unref === "function") handle.unref();
    check();
  }
}

const placeholder = (id: string, order: number, slice: string): AtRestJob => ({
  id,
  order,
  placeholder: true,
  run: async () => {
    throw new Error(`at-rest job "${id}" is a placeholder (${slice})`);
  },
});

/** How long after the logs job a deferred log-retention pass runs (window is up by then). */
export const DEFERRED_LOG_WORK_DELAY_MS = 60_000;

const defaultLogWorkScheduler = (fn: () => Promise<void>): void => {
  const t = setTimeout(() => {
    fn().catch(() => undefined);
  }, DEFERRED_LOG_WORK_DELAY_MS) as { unref?: () => void };
  if (typeof t.unref === "function") t.unref();
};
let scheduleDeferredLogWork: (fn: () => Promise<void>) => void = defaultLogWorkScheduler;

/** Tests only: capture deferred log work instead of running it on a timer. */
export function setDeferredLogWorkSchedulerForTests(fn: ((work: () => Promise<void>) => void) | null): void {
  scheduleDeferredLogWork = fn ?? defaultLogWorkScheduler;
}

/** Registers the S0 data-key job and a placeholder for every slice still to land. */
export function registerDefaultJobs(startup: AtRestStartup): void {
  startup.register({
    id: "data-key",
    order: 0,
    run: async (ctx) => {
      try {
        const { keyId } = await getDataKeyService().currentKey();
        ctx.log("info", `[AtRest] data key ready (keyId ${keyId})`);
      } catch (error) {
        if (error instanceof DataKeyUnavailableError) {
          // Writers fail closed on their own; the later jobs still get to run.
          ctx.log("error", `[AtRest] data key unavailable — writers will refuse to write: ${error.message}`);
          return;
        }
        throw error;
      }
    },
  });
  startup.register({
    id: "logs",
    order: 10,
    run: async (ctx) => {
      // BACKLOG-3819: logs are sealed at rest. The data-key job above swallows an
      // unavailable key, so ask again here. Order matters: maintenance (seal old
      // plaintext, merge main.unsealed.log) runs BEFORE the sink starts sealing,
      // and nothing awaits between the two, so no line lands mid-replacement.
      const sink = getLogSink();
      if (!isLogSealingEnabled()) {
        // Dev build (BACKLOG-3819, dc27e73c): logs stay redacted plaintext. No key,
        // so maintenance only retains + redacts and never seals; the sink is unused.
        const plain = runConfiguredLogMaintenance(Date.now(), { key: null });
        if (!plain) return ctx.log("warn", "[AtRest] logs: no log directory registered; skipped");
        return ctx.log(
          plain.errors.length ? "warn" : "info",
          `[AtRest] logs: sealing off (dev build); rewritten ${plain.rewritten.length}, ` +
            `deleted ${plain.deleted.length}, errors ${plain.errors.length}`,
        );
      }
      let key: AtRestKey | null = null;
      try {
        key = await getDataKeyService().currentKey();
      } catch (error) {
        if (!(error instanceof DataKeyUnavailableError)) throw error;
        sink.fallbackToPlaintext(error.message);
      }
      let r: ReturnType<typeof runConfiguredLogMaintenance> = null;
      try {
        r = runConfiguredLogMaintenance(Date.now(), {
          key,
          onReplaced: (f) => sink.forget(f),
          deferSealedRewrites: true,
        });
      } finally {
        if (key) sink.activate(key);
      }
      if (!r) return ctx.log("warn", "[AtRest] logs: no log directory registered; skipped");
      if (r.deferred.length > 0) {
        // Retention on a sealed file = decrypt + reseal of up to 8 MB. Run it later,
        // off the launch path, and without blocking: one file at a time, in slices
        // that yield to the event loop (logScrub.trimSealedLogAsync). The sink holds
        // new lines in memory meanwhile, so nothing is appended to a file while it
        // is being replaced; every replaced file is forgotten before writes resume.
        const deferred = [...r.deferred];
        const logDir = getConfiguredLogDirectory();
        scheduleDeferredLogWork(async () => {
          const current = sink.currentKey;
          if (!current || !logDir) return;
          sink.pause();
          let later: Awaited<ReturnType<typeof runDeferredLogRetention>> | null = null;
          try {
            later = await runDeferredLogRetention(logDir, deferred, Date.now(), current, {
              onReplaced: (f) => sink.forget(f),
              shouldAbort: () => sink.isClosing,
            });
          } finally {
            sink.resume();
          }
          ctx.log(
            later.errors.length ? "warn" : "info",
            `[AtRest] logs (deferred retention): rewritten ${later.rewritten.length}, ` +
              `deleted ${later.deleted.length}, errors ${later.errors.length}`,
          );
        });
      }
      ctx.log(
        r.errors.length ? "warn" : "info",
        `[AtRest] logs: sealing ${key ? "on" : "UNAVAILABLE (redacted plaintext this run)"}; ` +
          `rewritten ${r.rewritten.length}, sealed ${r.sealed.length}, deleted ${r.deleted.length}, ` +
          `unreadable ${r.unreadable.length}, deferred ${r.deferred.length}, errors ${r.errors.length}`,
      );
    },
  });
  startup.register({ id: "temp-sweep", order: 20, run: async () => { await runTempSweep(); } });
  startup.register({ id: "attachments", order: 30, run: async () => { await getAtRestMigration().runScope(SCOPE_MESSAGE_ATTACHMENTS); } });
  startup.register({ id: "email-attachments", order: 40, run: async () => { await getAtRestMigration().runScope(SCOPE_EMAIL_ATTACHMENTS); } });
  startup.register(placeholder("backups", 50, "S4"));
  startup.register({ id: "legacy-sweep", order: 60, run: async () => { await runLegacySweep(); } });
}

export const atRestStartup = new AtRestStartup();
registerDefaultJobs(atRestStartup);
