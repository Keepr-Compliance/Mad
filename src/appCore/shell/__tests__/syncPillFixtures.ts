/**
 * BACKLOG-4115 PR-3: producer-shaped fixtures for the title-bar sync pill.
 *
 * iPhone BASE is TRANSCRIBED, not invented: one real return of
 * useIPhoneSync(true) under renderHook (macOS platform mock, no device), its
 * non-function fields pasted verbatim (scratchpad/4115/iphone-capture.json,
 * develop-lane base b43863f9b). Each state then changes only the fields the
 * hook's own setters change for it (useIPhoneSync.ts line refs per state).
 *
 * Android: RcsExtensionState in the shape rcs-import:get-extension-state
 * returns (electron/handlers/rcsImportHandlers.ts:1515-1545); RcsJobInfo in the
 * shape RcsImportJob.snapshot() returns (electron/services/rcsImportJob.ts:311); bridge reason literal from
 * electron/services/rcsExtensionBridge.ts:724-727;
 * stage literals from rcsImportJob.ts:262 / :399.
 */
import type { IPhonePillInput } from "../syncPillState";
import type { RcsExtensionState, RcsImportStatus, RcsJobInfo } from "../../../../electron/types/ipc/window-api-rcs-import";

/** Fixed clock for every fixture. */
export const NOW = Date.parse("2026-11-03T15:00:00.000Z");

export const IPHONE_BASE: IPhonePillInput = {
  isConnected: false,
  syncStatus: "idle",
  progress: null,
  appleEncryptedBackup: false,
  lastSyncTime: null,
  isWaitingForPasscode: false,
  syncLocked: false,
  lockReason: null,
  needsTrust: false,
  toolsMissing: false,
  driverMissing: false,
  retryAvailableAt: null,
};

const iphone = (over: Partial<IPhonePillInput>): IPhonePillInput => ({ ...IPHONE_BASE, ...over });
const PROGRESS = { phase: "backing_up" as const, percent: 42 };

/** One fixture per shipped iPhone state. `enabled` = detection on unless named. */
export const IPHONE_STATES: Record<string, { sync: IPhonePillInput; enabled: boolean }> = {
  // syncStatus "syncing" + onProgress (useIPhoneSync.ts:1229, progress events)
  syncing: { sync: iphone({ syncStatus: "syncing", progress: PROGRESS, isConnected: true }), enabled: true },
  // onWaitingForPasscode sets the flag AND progress during a sync (:548-558)
  passcode: {
    sync: iphone({ syncStatus: "syncing", progress: { phase: "backing_up", percent: 0 }, isWaitingForPasscode: true, isConnected: true }),
    enabled: true,
  },
  // complete keeps progress until dismissSync (:696 lastSyncTime = now)
  complete: {
    sync: iphone({ syncStatus: "complete", progress: { phase: "complete", percent: 100 }, isConnected: true, lastSyncTime: new Date(NOW) }),
    enabled: true,
  },
  // setAppleEncryptedBackup(true) then failStart -> "error" (:1296-1302)
  appleEncrypted: { sync: iphone({ syncStatus: "error", appleEncryptedBackup: true, isConnected: true }), enabled: true },
  // failure with the 30 s hold (:240 retryAvailableAt = now + 30 000)
  errorCooldown: { sync: iphone({ syncStatus: "error", isConnected: true, retryAvailableAt: NOW + 30_000 }), enabled: true },
  errorNoHold: { sync: iphone({ syncStatus: "error", isConnected: true }), enabled: true },
  // onNeedsTrust (:804-806)
  trust: { sync: iphone({ needsTrust: true }), enabled: true },
  // Windows driver probe (:1161)
  driverMissing: { sync: iphone({ driverMissing: true }), enabled: true },
  // onToolsMissing (:821)
  toolsMissing: { sync: iphone({ toolsMissing: true }), enabled: true },
  // lock from getUnifiedStatus (:280 lockReason = status.currentOperation;
  // literal from electron/services/syncStatusService.ts:68)
  locked: { sync: iphone({ syncLocked: true, lockReason: "Cleaning up the unfinished iPhone backup" }), enabled: true },
  // SR B2: resolveIphoneSyncEnabled(false, platform, "iphone-sync") === false
  detectionOff: { sync: iphone({}), enabled: false },
  // onDeviceConnected (:371)
  connectedIdle: { sync: iphone({ isConnected: true }), enabled: true },
  // backup status lastSyncTime (:394), two hours before NOW
  syncedBefore: { sync: iphone({ lastSyncTime: new Date(NOW - 2 * 3600_000) }), enabled: true },
  // the captured return itself
  notConnected: { sync: iphone({}), enabled: true },
};

export const EXT_BASE: RcsExtensionState = {
  extensionVersion: "0.3.80",
  extensionUpdateReady: false,
  extensionSeenAt: new Date(NOW - 60_000).toISOString(),
  pairedAt: "2026-10-20T10:00:00.000Z",
  optedIn: true,
  lastCacheFinishedAt: null,
  consentVersion: 1,
  consentRequired: 1,
  consentAt: "2026-10-20T10:01:00.000Z",
  autoDeleteDays: null,
  lookbackMonths: 6,
  media: { photosAllChats: false, videosAllChats: false, lastPhotosSeen: null, lastVideosSeen: null },
  extensionPaired: true,
  pairingSaved: true,
  linkNotHere: false,
  companionData: false,
};
export const ext = (over: Partial<RcsExtensionState>): RcsExtensionState => ({ ...EXT_BASE, ...over });

export const LISTENING: RcsImportStatus = { bridge: "listening", port: 38619 };
export const UNAVAILABLE: RcsImportStatus = { bridge: "unavailable", port: 38619, reason: "Port 38619 is already in use" };

const COUNTS = { listed: 0, candidates: 0, checked: 0, matched: 0, imported: 0, messages: 0, images: 0, reactions: 0, skipped: 0 };
export const job = (over: Partial<RcsJobInfo>): RcsJobInfo => ({
  jobId: "job-1",
  state: "running",
  stage: "Saving your recent chats",
  progress: { ...COUNTS },
  createdAt: new Date(NOW - 120_000).toISOString(),
  kind: "cache",
  ...over,
});
