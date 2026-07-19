/**
 * TroubleshootingSettings (BACKLOG-2112)
 *
 * Settings -> Troubleshooting section. Surfaces the two destructive cleanup
 * actions from the app-cleanup engine (BACKLOG-2111) with a confirmation flow:
 *   - "Reset app data..."  -> wipe local data + secrets, relaunch into onboarding.
 *   - "Uninstall Keepr..." -> wipe local data + secrets AND remove the app.
 *
 * Each action opens a confirm modal listing exactly what is removed, an optional
 * "reason" selector (forwarded to lifecycle logging, BACKLOG-2113), and — for
 * UNINSTALL only — a type-"KEEPR"-to-confirm gate. On success the engine quits
 * the app, so we optimistically show a "Keepr is closing..." state. On failure
 * (notably the dev-build refusal, which is surfaced verbatim) we show the error
 * and a support link.
 *
 * Components never call window.api directly — all IPC goes through
 * appCleanupService (repo rule).
 */

import React, { useCallback, useMemo, useState } from "react";
import { ResponsiveModal } from "../common/ResponsiveModal";
import { useNotification } from "@/hooks/useNotification";
import { appCleanupService } from "../../services";
import { systemService } from "../../services/systemService";
import logger from "../../utils/logger";

type CleanupMode = "reset" | "uninstall";

/** Reason options offered in the confirm modal (value forwarded to lifecycle log). */
const REASON_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "Prefer not to say" },
  { value: "broken-install", label: "Something is broken / not working" },
  { value: "switching-device", label: "Switching to another device" },
  { value: "privacy", label: "Privacy — removing my data" },
  { value: "other", label: "Other (let us know below)" },
];

/** The exact word the user must type to enable the uninstall confirm button. */
const UNINSTALL_CONFIRM_WORD = "KEEPR";

/** Shared input styling (repo design rule: explicit text-gray-900 bg-white). */
const INPUT_CLASS =
  "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 bg-white " +
  "focus:ring-2 focus:ring-red-500 focus:border-red-500";

/**
 * Resolve the free-text reason to forward to the lifecycle log. Returns
 * undefined when no reason was chosen so the log omits the field entirely.
 */
function resolveReason(selected: string, otherText: string): string | undefined {
  if (selected === "") return undefined;
  if (selected === "other") {
    const trimmed = otherText.trim();
    return trimmed.length > 0 ? trimmed : "other";
  }
  return selected;
}

