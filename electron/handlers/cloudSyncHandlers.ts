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
] as const;

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
  const service = new CloudSyncService({
    db: () => getRawDatabase() as unknown as SqlDb,
    dbReady: () => databaseService.isInitialized(),
    client: new CloudClient(supabaseTransport),
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
  });
  registerCloudSyncHandlers(service);
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
