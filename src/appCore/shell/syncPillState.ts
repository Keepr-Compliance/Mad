/**
 * BACKLOG-4115 PR-3: what the title-bar device sync pill says. Pure — every
 * input is passed in, the clock included.
 *
 * Rule for the label (founder, FINAL WORDING): "iPhone · Sync now" /
 * "Android · Sync now" ONLY where a sync can start (`canStart`); every other
 * state is the device name (or a short status) + a dot + a tooltip.
 *
 * iPhone (SR B1): the top state is the sync flow's own view
 * (resolveIPhoneSyncView), so the pill never names a state the click does not
 * open. Android (SR B3): job steps come through orchestratorStepFor; the link
 * view through browserLinkView.
 */
import type { UseIPhoneSyncReturn } from "../../types/iphone";
import type { RcsExtensionState, RcsImportStatus } from "../../../electron/types/ipc/window-api-rcs-import";
import { resolveIPhoneSyncView } from "../../components/iphone/iphoneSyncView";
import type { GoogleMessagesOrchestratorStep } from "../../hooks/googleMessagesSyncStatus";
import type { BrowserLinkView } from "../../components/settings/android/browserLinkState";
import { CHECKING_BROWSER } from "../../components/settings/android/browserLinkState";
import { retrySecondsLeft } from "../../utils/syncRetryCooldown";

export type SyncPillTone = "arc" | "danger" | "warning" | "success" | "neutral";

export interface SyncPillState {
  device: "iphone" | "android";
  label: string;
  tooltip: string;
  tone: SyncPillTone;
  /** A sync can start from here — the only states whose label says "Sync now". */
  canStart: boolean;
  progressPercent?: number;
}

/**
 * Q1 (founder OPEN QUESTION 78690484; PM D1 default = false): the Android
 * "connected" states A9/A10 driven by extensionSeenAt. The extension has no
 * periodic heartbeat, so an idle, working extension reads "not seen" 10 min
 * after its last hello — they wait for 2.46. Flip to true to ship them.
 */
export const ANDROID_CONNECTED_STATES = false;
/** A9/A10: the extension counts as connected when seen this recently (inclusive). */
export const ANDROID_SEEN_WITHIN_MS = 10 * 60 * 1000;

export const SYNC_NOW = "Sync now";
const IPHONE = "iPhone";
const ANDROID = "Android";