export function TroubleshootingSettings(): React.ReactElement {
  const { notify } = useNotification();

  // Which confirm modal is open (null = none).
  const [activeMode, setActiveMode] = useState<CleanupMode | null>(null);
  // Reason selection state (reset each time a modal opens).
  const [reason, setReason] = useState<string>("");
  const [otherReason, setOtherReason] = useState<string>("");
  // Uninstall type-to-confirm state.
  const [confirmWord, setConfirmWord] = useState<string>("");
  // In-progress + closing state (blocks interaction; success => app quits).
  const [inProgress, setInProgress] = useState<boolean>(false);
  const [closing, setClosing] = useState<boolean>(false);

  const openModal = useCallback((mode: CleanupMode): void => {
    setActiveMode(mode);
    setReason("");
    setOtherReason("");
    setConfirmWord("");
  }, []);

  const closeModal = useCallback((): void => {
    if (inProgress) return; // don't allow dismiss mid-wipe
    setActiveMode(null);
  }, [inProgress]);

  const showFailure = useCallback(
    (message: string): void => {
      notify.error(message, {
        persistent: true,
        action: {
          label: "Contact support",
          onClick: () => {
            systemService.contactSupport(message).catch((err) => {
              logger.error("[Troubleshooting] contactSupport failed:", err);
            });
          },
        },
      });
    },
    [notify],
  );

  const handleConfirm = useCallback(async (): Promise<void> => {
    if (activeMode === null) return;
    const mode = activeMode;
    const forwardedReason = resolveReason(reason, otherReason);

    setInProgress(true);
    try {
      const result =
        mode === "reset"
          ? await appCleanupService.reset(forwardedReason)
          : await appCleanupService.uninstall(forwardedReason);

      if (result.success) {
        // Engine is quitting/relaunching the app. Show a terminal closing state.
        setClosing(true);
        return;
      }

      // Failure (e.g. dev-build refusal) — surface the error verbatim.
      const message =
        result.error ??
        `Could not ${mode === "reset" ? "reset" : "uninstall"}. Please try again.`;
      logger.error(`[Troubleshooting] ${mode} failed:`, message);
      showFailure(message);
      setInProgress(false);
      setActiveMode(null);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "An unexpected error occurred.";
      logger.error(`[Troubleshooting] ${mode} threw:`, err);
      showFailure(message);
      setInProgress(false);
      setActiveMode(null);
    }
  }, [activeMode, reason, otherReason, showFailure]);

  const uninstallConfirmSatisfied = useMemo(
    () => confirmWord === UNINSTALL_CONFIRM_WORD,
    [confirmWord],
  );

  // Confirm button is gated on: not in progress, and (uninstall only) exact word.
  const confirmDisabled =
    inProgress || (activeMode === "uninstall" && !uninstallConfirmSatisfied);

  return (
    <div id="settings-troubleshooting" className="mb-8">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">
        Troubleshooting
      </h3>
      <div className="space-y-3">
        {/* Reset app data */}
        <button
          type="button"
          data-testid="troubleshooting-reset-open"
          onClick={() => openModal("reset")}
          className="w-full text-left p-4 bg-red-50 rounded-lg border border-red-200 hover:bg-red-100 transition-colors"
        >
          <h4 className="text-sm font-medium text-red-700">Reset app data…</h4>
          <p className="text-xs text-red-600 mt-1">
            Deletes all local data on this device — your database, preferences,
            cached emails and messages, and saved logins — then restarts Keepr
            into a fresh setup. Your cloud account and data are not affected.
          </p>
        </button>

        {/* Uninstall Keepr */}
        <button
          type="button"
          data-testid="troubleshooting-uninstall-open"
          onClick={() => openModal("uninstall")}
          className="w-full text-left p-4 bg-red-50 rounded-lg border border-red-200 hover:bg-red-100 transition-colors"
        >
          <h4 className="text-sm font-medium text-red-700">Uninstall Keepr…</h4>
          <p className="text-xs text-red-600 mt-1">
            Deletes all local data and saved logins on this device AND removes
            the Keepr application itself, then quits. Your cloud account and data
            are not affected.
          </p>
        </button>
      </div>

      {activeMode !== null && (
        <ResponsiveModal
          onClose={closeModal}
          zIndex="z-[70]"
          overlayClassName="bg-black bg-opacity-50"
          panelClassName="max-w-md p-6"
          testId="troubleshooting-confirm-modal"
        >
          {closing ? (
            <div
              className="text-center py-6"
              data-testid="troubleshooting-closing"
            >
              <div className="w-8 h-8 border-4 border-red-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
              <p className="text-sm font-medium text-gray-900">
                Keepr is closing…
              </p>
              <p className="text-xs text-gray-500 mt-1">
                {activeMode === "reset"
                  ? "Your data is being cleared and Keepr will restart."
                  : "Your data is being cleared and Keepr will be removed."}
              </p>
            </div>
          ) : (
            <div>
              <h3 className="text-lg font-semibold text-red-700 mb-2">
                {activeMode === "reset"
                  ? "Reset app data?"
                  : "Uninstall Keepr?"}
              </h3>
              <p className="text-sm text-gray-700 mb-3">
                This will permanently remove the following from this device:
              </p>
              <ul className="list-disc list-inside text-sm text-gray-700 space-y-1 mb-4">
                <li>Your local database and all cached transactions</li>
                <li>Cached emails and messages</li>
                <li>App preferences and settings</li>
                <li>Saved logins (keychain / credential manager)</li>
                {activeMode === "uninstall" && (
                  <li className="font-medium text-red-700">
                    The Keepr application itself
                  </li>
                )}
              </ul>
              <p className="text-xs text-gray-500 mb-4">
                Your cloud account and data in the cloud are not affected. This
                cannot be undone.
              </p>

              {/* Optional reason */}
              <label
                htmlFor="troubleshooting-reason"
                className="block text-xs font-medium text-gray-700 mb-1"
              >
                Why are you {activeMode === "reset" ? "resetting" : "uninstalling"}?
                (optional)
              </label>
              <select
                id="troubleshooting-reason"
                data-testid="troubleshooting-reason-select"
                value={reason}
                disabled={inProgress}
                onChange={(e) => setReason(e.target.value)}
                className={`${INPUT_CLASS} mb-3 disabled:opacity-50`}
              >
                {REASON_OPTIONS.map((opt) => (
                  <option key={opt.value || "none"} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>

              {reason === "other" && (
                <input
                  type="text"
                  data-testid="troubleshooting-reason-other"
                  value={otherReason}
                  disabled={inProgress}
                  onChange={(e) => setOtherReason(e.target.value)}
                  placeholder="Tell us more (optional)"
                  className={`${INPUT_CLASS} mb-3 disabled:opacity-50`}
                />
              )}

              {/* Uninstall-only type-to-confirm gate */}
              {activeMode === "uninstall" && (
                <div className="mb-4">
                  <label
                    htmlFor="troubleshooting-confirm-word"
                    className="block text-xs font-medium text-gray-700 mb-1"
                  >
                    Type{" "}
                    <span className="font-mono font-semibold text-red-700">
                      {UNINSTALL_CONFIRM_WORD}
                    </span>{" "}
                    to confirm
                  </label>
                  <input
                    type="text"
                    data-testid="troubleshooting-confirm-word"
                    value={confirmWord}
                    disabled={inProgress}
                    onChange={(e) => setConfirmWord(e.target.value)}
                    autoComplete="off"
                    className={`${INPUT_CLASS} disabled:opacity-50`}
                  />
                </div>
              )}

              <div className="flex gap-2 justify-end mt-2">
                <button
                  type="button"
                  data-testid="troubleshooting-cancel"
                  onClick={closeModal}
                  disabled={inProgress}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  data-testid="troubleshooting-confirm"
                  onClick={handleConfirm}
                  disabled={confirmDisabled}
                  className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {inProgress
                    ? "Working…"
                    : activeMode === "reset"
                      ? "Reset app data"
                      : "Uninstall Keepr"}
                </button>
              </div>
            </div>
          )}
        </ResponsiveModal>
      )}
    </div>
  );
}

export default TroubleshootingSettings;
