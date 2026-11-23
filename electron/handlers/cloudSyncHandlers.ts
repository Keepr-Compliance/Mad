// ============================================
// KEEPR CLOUD — IPC HANDLERS AND ENGINE ROOT (BACKLOG-4243 PR-1 + PR-2)
// ============================================
//
// `installCloudSync()` is the engine's root, called from main.ts at start. It
// registers the `cloud-sync:*` channels and, once the database is ready, runs
// one LOCAL check: a pass timer starts only when Keepr Cloud is on here. A user
// who never turned it on gets no timer and no network call from this file.
//
// Every action needs a validated session user that the Supabase SDK agrees
// with (cloudSyncService `actingUser`). Turning off is never refused for
// reasons other than a missing session.
import { app, ipcMain, net, powerMonitor, shell } from "electron";
import fs from "fs";
import path from "path";
import * as Sentry from "@sentry/electron/main";
import { CloudClient, type RpcTransport } from "../services/cloudSync/cloudClient";
import { CloudSyncService } from "../services/cloudSync/cloudSyncService";
import { CloudTodoScreens } from "../services/cloudSync/todoScreens";
import { sendToMainWindow } from "../windowRegistry";
import { devGuardReason, DEV_OVERRIDE_ENV, projectRefFromUrl } from "../services/cloudSync/environment";
import { SessionIdentity } from "../services/cloudSync/session";
import type { SqlDb } from "../services/db/cloudSyncSqlDb";
import { getRawDatabase } from "../services/db/core/dbConnection";
import databaseService from "../services/databaseService";
import { initializationBroadcaster } from "../services/initializationBroadcaster";
import supabaseService from "../services/supabaseService";
import sessionService from "../services/sessionService";
import sessionSecurityService from "../services/sessionSecurityService";
import { onSessionChanged } from "../services/authEvents";
import { getDeviceId } from "../services/deviceService";
import logService from "../services/logService";
import { recordDealRestoreAuditSync } from "../services/cloudSync/restoreAudit";
import { portalUrl } from "../utils/portalUrl";
import { isStrictFeatureAllowed } from "./featureGateHandlers";

const MODULE = "CloudSync";

export const CLOUD_SYNC_CHANNELS = [
  "cloud-sync:get-view",
  "cloud-sync:turn-on",
  "cloud-sync:confirm-computer",
  "cloud-sync:turn-off",
  "cloud-sync:forget-other-project",
  "cloud-sync:retry",
  "cloud-sync:open-ai-apps",
  "cloud-sync:delete-online-not-here",
  "cloud-sync:delete-old-installs",
  "cloud-sync:reclaim-install",
  "cloud-sync:use-this-computer",
  "cloud-sync:list-removed-deals",
  "cloud-sync:restore-deal",
  "cloud-sync:delete-deal-for-good",
  "cloud-sync:local-state",
  "cloud-sync:list-removed-online",
  "cloud-sync:restore-online-deal",
] as const;

/** BACKLOG-4263 PR-6: the todo screens (window.api.cloudTodos). */
export const CLOUD_TODOS_CHANNELS = [
  "cloud-todos:get-for-deal",
  "cloud-todos:dismiss-notice",
  "cloud-todos:history",
  "cloud-todos:list-removed",
  "cloud-todos:restore",
] as const;

/** An id a renderer sends (a string of sane length). */
function idArg(args: unknown, key: string): string | null {
  const v = (args as Record<string, unknown> | null)?.[key];
  return typeof v === "string" && v.length > 0 && v.length <= 200 ? v : null;
}

/** The transaction id a renderer sends (a string of sane length; main reads everything else itself). */
function transactionIdArg(args: unknown): string | null {
  const v = (args as { transactionId?: unknown } | null)?.transactionId;
  return typeof v === "string" && v.length > 0 && v.length <= 200 ? v : null;
}

