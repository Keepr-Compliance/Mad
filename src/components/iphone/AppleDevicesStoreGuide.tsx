import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  APPLE_DEVICES_BODY,
  APPLE_DEVICES_CHECK_BUTTON,
  APPLE_DEVICES_CHECKING,
  APPLE_DEVICES_FOOTER,
  APPLE_DEVICES_HEADING,
  APPLE_DEVICES_NOT_FOUND,
  APPLE_DEVICES_OPEN_BUTTON,
  APPLE_DEVICES_OPEN_FAILED,
  APPLE_DEVICES_STEPS,
} from "../../constants/appleDevicesStoreCopy";
import { deviceService } from "../../services/deviceService";
import logger from "../../utils/logger";

/**
 * BACKLOG-3927: Microsoft Store build iPhone setup. The Store build ships no
 * Apple driver and never installs one, so instead of an Install button this
 * sends the user to Apple's "Apple Devices" app in the Microsoft Store, then
 * re-detects Apple Mobile Device Support.
 *
 * `onCheckAgain` re-runs detection and resolves true once it is found. It is
 * also called, quietly, when the window regains focus (the user coming back
 * from the Microsoft Store).
 */
export function AppleDevicesStoreGuide({
  onCheckAgain,
  variant = "full",
  disabled = false,
}: {
  onCheckAgain: () => Promise<boolean>;
  variant?: "full" | "compact";
  disabled?: boolean;
}): React.ReactElement {
  const [checking, setChecking] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const mountedRef = useRef(true);
  const onCheckAgainRef = useRef(onCheckAgain);
  onCheckAgainRef.current = onCheckAgain;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Quiet re-check when the user returns to Keepr. No "not installed yet"
  // message on this path: the user may not have finished in the Store.
  useEffect(() => {
    if (disabled) return;
    let inFlight = false;
    const onFocus = () => {
      // One probe at a time: each runs a PowerShell package query.
      if (inFlight) return;
      inFlight = true;
      void onCheckAgainRef
        .current()
        .catch((err) => {
          logger.warn("[AppleDevicesStoreGuide] Focus re-check failed:", err);
        })
        .finally(() => {
          inFlight = false;
        });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [disabled]);

  const handleOpenStore = useCallback(async () => {
    logger.info("[AppleDevicesStoreGuide] Open Microsoft Store clicked");
    setOpenFailed(false);
    const result = await deviceService.openAppleDevicesStore();
    if (mountedRef.current && !result.success) setOpenFailed(true);
  }, []);

  const handleCheckAgain = useCallback(async () => {
    logger.info("[AppleDevicesStoreGuide] Check again clicked");
    setChecking(true);
    setNotFound(false);
    let found = false;
    try {
      found = await onCheckAgainRef.current();
    } catch (err) {
      logger.warn("[AppleDevicesStoreGuide] Re-check failed:", err);
    }
    if (!mountedRef.current) return;
    setChecking(false);
    setNotFound(!found);
  }, []);

  const buttons = (
    <div className={variant === "compact" ? "flex gap-2" : "mt-6 flex flex-col gap-3 w-full max-w-sm"}>
      <button
        type="button"
        onClick={() => void handleOpenStore()}
        disabled={disabled}
        className={
          variant === "compact"
            ? "flex-1 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            : "w-full py-2.5 px-4 bg-blue-500 text-white rounded-lg font-semibold hover:bg-blue-600 transition-all shadow-md hover:shadow-lg"
        }
      >
        {APPLE_DEVICES_OPEN_BUTTON}
      </button>
      <button
        type="button"
        onClick={() => void handleCheckAgain()}
        disabled={disabled || checking}
        className={
          variant === "compact"
            ? "flex-1 px-4 py-2 bg-gray-200 text-gray-700 text-sm font-medium rounded-md hover:bg-gray-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            : "w-full py-2.5 px-4 bg-gray-100 text-gray-800 rounded-lg font-semibold hover:bg-gray-200 transition-all disabled:opacity-50"
        }
      >
        {checking ? APPLE_DEVICES_CHECKING : APPLE_DEVICES_CHECK_BUTTON}
      </button>
    </div>
  );

  const messages = (
    <>
      {notFound && !checking && (
        <div className="mt-3 text-sm text-amber-800 bg-amber-50 p-3 rounded border border-amber-200" role="status">
          {APPLE_DEVICES_NOT_FOUND}
        </div>
      )}
      {openFailed && (
        <div className="mt-3 text-sm text-red-700 bg-red-50 p-3 rounded border border-red-200" role="alert">
          {APPLE_DEVICES_OPEN_FAILED}
        </div>
      )}
    </>
  );

  if (variant === "compact") {
    return (
      <div className="space-y-2" data-testid="apple-devices-store-guide">
        <p className="text-sm text-gray-700">{APPLE_DEVICES_BODY}</p>
        {buttons}
        {messages}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center p-8 text-center" data-testid="apple-devices-store-guide">
      <div className="w-16 h-16 rounded-full bg-blue-100 flex items-center justify-center mb-4">
        <svg className="w-8 h-8 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
          />
        </svg>
      </div>
      <h3 className="text-xl font-semibold text-gray-800">{APPLE_DEVICES_HEADING}</h3>
      <p className="text-gray-500 mt-2 max-w-sm">{APPLE_DEVICES_BODY}</p>
      <ol className="mt-4 max-w-sm text-left text-sm text-gray-700 list-decimal list-inside space-y-1">
        {APPLE_DEVICES_STEPS.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      {buttons}
      {messages}
      <p className="text-xs text-gray-400 mt-4 max-w-sm">{APPLE_DEVICES_FOOTER}</p>
    </div>
  );
}

export default AppleDevicesStoreGuide;
