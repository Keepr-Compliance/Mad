/**
 * Support access mode — production wiring (BACKLOG-2393)
 *
 * The pieces are constructed with injected dependencies so they can be tested
 * without Electron, a clock, or a network. This module is the one place that
 * knows the real ones.
 */

import { app } from "electron";
import * as path from "path";
import keychainGate from "../keychainGate";
import logService from "../logService";
import sessionService from "../sessionService";
import supabaseService from "../supabaseService";
import { collectDiagnostics } from "../supportTicketService";
import { SupportAccessService } from "./supportAccessService";
import { SupportLogStore } from "./supportLogStore";
import { SupportReportQueue } from "./supportReportQueue";
import { SupportUploadScheduler } from "./supportUploadScheduler";
import { SupabaseSupportTransport } from "./supabaseSupportTransport";
import {
  createAesGcmCipher,
  createKeychainKeyProvider,
  type SupportCipher,
} from "./supportCipher";
import { registerSupportTraceSink } from "./trace";

export * from "./types";
export * from "./scopes";
export * from "./disclosure";
export { SupportAccessService } from "./supportAccessService";
export { SupportLogStore } from "./supportLogStore";
export { SupportReportQueue } from "./supportReportQueue";
export { SupportUploadScheduler } from "./supportUploadScheduler";
export { SupabaseSupportTransport } from "./supabaseSupportTransport";
export {
  createAesGcmCipher,
  createKeychainKeyProvider,
  SupportCipherUnavailableError,
} from "./supportCipher";
export type { SupportCipher } from "./supportCipher";
export {
  supportTrace,
  isSupportScopeActive,
  notifySupportError,
  registerSupportTraceSink,
} from "./trace";

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
  cipher: SupportCipher;
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

  // Encryption at rest. The key is resolved lazily on first use, not here:
  // this runs at startup and `keychainGate` stays locked until the user has
  // passed the secure-storage step, so touching the keychain now would either
  // throw or raise a prompt before the app is entitled to one.
  const cipher = createAesGcmCipher(
    createKeychainKeyProvider({
      baseDir,
      isEncryptionAvailable: () => keychainGate.isEncryptionAvailable(),
      sealString: (plaintext) => keychainGate.encryptString(plaintext),
      openString: (sealed) => keychainGate.decryptString(sealed),
      log: bridgeLog,
    }),
  );

  const logStore = new SupportLogStore({
    now,
    baseDir,
    isScopeActive: (scope) => access.isScopeActive(scope),
    currentConsentId: () =>
      access.isActive() ? (access.getConsentRecord()?.id ?? null) : null,
    cipher,
    log: bridgeLog,
  });

  const queue = new SupportReportQueue({
    now,
    baseDir,
    logStore,
    cipher,
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

  // However a window ends — revoked by hand or simply run out — the scoped log
  // goes with it. Registered here rather than in the revoke handler, which is
  // where it used to live and why expiry leaked into the next grant.
  access.onEnd(async (reason) => {
    await logStore.clear();
    bridgeLog("info", `Support access ${reason}; scoped diagnostic log cleared`);
  });

  return { access, logStore, queue, scheduler, cipher };
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
  const { access, scheduler, logStore } = getSupportAccess();
  await access.load();

  // Producers call through supportAccess/trace, which is inert until this
  // point. Registering only after state has been read means there is no window
  // in which a stale in-memory default could let a write through.
  registerSupportTraceSink({
    write: (scope, event, fields) => {
      void logStore.write(scope, event, fields).catch(() => undefined);
    },
    isScopeActive: (scope) => access.isScopeActive(scope),
    notifyError: () => {
      void scheduler.notifyError().catch(() => undefined);
    },
  });

  // Reconcile first. It is what closes a window that lapsed while the app was
  // shut, and the end hook clears the scoped log — so this must run before
  // anything can capture a report that would otherwise carry the old window's
  // contacts into a new grant.
  if (await access.reconcile()) {
    bridgeLog("info", "Support access window had expired while the app was closed");
  }

  // Retention, both halves. Scheduled ticks only happen while a window is open,
  // so without this a deadline reached during a closed period would be enforced
  // by nothing on this side.
  await scheduler.purgeExpiredReports().catch((error) => {
    bridgeLog("warn", `Support report retention pass failed: ${String(error)}`);
    return undefined;
  });
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

/** Trigger an on-error capture. Debounced, and a no-op outside the window. */
export function notifySupportAccessError(): void {
  void getSupportAccess().scheduler.notifyError().catch(() => undefined);
}

/** Test seam — drop the singleton so a suite can rebuild it. */
export function _resetSupportAccessForTests(): void {
  bundle?.scheduler.stop();
  bundle = null;
  registerSupportTraceSink(null);
}
