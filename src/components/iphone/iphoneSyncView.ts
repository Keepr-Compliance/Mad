/**
 * BACKLOG-4115 (D4, SR B1): which primary view the iPhone sync flow shows —
 * ONE rule for the sync flow (IPhoneSyncFlow) and the title-bar sync pill
 * (appCore/shell/syncPillState), so the pill never names a state the click
 * does not open.
 *
 * Moved verbatim from IPhoneSyncFlow (BACKLOG-2333 / BACKLOG-3881). Order =
 * precedence; `connection` is the default, so every combination resolves to
 * exactly one view.
 */
import type { UseIPhoneSyncReturn } from "../../types/iphone";

export type IPhoneSyncView = "lockBanner" | "progress" | "success" | "appleEncrypted" | "error" | "connection";

export type IPhoneSyncViewInput = Pick<
  UseIPhoneSyncReturn,
  "syncStatus" | "progress" | "syncLocked" | "appleEncryptedBackup"
>;

export function resolveIPhoneSyncView(input: IPhoneSyncViewInput): IPhoneSyncView {
  const { syncStatus, progress, syncLocked, appleEncryptedBackup } = input;
  const isSyncing = syncStatus === "syncing";
  const isComplete = syncStatus === "complete";
  const isError = syncStatus === "error";
  return (syncLocked && !isSyncing && !progress) ? "lockBanner" :
    ((isSyncing || (syncLocked && progress)) && !isError) ? "progress" :
    (isComplete && progress) ? "success" :
    (isError && appleEncryptedBackup) ? "appleEncrypted" :
    isError ? "error" :
    "connection";
}
