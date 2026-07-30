/**
 * AndroidPairingStep
 *
 * Step displayed when users select Android during phone type selection.
 * Shows a QR code for pairing with the Keepr Companion app on Android.
 * On successful pair, user continues onboarding (email connect, etc.).
 *
 * BACKLOG-1447: Replaced "Coming Soon" placeholder with actual QR pairing flow.
 *
 * @module onboarding/steps/AndroidComingSoonStep
 */

import React, { useState, useCallback, useRef, useEffect } from "react";
import type {
  OnboardingStep,
  OnboardingStepMeta,
  OnboardingStepContentProps,
} from "../types";
import logger from "../../../utils/logger";
import { ResponsiveModal } from "../../common/ResponsiveModal";

// =============================================================================
// STEP METADATA
// =============================================================================

/**
 * Step metadata configuration.
 * Custom navigation is handled inside the Content component.
 */
export const meta: OnboardingStepMeta = {
  id: "android-coming-soon",
  progressLabel: "Android",
  platforms: ["macos", "windows", "android", "ios"],
  navigation: {
    showBack: false,
    hideContinue: true,
  },
  // Only show this step when the user selected Android
  isApplicable: (context) => context.phoneType === "android",
  // This step is never auto-complete; the user must click Continue or Skip.
  // Manual advancement is handled via CONTINUE_EMAIL_ONLY action in the queue.
  isComplete: () => false,
};

// =============================================================================
// STEP CONTENT
// =============================================================================

/**
 * Android QR Pairing step content.
 * Generates a QR code for pairing and shows connection status.
 */