/** BACKLOG-4263 PR-6: registers the todo screens' channels. */
export function registerCloudTodosHandlers(screens: CloudTodoScreens): void {
  ipcMain.handle("cloud-sync:local-state", () => screens.localState());
  ipcMain.handle("cloud-sync:list-removed-online", () => screens.listRemovedOnline());
  ipcMain.handle("cloud-sync:restore-online-deal", (_event, args: unknown) => {
    const id = idArg(args, "cloudId");
    return id ? screens.restoreOnlineDeal(id) : { success: false, error: "invalid_input" };
  });
  ipcMain.handle("cloud-todos:get-for-deal", (_event, args: unknown) => {
    const id = transactionIdArg(args);
    return id ? screens.forDeal(id) : { on: false, online: false, notices: [], markers: {} };
  });
  ipcMain.handle("cloud-todos:dismiss-notice", (_event, args: unknown) => {
    const n = (args as { noticeId?: unknown } | null)?.noticeId;
    return typeof n === "number" && Number.isInteger(n) && n > 0 ? screens.dismissNotice(n) : { success: false, error: "invalid_input" };
  });
  ipcMain.handle("cloud-todos:history", (_event, args: unknown) => {
    const id = idArg(args, "itemId");
    return id ? screens.history(id) : { success: false, error: "invalid_input", rows: [] };
  });
  ipcMain.handle("cloud-todos:list-removed", (_event, args: unknown) => {
    const id = transactionIdArg(args);
    return id ? screens.listRemovedTodos(id) : { success: false, error: "invalid_input", items: [] };
  });
  ipcMain.handle("cloud-todos:restore", (_event, args: unknown) => {
    const tx = transactionIdArg(args);
    const cloudId = idArg(args, "cloudId");
    const entity = (args as { entity?: unknown } | null)?.entity;
    if (!tx || !cloudId || (entity !== "item" && entity !== "checklist")) return { success: false, error: "invalid_input" };
    return screens.restoreTodo(tx, entity, cloudId);
  });
}

/** Registers the channels against one service. */
export function registerCloudSyncHandlers(service: CloudSyncService): void {
  ipcMain.handle("cloud-sync:get-view", () => service.getView());
  ipcMain.handle("cloud-sync:turn-on", (_event, args: unknown) => {
    const v = (args as { noticeVersion?: unknown } | null)?.noticeVersion;
    if (typeof v !== "number" || !Number.isInteger(v)) return { success: false, error: "invalid_input" };
    return service.turnOn(v);
  });
  ipcMain.handle("cloud-sync:confirm-computer", () => service.confirmComputer());
  ipcMain.handle("cloud-sync:turn-off", () => service.turnOff());
  ipcMain.handle("cloud-sync:forget-other-project", () => service.forgetOtherProject());
  ipcMain.handle("cloud-sync:retry", () => service.retry());
  ipcMain.handle("cloud-sync:open-ai-apps", () => service.openAiApps());
  ipcMain.handle("cloud-sync:delete-online-not-here", () => service.deleteOnlineNotHere());
  ipcMain.handle("cloud-sync:delete-old-installs", () => service.deleteOldInstalls());
  ipcMain.handle("cloud-sync:reclaim-install", () => service.reclaimInstall());
  ipcMain.handle("cloud-sync:use-this-computer", () => service.useThisComputer());
  // BACKLOG-4263 PR-4c: deals deleted on this computer, restorable 30 days (Settings › Keepr Cloud › Removed, PR-6).
  ipcMain.handle("cloud-sync:list-removed-deals", () => service.listRemovedDeals());
  ipcMain.handle("cloud-sync:restore-deal", (_event, args: unknown) => {
    const id = transactionIdArg(args);
    return id ? service.restoreDeal(id) : { success: false, error: "invalid_input" };
  });
  ipcMain.handle("cloud-sync:delete-deal-for-good", (_event, args: unknown) => {
    const id = transactionIdArg(args);
    return id ? service.deleteDealForGood(id) : { success: false, error: "invalid_input" };
  });
}

const supabaseTransport: RpcTransport = async (fn, args, signal) => {
  const res = await supabaseService.getClient().rpc(fn, args).abortSignal(signal);
  return {
    data: res.data,
    error: res.error ? { code: (res.error as { code?: unknown }).code } : null,
    status: res.status,
  };
};

function readProductionEnv(): string | null {
  try {
    return fs.readFileSync(path.join(app.getAppPath(), ".env.production"), "utf8");
  } catch {
    return null;
  }
}

