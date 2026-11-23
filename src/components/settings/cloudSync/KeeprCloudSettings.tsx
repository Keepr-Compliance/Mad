/**
 * Settings › Keepr Cloud — BACKLOG-4243 PR-1 (plan §9) and the AI apps row
 * (BACKLOG-4242).
 *
 * State comes from useKeeprCloudSettings (held by Settings, which also gates
 * the tab). Renders nothing while main reports the section hidden. The switch renders
 * only when main reports the upload engine installed. Same card and switch as
 * LearnSettings. Wording: keeprCloudCopy.ts.
 */
import React, { useState } from "react";
import { SettingsConfirm } from "./SettingsConfirm";
import type { UseKeeprCloudSettings } from "./useKeeprCloudSettings";
import { KEEPR_CLOUD_COPY as C, NOTICE_TEXTS } from "./keeprCloudCopy";
import { useKeeprCloudRemoved } from "./useKeeprCloudRemoved";
import { KeeprCloudRemovedDeals } from "./KeeprCloudRemovedDeals";
import type { CloudSyncView } from "../../../../electron/types/ipc/window-api-cloud-sync";

function minutesAgo(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const m = Math.max(0, Math.round((Date.now() - t) / 60_000));
  if (m < 1) return "just now";
  if (m === 1) return "1 minute ago";
  if (m < 60) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  return h === 1 ? "1 hour ago" : `${h} hours ago`;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function statusLine(view: CloudSyncView): string | null {
  switch (view.status) {
    case "on": {
      if (view.pendingDeals > 0) return C.statusSaving(view.pendingDeals);
      const ago = minutesAgo(view.lastSavedAt);
      return ago ? C.statusSaved(ago) : C.statusOn;
    }
    case "paused":
      switch (view.pausedReason) {
        case "signed_out":
          return C.pausedSignedOut;
        case "offline":
          return C.pausedOffline;
        case "other_project":
          return C.pausedOtherProject;
        default:
          return C.pausedOther;
      }
    case "not_active":
      return C.pausedNotActive;
    case "update_needed":
      return C.updateNeeded;
    case "turning_off":
      return C.turnOffOffline;
    default:
      return null;
  }
}

const SOLID_BUTTON =
  "inline-flex h-9 flex-none items-center rounded-md bg-sky-700 px-4 text-sm font-semibold text-white hover:bg-sky-800 disabled:opacity-50";

/**
 * @param listed BACKLOG-4263: the session lists the Keepr Cloud tab. While this view is still loading, the
 *   section's heading and anchor render with a loading line, so the tab and the panel row land on it. Once a read
 *   has finished without a view (main could not be reached), the section renders nothing, as for a hidden view.
 */
export function KeeprCloudSettings({
  cloud,
  listed = false,
}: {
  cloud: UseKeeprCloudSettings;
  listed?: boolean;
}): React.ReactElement | null {
  const [dialog, setDialog] = useState<"notice" | "off" | "forget" | "delete-online" | "delete-installs" | null>(null);
  const view = cloud.view;
  const isOn = !!view && (view.status === "on" || view.status === "error" || view.status === "paused");
  // BACKLOG-4263 PR-6: Settings › Keepr Cloud › Removed (Keepr Cloud users only; the online list only when on and online)
  const removed = useKeeprCloudRemoved(isOn, view?.status === "on" || view?.status === "error");
  if (!view && listed && !cloud.viewRead) {
    return (
      <div id="settings-cloud" className="mb-8" data-testid="settings-cloud">
        <div className="flex flex-col gap-1">
          <h3 className="m-0 text-xl font-semibold leading-7 text-gray-900">{C.title}</h3>
          <p className="m-0 text-sm text-gray-500" data-testid="cloud-loading">
            {C.loading}
          </p>
        </div>
      </div>
    );
  }
  if (!view || view.status === "hidden") return null;

  const noticeText = view.noticeVersion !== null ? NOTICE_TEXTS[view.noticeVersion] : undefined;
  const canTurnOn = view.status === "off" && noticeText !== undefined;
  const canTurnOff = isOn || view.status === "not_active" || view.status === "needs_confirmation";
  const line = statusLine(view);

  const onSwitch = () => {
    if (isOn) setDialog("off");
    else if (canTurnOn) setDialog("notice");
  };

  return (
    <div id="settings-cloud" className="mb-8" data-testid="settings-cloud">
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <h3 className="m-0 text-xl font-semibold leading-7 text-gray-900">{C.title}</h3>
          <p className="m-0 text-sm text-gray-500">{C.offDescription}</p>
        </div>

        {view.engineInstalled && (
          <div className="flex items-center justify-between gap-4 rounded-lg border border-[#E6E4DF] bg-white px-5 py-4">
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-semibold text-gray-900">{C.switchLabel}</span>
              {line && (
                <span className="text-[13px] text-gray-500" data-testid="cloud-status">
                  {line}
                </span>
              )}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={isOn}
              aria-label={C.switchLabel}
              disabled={cloud.busy || (!isOn && !canTurnOn)}
              onClick={onSwitch}
              className={`relative inline-flex h-6 w-10 flex-none items-center rounded-full transition-colors disabled:opacity-50 ${
                isOn ? "bg-sky-700" : "bg-gray-300"
              }`}
            >
              <span
                className={`inline-block h-[18px] w-[18px] transform rounded-full bg-white transition-transform ${
                  isOn ? "translate-x-[19px]" : "translate-x-[3px]"
                }`}
              />
            </button>
          </div>
        )}

        {view.engineInstalled && view.status === "needs_confirmation" && (
          <div className="flex items-center justify-between gap-4 rounded-lg border border-[#E6E4DF] bg-white px-5 py-4" data-testid="cloud-confirm">
            <span className="text-[13px] text-gray-700">
              {C.thisComputer} {C.thisComputerTodos}
            </span>
            <button type="button" className={SOLID_BUTTON} disabled={cloud.busy} onClick={() => void cloud.confirmComputer()}>
              {C.saveThisComputer}
            </button>
          </div>
        )}

        {view.installRemoved && isOn && (
          <div className="flex items-center justify-between gap-4 rounded-lg border border-[#E6E4DF] bg-white px-5 py-4" data-testid="cloud-install-removed">
            <span className="text-[13px] text-gray-700">{C.installRemoved}</span>
            <button type="button" className={SOLID_BUTTON} disabled={cloud.busy} onClick={() => void cloud.reclaimInstall()}>
              {C.reclaim}
            </button>
          </div>
        )}

        {view.parked && view.parked.locked > 0 && (
          <p className="m-0 text-[13px] text-gray-700" data-testid="cloud-parked-locked">
            {C.parkedLocked(view.parked.locked)}
          </p>
        )}
        {view.parked && view.parked.other > 0 && (
          <p className="m-0 text-[13px] text-gray-700" data-testid="cloud-parked-other">
            {C.parkedOther(view.parked.other)}
          </p>
        )}

        {view.notSavedDeals > 0 && (view.status === "on" || view.status === "error") && (
          <p className="m-0 text-[13px] text-red-700" data-testid="cloud-not-saved">
            {C.statusNotSaved(view.notSavedDeals)}
          </p>
        )}

        {view.onlineNotHereDeals > 0 && (
          <div className="flex items-center justify-between gap-4 rounded-lg border border-[#E6E4DF] bg-white px-5 py-4" data-testid="cloud-online-not-here">
            <span className="text-[13px] text-gray-700">{C.onlineNotHere(view.onlineNotHereDeals)}</span>
            <button type="button" className={SOLID_BUTTON} disabled={cloud.busy} onClick={() => setDialog("delete-online")}>
              {C.deleteThem}
            </button>
          </div>
        )}

        {(view.restoredOnlineOnly ?? 0) > 0 && (
          <p className="m-0 text-[13px] text-gray-700" data-testid="cloud-online-only">
            {C.onlineOnly(view.restoredOnlineOnly as number)}
          </p>
        )}

        {view.otherInstalls && (
          <div className="flex items-center justify-between gap-4 rounded-lg border border-[#E6E4DF] bg-white px-5 py-4" data-testid="cloud-other-installs">
            <span className="text-[13px] text-gray-700">
              {C.otherInstalls(view.otherInstalls.deals, shortDate(view.otherInstalls.lastSavedAt))}
            </span>
            <button type="button" className={SOLID_BUTTON} disabled={cloud.busy} onClick={() => setDialog("delete-installs")}>
              {C.deleteThem}
            </button>
          </div>
        )}

        {view.status === "error" && (
          <div className="flex items-center justify-between gap-4 rounded-lg border border-[#E6E4DF] bg-white px-5 py-4" data-testid="cloud-error">
            <span className="text-[13px] text-red-700">{C.errorLine}</span>
            <button type="button" className={SOLID_BUTTON} disabled={cloud.busy} onClick={() => void cloud.retry()}>
              {C.tryAgain}
            </button>
          </div>
        )}

        {view.pausedReason === "other_project" && (
          <div>
            <button type="button" className={SOLID_BUTTON} disabled={cloud.busy} onClick={() => setDialog("forget")}>
              {C.forget}
            </button>
          </div>
        )}

        {canTurnOff && view.status !== "on" && view.status !== "paused" && view.status !== "error" && (
          <div>
            <button type="button" className={SOLID_BUTTON} disabled={cloud.busy} onClick={() => setDialog("off")}>
              {C.turnOff}
            </button>
          </div>
        )}

        {isOn && <KeeprCloudRemovedDeals removed={removed} offline={view.pausedReason === "offline"} />}

        {cloud.message && (
          <p className="m-0 text-[13px] text-gray-700" data-testid="cloud-message">
            {cloud.message === "turn_off_done"
              ? C.turnOffDone
              : cloud.message === "turn_off_offline"
                ? C.turnOffOffline
                : cloud.message === "reclaim_done"
                  ? C.reclaimDone
                  : C.actionFailed}
          </p>
        )}

        <div className="flex items-center justify-between gap-4 rounded-lg border border-[#E6E4DF] bg-white px-5 py-4" data-testid="cloud-ai-apps">
          <span className="flex flex-col gap-0.5">
            <span className="text-sm font-semibold text-gray-900">{C.aiAppsTitle}</span>
            <span className="text-[13px] text-gray-500">{C.aiAppsDescription}</span>
          </span>
          <button
            type="button"
            className={SOLID_BUTTON}
            disabled={!view.aiAppsAvailable}
            onClick={() => void cloud.openAiApps()}
          >
            {C.manageAiApps}
          </button>
        </div>
      </div>

      <SettingsConfirm
        open={dialog === "notice"}
        title={C.title}
        description={noticeText ?? ""}
        confirmLabel={C.turnOn}
        cancelLabel={C.cancel}
        loading={cloud.busy}
        onCancel={() => setDialog(null)}
        onConfirm={() => {
          if (view.noticeVersion !== null) void cloud.turnOn(view.noticeVersion).finally(() => setDialog(null));
        }}
      />
      <SettingsConfirm
        open={dialog === "off"}
        title={C.turnOffConfirmTitle}
        description={[C.turnOffConfirm, C.turnOffLost, ...(removed.here.length > 0 ? [C.turnOffArchive] : [])].join(" ")}
        confirmLabel={C.turnOffConfirmButton}
        cancelLabel={C.cancel}
        isDestructive
        loading={cloud.busy}
        onCancel={() => setDialog(null)}
        onConfirm={() => void cloud.turnOff().finally(() => setDialog(null))}
      />
      <SettingsConfirm
        open={dialog === "delete-online" || dialog === "delete-installs"}
        title={C.deleteOnlineConfirmTitle}
        description={dialog === "delete-installs" ? C.deleteInstallsConfirm : C.deleteOnlineConfirm}
        confirmLabel={C.deleteButton}
        cancelLabel={C.cancel}
        isDestructive
        loading={cloud.busy}
        onCancel={() => setDialog(null)}
        onConfirm={() =>
          void (dialog === "delete-online" ? cloud.deleteOnlineNotHere() : cloud.deleteOldInstalls()).finally(() => setDialog(null))
        }
      />
      <SettingsConfirm
        open={dialog === "forget"}
        title={C.forget}
        description={C.forgetConfirm}
        confirmLabel={C.forgetButton}
        cancelLabel={C.cancel}
        loading={cloud.busy}
        onCancel={() => setDialog(null)}
        onConfirm={() => void cloud.forgetOtherProject().finally(() => setDialog(null))}
      />
    </div>
  );
}
