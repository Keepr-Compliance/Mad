import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  APPLE_DEVICES_CHECK_BUTTON,
  APPLE_DEVICES_CHECKING,
  APPLE_DEVICES_NOT_FOUND,
  APPLE_DEVICES_OPEN_BUTTON,
  APPLE_DEVICES_OPEN_FAILED,
  APPLE_DEVICES_STILL_NOT_RUNNING,
  APPLE_DEVICES_READY_STILL,
  APPLE_MSI_STOPPED_BODY,
  APPLE_MSI_STOPPED_STEPS,
  APPLE_MSI_STILL_STOPPED,
  APPLE_OPEN_WINDOWS_UPDATE_FAILED,
  APPLE_USB_DRIVER_STILL_MISSING,
  APPLE_WU_CHECK_BUTTON,
  APPLE_WU_OPTIONAL_BUTTON,
  CHECKLIST_APPLE_DEVICES_INSTALL,
  CHECKLIST_APPLE_DEVICES_STARTING,
  CHECKLIST_DONE_LABEL,
  CHECKLIST_HEADING,
  CHECKLIST_IPHONE_BODY,
  CHECKLIST_ROW_APPLE_DEVICES,
  CHECKLIST_ROW_IPHONE,
  CHECKLIST_ROW_USB_DRIVER,
  CHECKLIST_TODO_LABEL,
  CHECKLIST_USB_DRIVER_BODY,
  CHECKLIST_USB_DRIVER_UNCHECKED,
} from "../../constants/appleDevicesStoreCopy";
import type { AppleDevicesState, AppleUsbDriverState } from "../../types/iphone";
import { deviceService } from "../../services/deviceService";
import { TrustComputerHint } from "./TrustComputerHint";
import logger from "../../utils/logger";

/**
 * BACKLOG-3927 (Microsoft Store build only): self-ticking iPhone setup
 * checklist. Three rows, in the order the user has to finish them:
 *
 *   1. Apple Devices installed (and its iPhone support running)
 *   2. Apple iPhone USB driver (Windows Update)
 *   3. iPhone connected and trusted
 *
 * Each row ticks from the Apple Devices state the main process reports. Only
 * the first unmet row is expanded. Row 2 can only be checked against a
 * plugged-in iPhone: when the probe saw no iPhone it reads "checked when your
 * iPhone is plugged in" instead of a tick it cannot prove.
 *
 * The website build never renders this (its Settings path for an Apple Devices
 * source keeps AppleDevicesStoreGuide).
 */
export type ChecklistRowStatus = "done" | "open" | "waiting" | "unchecked";

export interface ChecklistRows {
  appleDevices: ChecklistRowStatus;
  usbDriver: ChecklistRowStatus;
  iphone: ChecklistRowStatus;
}

/** Row statuses for a state. Exactly one row is "open". Exported for tests. */
export function checklistRows(
  state: AppleDevicesState,
  usbDriver: AppleUsbDriverState | null | undefined,
): ChecklistRows {
  if (state === "not-installed" || state === "not-running" || state === "msi-service-stopped") {
    return { appleDevices: "open", usbDriver: "waiting", iphone: "waiting" };
  }
  if (state === "usb-driver-missing") {
    return { appleDevices: "done", usbDriver: "open", iphone: "waiting" };
  }
  return {
    appleDevices: "done",
    usbDriver: usbDriver === "bound" ? "done" : "unchecked",
    iphone: "open",
  };
}

const STILL_COPY: Record<AppleDevicesState, string> = {
  "not-installed": APPLE_DEVICES_NOT_FOUND,
  "not-running": APPLE_DEVICES_STILL_NOT_RUNNING,
  "msi-service-stopped": APPLE_MSI_STILL_STOPPED,
  "usb-driver-missing": APPLE_USB_DRIVER_STILL_MISSING,
  ready: APPLE_DEVICES_READY_STILL,
};

const PRIMARY_BUTTON =
  "px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
