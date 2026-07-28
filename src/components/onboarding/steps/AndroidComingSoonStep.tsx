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
function Content({ context, onAction }: OnboardingStepContentProps) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paired, setPaired] = useState(false);
  const [serverStarting, setServerStarting] = useState(false);

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
          ? "Your Android phone is paired and ready to sync messages over WiFi."
          : "Scan the QR code with the Keepr Companion app on your Android phone to pair."}
      </p>

      {/* QR Code Section */}
      {!paired && (
        <>
          {qrDataUrl ? (
            <div className="flex flex-col items-center mb-4">
              <div className="bg-white p-3 rounded-xl border border-gray-200 shadow-sm mb-3">
                <img
                  src={qrDataUrl}
                  alt="Pairing QR Code"
                  className="w-48 h-48 sm:w-56 sm:h-56"
                />
              </div>
              {serverStarting && (
                <p className="text-xs text-gray-500 mb-1">Starting sync server...</p>
              )}
              <p className="text-xs text-gray-400">
                Both devices must be on the same WiFi network.
              </p>
            </div>
          ) : (
            <div className="mb-4">
              <button
                onClick={handleGenerateQR}
                disabled={generating}
                className="px-6 py-3 min-h-[44px] bg-green-500 text-white rounded-lg font-semibold hover:bg-green-600 active:bg-green-700 transition-all shadow-md hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {generating ? (
                  <span className="flex items-center gap-2">
                    <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Generating...
                  </span>
                ) : (
                  "Show QR Code"
                )}
              </button>
            </div>
          )}
        </>
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
            Your Android phone will sync SMS messages over your local WiFi network.
            Messages are encrypted end-to-end during transfer.
          </p>
        </div>
      )}

      {/* Info Box (shown before QR code is generated) */}
      {!qrDataUrl && !paired && (
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
            How It Works
          </h3>
          <ol className="space-y-2">
            <li className="flex items-start gap-2 text-sm text-gray-600">
              <span className="flex-shrink-0 w-5 h-5 bg-green-100 text-green-700 rounded-full flex items-center justify-center text-xs font-bold">1</span>
              Install the Keepr Companion app on your Android phone
            </li>
            <li className="flex items-start gap-2 text-sm text-gray-600">
              <span className="flex-shrink-0 w-5 h-5 bg-green-100 text-green-700 rounded-full flex items-center justify-center text-xs font-bold">2</span>
              Tap "Show QR Code" above and scan it with the app
            </li>
            <li className="flex items-start gap-2 text-sm text-gray-600">
              <span className="flex-shrink-0 w-5 h-5 bg-green-100 text-green-700 rounded-full flex items-center justify-center text-xs font-bold">3</span>
              Your messages will sync securely over WiFi
            </li>
          </ol>
        </div>
      )}

      {/* Companion app download info — BACKLOG-1473 */}
      {!paired && (
        <div className="bg-blue-50 rounded-lg p-3 mb-4 text-center border border-blue-100">
          <p className="text-sm text-blue-700">
            Download the Keepr Companion app from your organization&apos;s{" "}
            <a
              href="https://portal.keepr.com/downloads"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold underline hover:text-blue-900"
            >
              broker portal
            </a>
            .
          </p>
        </div>
      )}

      {/* Action Buttons */}
      <div className="space-y-2">
        <button
          onClick={handleContinue}
          className="w-full min-h-[44px] py-2.5 px-4 bg-blue-500 text-white rounded-lg font-semibold hover:bg-blue-600 active:bg-blue-700 transition-all shadow-md hover:shadow-lg"
        >
          {paired ? "Continue" : "Skip & Continue with Email Only"}
        </button>

        {!paired && (
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

      {/* Footer Note */}
      <p className="text-xs text-gray-400 mt-4">
        You can also pair your Android phone later from Settings.
      </p>
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