/** "just now", "5 minutes ago", "2 hours ago", "yesterday", "3 days ago", else "on <date>". */
export function relativeAgo(thenMs: number, now: number): string {
  const minutes = Math.floor((now - thenMs) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return `on ${new Date(thenMs).toLocaleDateString()}`;
}

/** extensionSeenAt (ISO) is within `ms` of now, the boundary included. */
export function seenWithin(seenAt: string | null | undefined, now: number, ms: number = ANDROID_SEEN_WITHIN_MS): boolean {
  if (!seenAt) return false;
  const t = Date.parse(seenAt);
  return Number.isFinite(t) && now - t <= ms;
}

const pill = (
  device: SyncPillState["device"],
  label: string,
  tooltip: string,
  tone: SyncPillTone,
  canStart = false,
  progressPercent?: number,
): SyncPillState => ({ device, label, tooltip, tone, canStart, ...(progressPercent === undefined ? {} : { progressPercent }) });

export type IPhonePillInput = Pick<
  UseIPhoneSyncReturn,
  | "isConnected"
  | "syncStatus"
  | "progress"
  | "syncLocked"
  | "lockReason"
  | "appleEncryptedBackup"
  | "isWaitingForPasscode"
  | "retryAvailableAt"
  | "needsTrust"
  | "driverMissing"
  | "toolsMissing"
  | "lastSyncTime"
>;

/** Mac wording transcribed from useIPhoneSync.ts onToolsMissing (userError.title). */
export const IPHONE_TOOLS_MISSING_MAC = "iPhone sync tools not installed";
export const IPHONE_INSTALL_APPLE_DEVICES = "Install Apple Devices to sync";

/**
 * iPhone pill. `enabled` = resolveIphoneSyncEnabled (SR B2: the Settings
 * opt-out turns detection off while the source stays iPhone Sync).
 */
export function deriveIPhonePill(
  sync: IPhonePillInput,
  enabled: boolean,
  now: number,
  opts: { isMacOS?: boolean } = {},
): SyncPillState {
  const view = resolveIPhoneSyncView(sync);
  switch (view) {
    case "lockBanner":
      return pill("iphone", IPHONE, sync.lockReason || "Waiting for another sync to finish", "neutral");
    case "progress": {
      // B1: passcode is a refinement of the syncing view, not a rank above it.
      if (sync.isWaitingForPasscode) return pill("iphone", IPHONE, "Enter the passcode on your iPhone", "warning");
      const pct = sync.progress ? Math.round(sync.progress.percent) : undefined;
      return pct === undefined
        ? pill("iphone", "Syncing", "Backing up", "arc")
        : pill("iphone", `Syncing ${pct}%`, `Backing up · ${pct}%`, "arc", false, pct);
    }
    case "success":
      return pill("iphone", IPHONE, "Synced just now", "success");
    case "appleEncrypted":
      // D3 (PM): Keepr never asks for a backup password (BACKLOG-3881).
      return pill("iphone", IPHONE, "Turn off backup encryption to sync", "warning");
    case "error": {
      const secs = retrySecondsLeft(sync.retryAvailableAt, now);
      return pill("iphone", "Sync failed", secs > 0 ? `Sync failed · Try again in ${secs} s` : "Sync failed · Try again", "danger");
    }
    case "connection":
      break;
  }
  if (sync.needsTrust) return pill("iphone", IPHONE, "Tap Trust on your iPhone", "warning");
  if (sync.driverMissing) return pill("iphone", IPHONE, IPHONE_INSTALL_APPLE_DEVICES, "warning");
  if (sync.toolsMissing) {
    return pill("iphone", IPHONE, opts.isMacOS ? IPHONE_TOOLS_MISSING_MAC : IPHONE_INSTALL_APPLE_DEVICES, "warning");
  }
  // D2 (PM): detection is off in Settings › iPhone Sync (USB).
  if (!enabled) return pill("iphone", IPHONE, "iPhone sync is off in Settings", "neutral");
  if (sync.isConnected && sync.syncStatus === "idle") {
    return pill("iphone", `${IPHONE} · ${SYNC_NOW}`, "Click to sync your iPhone · connected", "success", true);
  }
  if (sync.lastSyncTime) return pill("iphone", IPHONE, `Synced ${relativeAgo(sync.lastSyncTime.getTime(), now)}`, "neutral");
  return pill("iphone", IPHONE, "Connect your iPhone by USB", "neutral");
}

/**
 * Android pill (source android-messages-web).
 *
 * Order: job (importing / saving / failed) > can't listen > update > not
 * installed > not linked > checking > consent > ready. Consent sits below the
 * link states because the Sync Android flow asks for it only on its linked
 * screen (GoogleMessagesSyncFlow needsConsent = optedIn !== true).
 */
export function deriveAndroidPill(
  ext: RcsExtensionState | null,
  status: RcsImportStatus | null,
  jobStep: GoogleMessagesOrchestratorStep | null,
  linkView: BrowserLinkView,
  now: number,
  opts: { connectedStates?: boolean } = {},
): SyncPillState {
  const connectedStates = opts.connectedStates ?? ANDROID_CONNECTED_STATES;
  if (jobStep?.kind === "progress") {
    return pill("android", "Importing", jobStep.phase, "arc", false, jobStep.indeterminate ? undefined : jobStep.progress);
  }
  if (jobStep?.kind === "saving") return pill("android", "Importing", "Saving your recent chats", "arc");
  if (jobStep?.kind === "error") return pill("android", "Sync failed", "Sync failed · Try again", "danger");
  if (status?.bridge === "unavailable") {
    return pill("android", ANDROID, "Keepr can't listen for the extension (port in use)", "warning");
  }
  if (ext?.extensionUpdateReady) return pill("android", ANDROID, "Update the Keepr extension", "warning");
  if (!ext?.extensionVersion) return pill("android", ANDROID, "Install the Keepr extension", "neutral");
  if (linkView === "notLinked") return pill("android", ANDROID, "Link the extension to Keepr", "neutral");
  if (linkView === "checking") return pill("android", ANDROID, CHECKING_BROWSER, "neutral");
  if (ext.optedIn !== true) return pill("android", ANDROID, "Accept the sync consent to continue", "warning");

  const label = `${ANDROID} · ${SYNC_NOW}`;
  if (connectedStates && !seenWithin(ext.extensionSeenAt, now)) {
    const seen = ext.extensionSeenAt ? `Last seen ${relativeAgo(Date.parse(ext.extensionSeenAt), now)}` : "Not seen yet";
    return pill("android", ANDROID, `${seen} · open Chrome`, "neutral");
  }
  const tone: SyncPillTone = connectedStates ? "success" : "neutral";
  if (ext.lastCacheFinishedAt) {
    const last = relativeAgo(Date.parse(ext.lastCacheFinishedAt), now);
    return pill("android", label, `Last sync ${last} · click to sync again`, tone, true);
  }
  return connectedStates
    ? pill("android", label, "Click to sync your Android · extension connected", "success", true)
    : pill("android", label, "Click to sync your Android", "neutral", true);
}

/** The Android Companion source (no longer offered): parity with its old tile. */
export function deriveCompanionPill(): SyncPillState {
  return pill("android", `${ANDROID} · ${SYNC_NOW}`, "Click to sync your Android", "neutral", true);
}