let installed: CloudSyncService | null = null;

/**
 * The engine root. Idempotent. Never throws: a failure here logs one WARN and
 * leaves Keepr Cloud off for this launch; the rest of startup continues.
 */
export function installCloudSync(): CloudSyncService | null {
  if (installed) return installed;
  try {
    return installCloudSyncUnguarded();
  } catch (error) {
    void logService.warn("[CloudSync] Not installed this launch", MODULE, {
      code: error instanceof Error ? error.name : "unknown",
    });
    return null;
  }
}

function installCloudSyncUnguarded(): CloudSyncService {
  const identity = new SessionIdentity({
    loadSession: () => sessionService.loadSession(),
    getLastActivity: (token) => sessionSecurityService.getLastActivity(token),
    onSessionChanged,
  });
  const configuredUrl = process.env.SUPABASE_URL;
  const log = {
    info: (message: string, meta?: Record<string, unknown>) => void logService.info(message, MODULE, meta),
    warn: (message: string, meta?: Record<string, unknown>) => void logService.warn(message, MODULE, meta),
  };
  const client = new CloudClient(supabaseTransport);
  const service = new CloudSyncService({
    db: () => getRawDatabase() as unknown as SqlDb,
    dbReady: () => databaseService.isInitialized(),
    client,
    identity,
    getAuthUserId: () => supabaseService.getAuthUserId(),
    projectRef: projectRefFromUrl(configuredUrl),
    deviceId: () => getDeviceId(),
    blockedReason: () =>
      devGuardReason({
        isPackaged: app.isPackaged,
        configuredUrl,
        productionEnvText: app.isPackaged ? null : readProductionEnv(),
        devOverride: process.env[DEV_OVERRIDE_ENV],
      }),
    isOnline: () => net.isOnline(),
    cloudFeatureAllowed: async () =>
      (await isStrictFeatureAllowed("cloud_autosave")) || (await isStrictFeatureAllowed("cloud_autosave_assignable")),
    openAiApps: async () => {
      const url = portalUrl("aiApps");
      if (!url) return false;
      try {
        await shell.openExternal(url);
        return true;
      } catch {
        return false;
      }
    },
    aiAppsAvailable: () => portalUrl("aiApps") !== null,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
    log,
    reportFailure: (code) => {
      Sentry.captureMessage("cloud-sync pass failed", { tags: { code } });
    },
    // BACKLOG-4263 PR-4c (plan §14 F3): a restored deal is recorded as TRANSACTION_CREATE, inside the restore.
    auditRestore: recordDealRestoreAuditSync,
    // BACKLOG-4263 PR-6: open screens refresh when a pass changed todos here, or the server answered this computer's
    // todo changes.
    onTodosChanged: () => {
      sendToMainWindow("cloud-todos:changed");
    },
  });
  registerCloudSyncHandlers(service);
  registerCloudTodosHandlers(
    new CloudTodoScreens({
      db: () => getRawDatabase() as unknown as SqlDb,
      dbReady: () => databaseService.isInitialized(),
      client,
      projectRef: projectRefFromUrl(configuredUrl),
      sessionUser: () => service.sessionUser(),
      localSessionUser: () => service.localSessionUser(),
      isOnline: () => net.isOnline(),
      installId: () => service.installIdForScreens(),
      archivedDealIds: async () => new Set((await service.listRemovedDeals()).map((d) => d.transactionId)),
      onlineDealLocalIds: () => service.onlineDealLocalIds(),
      kick: () => service.kick(),
    }),
  );
  installed = service;

  // Local check only, once the database is open: a timer only when Keepr Cloud is on here.
  void (async () => {
    try {
      if (!databaseService.isInitialized()) {
        const ready = await initializationBroadcaster.whenDbReady();
        if (!ready.ready) return;
      }
      service.refreshSchedule();
    } catch {
      /* the next session event retries */
    }
  })();
  onSessionChanged(() => service.refreshSchedule());
  powerMonitor.on("resume", () => void service.kick());
  return service;
}

/** Tests only. */
export function resetCloudSyncForTests(): void {
  installed?.stop();
  installed = null;
}
