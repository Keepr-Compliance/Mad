/**
 * Support access mode — production wiring (BACKLOG-2393)
 *
 * The pieces are constructed with injected dependencies so they can be tested
 * without Electron, a clock, or a network. This module is the one place that
 * knows the real ones.
 */

import { app } from "electron";
import * as path from "path";
import logService from "../logService";
import sessionService from "../sessionService";
import supabaseService from "../supabaseService";
import { collectDiagnostics } from "../supportTicketService";
import { SupportAccessService } from "./supportAccessService";
import { SupportLogStore } from "./supportLogStore";
import { SupportReportQueue } from "./supportReportQueue";
import { SupportUploadScheduler } from "./supportUploadScheduler";
import { SupabaseSupportTransport } from "./supabaseSupportTransport";
import type { SupportLogScopeId } from "./scopes";

export * from "./types";
export * from "./scopes";
export * from "./disclosure";
export { SupportAccessService } from "./supportAccessService";
export { SupportLogStore } from "./supportLogStore";
export { SupportReportQueue } from "./supportReportQueue";
export { SupportUploadScheduler } from "./supportUploadScheduler";
export { SupabaseSupportTransport } from "./supabaseSupportTransport";

const MODULE = "SupportAccess";

function bridgeLog(
  level: "info" | "warn" | "error",
  message: string,
): void {
  if (level === "error") logService.error(message, MODULE);
  else if (level === "warn") logService.warn(message, MODULE);
  else logService.info(message, MODULE);
}

interface SupportAccessBundle {
  access: SupportAccessService;
  logStore: SupportLogStore;
  queue: SupportReportQueue;
  scheduler: SupportUploadScheduler;
}

let bundle: SupportAccessBundle | null = null;

function build(): SupportAccessBundle {
  const baseDir = path.join(app.getPath("userData"), "support-access");
  const now = () => Date.now();

  const access = new SupportAccessService({
    now,
    baseDir,
    appVersion: () => app.getVersion(),
    log: bridgeLog,
  });

  const logStore = new SupportLogStore({
    now,
    baseDir,
    isScopeActive: (scope) => access.isScopeActive(scope),
    log: bridgeLog,
  });

  const queue = new SupportReportQueue({
    now,
    baseDir,
    logStore,
    collectDiagnostics: () => collectDiagnostics(),
    getConsent: () => (access.isActive() ? access.getConsentRecord() : null),
    log: bridgeLog,
  });

  const transport = new SupabaseSupportTransport({
    getClient: () => supabaseService.getClient(),
    getRequester: async () => {
      const session = await sessionService.loadSession();
      const user = session?.user as
        | { email?: string; display_name?: string; first_name?: string; last_name?: string }
        | undefined;
      if (!user?.email) return null;
      const name =
        user.display_name ||
        [user.first_name, user.last_name].filter(Boolean).join(" ") ||
        user.email;
      return { email: user.email, name };
    },
    baseDir,
    describeGrant: (consentId) => {
      const consent = access.findConsent(consentId);
      if (!consent) return "Support access window";
      return `${new Date(consent.grantedAt).toLocaleDateString()} (${consent.durationId})`;
    },
    log: bridgeLog,
  });

  const scheduler = new SupportUploadScheduler({
    now,
    access,
    queue,
    transport,
    log: bridgeLog,
  });

  return { access, logStore, queue, scheduler };
}

export function getSupportAccess(): SupportAccessBundle {
  if (!bundle) bundle = build();
  return bundle;
}

/**
 * Called once at startup. Loads persisted state and, if a granted window is
 * still open, restarts the upload schedule.
 *
 * There is nothing to "restore" about the deadline itself — it is an absolute
 * instant on disk, so it is already correct before this runs.
 */
export async function initializeSupportAccess(): Promise<void> {
  const { access, scheduler, queue } = getSupportAccess();
  await access.load();
  await queue.purgeExpired();
  if (await access.reconcile()) {
    bridgeLog("info", "Support access window had expired while the app was closed");
  }
  if (access.isActive()) {
    const state = access.getState();
    bridgeLog(
      "info",
      `Support access is active until ${state.consent?.expiresAt} (${Math.round(state.msRemaining / 3600000)}h remaining)`,
    );
    scheduler.start();
  }
  access.onChange((state) => {
    if (state.active) scheduler.start();
    else scheduler.stop();
  });
}

/**
 * Record one scoped diagnostic event. A no-op outside the window or outside the
 * granted scopes, so callers can drop these in without their own guard.
 */
export function supportTrace(
  scope: SupportLogScopeId,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const { logStore } = getSupportAccess();
  void logStore.write(scope, event, fields).catch(() => undefined);
}

/** True when a scope is granted and the window is open. */
export function isSupportScopeActive(scope: SupportLogScopeId): boolean {
  return getSupportAccess().access.isScopeActive(scope);
}

/** Trigger an on-error capture. Debounced, and a no-op outside the window. */
export function notifySupportAccessError(): void {
  void getSupportAccess().scheduler.notifyError().catch(() => undefined);
}

/** Test seam — drop the singleton so a suite can rebuild it. */
export function _resetSupportAccessForTests(): void {
  bundle?.scheduler.stop();
  bundle = null;
}