function Content({ context, onAction, variant = "onboarding" }: OnboardingStepContentProps) {
  // BACKLOG-2289: In the Settings wizard there is no "select iPhone instead"
  // choice (the user already picked Android), so the iPhone back-affordance and
  // the "pair later from Settings" footer are hidden. QR/pairing logic is
  // identical across variants, so 2224 account-match is preserved either way.
  const isSettings = variant === "settings";

  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paired, setPaired] = useState(false);
  const [serverStarting, setServerStarting] = useState(false);

  // BACKLOG-2348: Windows-only pre-warn before the OS network-permission
  // (firewall) prompt that fires when the sync server binds the LAN IP.
  const isWindows = context.platform === "windows";
  const [checkingFirewall, setCheckingFirewall] = useState(false);
  const [showNetworkPrewarn, setShowNetworkPrewarn] = useState(false);

  // Refs for cleanup of polling interval and timeout to prevent memory leaks
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
    };
  }, []);

  const handleGoBack = () => {
    onAction({ type: "GO_BACK_SELECT_IPHONE" });
  };

  const handleContinue = () => {
    onAction({ type: "CONTINUE_EMAIL_ONLY" });
  };

  // BACKLOG-2327: post-pair "Done" in the Settings wizard. The pairing step does
  // not own the wizard/modal, so it signals completion via an action; the wizard
  // (AndroidSyncSetup) maps ANDROID_SYNC_DONE to its completion path (onComplete
  // → close the modal). Onboarding never wires this action (Settings-only step).
  const handleDone = () => {
    onAction({ type: "ANDROID_SYNC_DONE" });
  };

  const handleGenerateQR = useCallback(async () => {
    setGenerating(true);
    setError(null);

    try {
      // BACKLOG-2224: pass the logged-in user id so the QR embeds a hash of it
      // for the phone-side account-match pre-check.
      const qrResult = await window.api.pairing.generateQR(context.userId ?? undefined);

      if (!qrResult.success || !qrResult.result) {
        setError(qrResult.error ?? "Failed to generate QR code");
        setGenerating(false);
        return;
      }

      setQrDataUrl(qrResult.result.qrDataUrl);

      // Start the sync server with the secret from QR pairing
      setServerStarting(true);
      try {
        await window.api.localSync.startServer({
          port: qrResult.result.pairingInfo.port,
          secret: qrResult.result.pairingInfo.secret,
          userId: context.userId ?? undefined,
        });
      } catch (serverErr) {
        logger.error("[AndroidPairingStep] Failed to start sync server:", serverErr);
        setError("Failed to start sync server. Check your network connection.");
      } finally {
        setServerStarting(false);
      }

      // Clear any previous polling before starting new one
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);

      // Poll for pairing status via two signals:
      // 1. pairingService.getStatus() — device registered after first authenticated request
      // 2. localSync.getStatus() — totalMessagesReceived > 0 means a device synced data
      // BACKLOG-1454: Previously only checked pairing status, but addPairedDevice was
      // never called so isPaired was always false.
      const pollInterval = setInterval(async () => {
        try {
          // Primary: check pairing service (device explicitly registered)
          const pairingStatus = await window.api.pairing.getStatus();
          if (pairingStatus.success && pairingStatus.status?.isPaired && pairingStatus.status.devices.length > 0) {
            setPaired(true);
            clearInterval(pollInterval);
            pollIntervalRef.current = null;
            return;
          }

          // Fallback: check if sync server has received any data
          const syncStatus = await window.api.localSync.getStatus();
          if (syncStatus.totalMessagesReceived > 0) {
            setPaired(true);
            clearInterval(pollInterval);
            pollIntervalRef.current = null;
          }
        } catch {
          // Ignore polling errors
        }
      }, 3000);
      pollIntervalRef.current = pollInterval;

      // Stop polling after 5 minutes
      pollTimeoutRef.current = setTimeout(() => {
        clearInterval(pollInterval);
        pollIntervalRef.current = null;
        pollTimeoutRef.current = null;
      }, 300_000);
    } catch (err) {
      logger.error("[AndroidPairingStep] Failed to generate QR:", err);
      setError(err instanceof Error ? err.message : "Failed to generate pairing code");
    } finally {
      setGenerating(false);
    }
  }, [context.userId]);

  // BACKLOG-2348: Entry point for the "Show QR Code" button. On Windows, the
  // sync server binding the LAN IP triggers the Windows Defender Firewall
  // "Allow access" prompt. If the app doesn't already have an allow rule, show a
  // brief pre-warn explaining the upcoming OS prompt before startServer runs; if
  // it's already allowed (or we're not on Windows), go straight to generating.
  // A failed/timed-out check falls through to showing the pre-warn (safe default).
  const handleShowQrCode = useCallback(async () => {
    if (!isWindows) {
      handleGenerateQR();
      return;
    }
    setCheckingFirewall(true);
    try {
      const result = await window.api.localSync.checkFirewallAllowed();
      if (result.allowed) {
        handleGenerateQR();
        return;
      }
    } catch (err) {
      logger.warn("[AndroidPairingStep] Firewall check failed:", err);
    } finally {
      setCheckingFirewall(false);
    }
    setShowNetworkPrewarn(true);
  }, [isWindows, handleGenerateQR]);

  // Pre-warn acknowledged → close the panel and start the server (which fires
  // the OS prompt the user was just told about).
  const handleAcknowledgeNetworkPrewarn = useCallback(() => {
    setShowNetworkPrewarn(false);
    handleGenerateQR();
  }, [handleGenerateQR]);

  return (
    <div className="text-center">
      {/* Android Icon */}
      <div className="relative inline-block mb-4">
        <div className="w-14 h-14 sm:w-16 sm:h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto">
          <svg
            className="w-8 h-8 sm:w-10 sm:h-10 text-green-500"
            viewBox="0 0 24 24"
            fill="currentColor"
          >
            <path d="M17.6 9.48l1.84-3.18c.16-.31.04-.69-.26-.85-.29-.15-.65-.06-.83.22l-1.88 3.24a11.463 11.463 0 00-8.94 0L5.65 5.67c-.19-.29-.54-.38-.84-.22-.3.16-.42.54-.26.85L6.4 9.48A10.78 10.78 0 002 18h20a10.78 10.78 0 00-4.4-8.52zM7 15.25a1.25 1.25 0 110-2.5 1.25 1.25 0 010 2.5zm10 0a1.25 1.25 0 110-2.5 1.25 1.25 0 010 2.5z" />
          </svg>
        </div>
        {paired && (
          <div className="absolute -bottom-2 left-1/2 transform -translate-x-1/2">
            <span className="inline-block px-3 py-1 bg-green-100 text-green-700 text-xs font-semibold rounded-full border border-green-200">
              Connected
            </span>
          </div>
        )}
      </div>

      {/* Header */}
      <h1 className="text-lg sm:text-xl font-bold text-gray-900 mb-2">
        {paired ? "Android Phone Connected!" : "Pair Your Android Phone"}
      </h1>

      <p className="text-sm text-gray-600 mb-4">
        {paired
          ? "Your Android phone is paired. Messages now sync automatically over WiFi."
          : "Scan the QR code with the Keepr Companion app on your Android phone to pair."}
      </p>

      {/* Next Steps + QR reveal (BACKLOG-2325 / BACKLOG-2327). The instructions
          sit ABOVE the QR, and the "Show QR Code" button + the revealed QR both
          live INSIDE this green-framed box so the pair screen mirrors the
          download step's framing (average border, no separate heavy container).
          BACKLOG-2327: the heading is "Next Steps" (the prior download screen
          already uses "How It Works"); the redundant "Install the app" item is
          dropped (the download screen covers install); and the same-WiFi-network
          precondition is called out as an explicit step. */}
      {!paired && (
        <div className="bg-gradient-to-r from-green-50 to-emerald-50 rounded-xl p-3 sm:p-4 mb-4 text-left">
          <h3 className="font-semibold text-gray-900 mb-2 flex items-center gap-2 text-sm sm:text-base">
            <svg
              className="w-5 h-5 text-green-500 flex-shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            Next Steps
          </h3>
          <ol className="space-y-2">
            <li className="flex items-start gap-2 text-sm text-gray-600">
              <span className="flex-shrink-0 w-5 h-5 bg-green-100 text-green-700 rounded-full flex items-center justify-center text-xs font-bold">1</span>
              Make sure both devices are on the same WiFi network
            </li>
            <li className="flex items-start gap-2 text-sm text-gray-600">
              <span className="flex-shrink-0 w-5 h-5 bg-green-100 text-green-700 rounded-full flex items-center justify-center text-xs font-bold">2</span>
              Tap "Show QR Code" below and scan it with the app
            </li>
            <li className="flex items-start gap-2 text-sm text-gray-600">
              <span className="flex-shrink-0 w-5 h-5 bg-green-100 text-green-700 rounded-full flex items-center justify-center text-xs font-bold">3</span>
              Your messages will sync securely over WiFi
            </li>
          </ol>

          {/* Reveal button — mirrors the download step's green full-width action. */}
          {!qrDataUrl && (
            <button
              onClick={handleShowQrCode}
              disabled={generating || checkingFirewall}
              className="mt-4 w-full min-h-[44px] px-6 py-3 bg-green-500 text-white rounded-lg font-semibold hover:bg-green-600 active:bg-green-700 transition-all shadow-md hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {generating || checkingFirewall ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  {checkingFirewall ? "Checking..." : "Generating..."}
                </span>
              ) : (
                "Show QR Code"
              )}
            </button>
          )}

          {/* Revealed QR — average border, sits inside the green-framed area. */}
          {qrDataUrl && (
            <div className="flex flex-col items-center mt-4">
              <div className="bg-white p-2 rounded-lg border border-gray-200 mb-2">
                <img
                  src={qrDataUrl}
                  alt="Pairing QR Code"
                  className="w-40 h-40 sm:w-48 sm:h-48"
                />
              </div>
              {serverStarting && (
                <p className="text-xs text-gray-500">Starting sync server...</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Error display */}
      {error && (
        <div className="text-sm text-red-700 bg-red-50 p-3 rounded border border-red-200 mb-4">
          {error}
        </div>
      )}

      {/* Success state */}
      {paired && (
        <div className="bg-green-50 rounded-xl p-4 mb-4 text-left border border-green-200">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
            <span className="text-sm font-medium text-green-800">Device Paired</span>
          </div>
          <p className="text-xs text-green-700">
            Your messages will now sync automatically over WiFi — just keep both
            devices on the same network. Transfers are encrypted end-to-end.
          </p>
        </div>
      )}

      {/* Action Buttons */}
      <div className="space-y-2">
        {/* BACKLOG-2327: In the Settings wizard, once paired the only exit used to
            be the shell's "Back" (which reads like going backwards). Add an
            explicit primary "Done" that finishes the wizard via ANDROID_SYNC_DONE
            → the wizard's onComplete (close the modal), coexisting with the 2323
            auto-close. Onboarding never reaches this (Settings-only step). */}
        {isSettings && paired && (
          <button
            onClick={handleDone}
            className="w-full min-h-[44px] py-2.5 px-4 bg-green-500 text-white rounded-lg font-semibold hover:bg-green-600 active:bg-green-700 transition-all shadow-md hover:shadow-lg"
          >
            Done
          </button>
        )}

        {/* BACKLOG-2325: In the Settings wizard the primary skip/continue button
            is removed — the wizard shell owns Back, the modal owns close/X, and a
            live pair auto-advances (2323). Onboarding keeps its continue/skip. */}
        {!isSettings && (
          <button
            onClick={handleContinue}
            className="w-full min-h-[44px] py-2.5 px-4 bg-blue-500 text-white rounded-lg font-semibold hover:bg-blue-600 active:bg-blue-700 transition-all shadow-md hover:shadow-lg"
          >
            {paired ? "Continue" : "Skip & Continue with Email Only"}
          </button>
        )}

        {/* BACKLOG-2289: iPhone back-affordance is onboarding-only. */}
        {!paired && !isSettings && (
          <button
            onClick={handleGoBack}
            className="w-full min-h-[44px] py-2.5 px-4 border border-gray-300 text-gray-700 rounded-lg font-medium hover:bg-gray-50 active:bg-gray-100 transition-all flex items-center justify-center gap-2"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10 19l-7-7m0 0l7-7m-7 7h18"
              />
            </svg>
            Go Back & Select iPhone
          </button>
        )}
      </div>

      {/* Footer Note (onboarding-only — redundant inside Settings) */}
      {!isSettings && (
        <p className="text-xs text-gray-400 mt-4">
          You can also pair your Android phone later from Settings.
        </p>
      )}

      {/* BACKLOG-2348: Windows network-permission pre-warn. Mirrors the macOS FDA
          pre-warn pattern (a small ResponsiveModal that explains an upcoming OS
          permission prompt before it fires). Shown only when the app has no
          inbound firewall allow rule yet; on Continue we start the sync server,
          which triggers the Windows "Allow access" prompt the user was told about. */}
      {showNetworkPrewarn && (
        <ResponsiveModal
          onClose={() => setShowNetworkPrewarn(false)}
          panelClassName="max-w-md p-6"
        >
          <div className="text-left">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center flex-shrink-0">
                <svg
                  className="w-5 h-5 text-blue-600"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 11c0-1.105.895-2 2-2s2 .895 2 2m-9.032 6h10.064M5.636 5.636a9 9 0 1012.728 0M9 12a3 3 0 106 0"
                  />
                </svg>
              </div>
              <h3 className="text-base font-bold text-gray-900">
                Windows will ask for network permission
              </h3>
            </div>
            <p className="text-sm text-gray-600 mb-3">
              To pair, Keepr connects to your phone over your local network.
              Windows will now show a security prompt asking you to allow this.
            </p>
            <p className="text-sm text-gray-600 mb-5">
              Choose <strong>Allow access</strong> and keep the network options
              checked so your phone can find this computer. If you dismiss it,
              pairing won&apos;t work.
            </p>
            <div className="space-y-2">
              <button
                onClick={handleAcknowledgeNetworkPrewarn}
                className="w-full min-h-[44px] py-2.5 px-4 bg-green-500 text-white rounded-lg font-semibold hover:bg-green-600 active:bg-green-700 transition-all shadow-md hover:shadow-lg"
              >
                Continue
              </button>
              <button
                onClick={() => setShowNetworkPrewarn(false)}
                className="w-full min-h-[44px] py-2.5 px-4 border border-gray-300 text-gray-700 rounded-lg font-medium hover:bg-gray-50 active:bg-gray-100 transition-all"
              >
                Cancel
              </button>
            </div>
          </div>
        </ResponsiveModal>
      )}
    </div>
  );
}

/**
 * Complete Android Pairing step definition.
 * Note: The step ID remains "android-coming-soon" for backward compatibility
 * with existing step derivation and flow configuration.
 */
const AndroidComingSoonStep: OnboardingStep = {
  meta,
  Content,
};

export default AndroidComingSoonStep;