const SECONDARY_BUTTON =
  "px-4 py-2 bg-gray-200 text-gray-700 text-sm font-medium rounded-md hover:bg-gray-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

function RowMarker({ status }: { status: ChecklistRowStatus }): React.ReactElement {
  if (status === "done") {
    return (
      <span
        className="w-6 h-6 rounded-full bg-green-100 flex items-center justify-center flex-shrink-0"
        aria-label={CHECKLIST_DONE_LABEL}
        role="img"
      >
        <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      </span>
    );
  }
  return (
    <span
      className={`w-6 h-6 rounded-full border-2 flex-shrink-0 ${
        status === "open" ? "border-blue-500" : "border-gray-300"
      }`}
      aria-label={CHECKLIST_TODO_LABEL}
      role="img"
    />
  );
}

export function IPhoneSetupChecklist({
  state: stateProp,
  usbDriver = null,
  onCheckAgain,
  variant = "full",
  disabled = false,
  recheckOnFocus = true,
}: {
  state: AppleDevicesState;
  usbDriver?: AppleUsbDriverState | null;
  onCheckAgain: () => Promise<AppleDevicesState>;
  variant?: "full" | "compact";
  disabled?: boolean;
  /**
   * Quiet re-check on window focus. The Connect screen passes false: the
   * iPhone sync hook already runs a throttled focus re-check there.
   */
  recheckOnFocus?: boolean;
}): React.ReactElement {
  const [state, setState] = useState<AppleDevicesState>(stateProp);
  useEffect(() => {
    setState(stateProp);
  }, [stateProp]);
  const [checking, setChecking] = useState(false);
  const [stillMessage, setStillMessage] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const [updateOpenFailed, setUpdateOpenFailed] = useState(false);
  const mountedRef = useRef(true);
  const onCheckAgainRef = useRef(onCheckAgain);
  onCheckAgainRef.current = onCheckAgain;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Quiet re-check when the user returns to Keepr (from the Microsoft Store or
  // Windows Update). One probe at a time: each runs a PowerShell query.
  useEffect(() => {
    if (disabled || !recheckOnFocus) return;
    let inFlight = false;
    const onFocus = () => {
      if (inFlight) return;
      inFlight = true;
      void onCheckAgainRef
        .current()
        .catch((err) => {
          logger.warn("[IPhoneSetupChecklist] Focus re-check failed:", err);
        })
        .finally(() => {
          inFlight = false;
        });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [disabled, recheckOnFocus]);

  const handleOpenStore = useCallback(async () => {
    logger.info("[IPhoneSetupChecklist] Open Microsoft Store clicked");
    setOpenFailed(false);
    const result = await deviceService.openAppleDevicesStore();
    if (mountedRef.current && !result.success) setOpenFailed(true);
  }, []);

  const handleOpenWindowsUpdate = useCallback(async (target: "check" | "optional") => {
    logger.info(`[IPhoneSetupChecklist] Windows Update (${target}) clicked`);
    setUpdateOpenFailed(false);
    const result = await deviceService.openWindowsUpdate(target);
    if (mountedRef.current && !result.success) setUpdateOpenFailed(true);
  }, []);

  const handleCheckAgain = useCallback(async () => {
    logger.info("[IPhoneSetupChecklist] Check again clicked");
    setChecking(true);
    setStillMessage(false);
    let next: AppleDevicesState | null = null;
    try {
      next = await onCheckAgainRef.current();
    } catch (err) {
      logger.warn("[IPhoneSetupChecklist] Re-check failed:", err);
    }
    if (!mountedRef.current) return;
    setChecking(false);
    if (next !== null) setState(next);
    setStillMessage(true);
  }, []);

  const rows = checklistRows(state, usbDriver);

  const appleDevicesBody = (() => {
    if (state === "not-installed") {
      return (
        <>
          <p>{CHECKLIST_APPLE_DEVICES_INSTALL}</p>
          <button
            type="button"
            className={`mt-2 ${PRIMARY_BUTTON}`}
            onClick={() => void handleOpenStore()}
            disabled={disabled}
          >
            {APPLE_DEVICES_OPEN_BUTTON}
          </button>
          {openFailed && (
            <p className="mt-2 text-red-700" role="alert">
              {APPLE_DEVICES_OPEN_FAILED}
            </p>
          )}
        </>
      );
    }
    if (state === "msi-service-stopped") {
      return (
        <>
          <p>{APPLE_MSI_STOPPED_BODY}</p>
          <ol className="mt-1 list-decimal list-inside space-y-1">
            {APPLE_MSI_STOPPED_STEPS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </>
      );
    }
    return <p>{CHECKLIST_APPLE_DEVICES_STARTING}</p>;
  })();

  const usbDriverBody = (
    <>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={PRIMARY_BUTTON}
          onClick={() => void handleOpenWindowsUpdate("check")}
          disabled={disabled}
        >
          {APPLE_WU_CHECK_BUTTON}
        </button>
        <button
          type="button"
          className={PRIMARY_BUTTON}
          onClick={() => void handleOpenWindowsUpdate("optional")}
          disabled={disabled}
        >
          {APPLE_WU_OPTIONAL_BUTTON}
        </button>
      </div>
      <p className="mt-2">{CHECKLIST_USB_DRIVER_BODY}</p>
      {updateOpenFailed && (
        <p className="mt-2 text-red-700" role="alert">
          {APPLE_OPEN_WINDOWS_UPDATE_FAILED}
        </p>
      )}
    </>
  );

  const iphoneBody = (
    <>
      <p>{CHECKLIST_IPHONE_BODY}</p>
      <TrustComputerHint />
    </>
  );

  const row = (
    key: keyof ChecklistRows,
    title: string,
    body: React.ReactNode,
    note?: string,
  ): React.ReactElement => {
    const status = rows[key];
    return (
      <li
        key={key}
        className="py-3 border-b border-gray-200 last:border-b-0"
        data-testid={`setup-row-${key}`}
        data-status={status}
      >
        <div className="flex items-center gap-3">
          <RowMarker status={status} />
          <span
            className={`text-sm font-medium ${status === "done" ? "text-gray-500" : "text-gray-800"}`}
          >
            {title}
          </span>
        </div>
        {status === "unchecked" && note && (
          <p className="ml-9 mt-1 text-xs text-gray-500">{note}</p>
        )}
        {status === "open" && (
          <div className="ml-9 mt-2 text-sm text-gray-700" data-testid={`setup-row-${key}-body`}>
            {body}
          </div>
        )}
      </li>
    );
  };

  return (
    <div
      className={variant === "compact" ? "space-y-2" : "p-6 w-full max-w-md mx-auto text-left"}
      data-testid="iphone-setup-checklist"
      data-state={state}
    >
      {variant === "full" && (
        <h3 className="text-xl font-semibold text-gray-800 mb-2">{CHECKLIST_HEADING}</h3>
      )}
      <ol className="list-none p-0 m-0">
        {row("appleDevices", CHECKLIST_ROW_APPLE_DEVICES, appleDevicesBody)}
        {row("usbDriver", CHECKLIST_ROW_USB_DRIVER, usbDriverBody, CHECKLIST_USB_DRIVER_UNCHECKED)}
        {row("iphone", CHECKLIST_ROW_IPHONE, iphoneBody)}
      </ol>
      <button
        type="button"
        className={`mt-3 ${SECONDARY_BUTTON}`}
        onClick={() => void handleCheckAgain()}
        disabled={disabled || checking}
      >
        {checking ? APPLE_DEVICES_CHECKING : APPLE_DEVICES_CHECK_BUTTON}
      </button>
      {stillMessage && !checking && (
        <div
          className="mt-3 text-sm text-amber-800 bg-amber-50 p-3 rounded border border-amber-200"
          role="status"
        >
          {STILL_COPY[state]}
        </div>
      )}
    </div>
  );
}

export default IPhoneSetupChecklist;
