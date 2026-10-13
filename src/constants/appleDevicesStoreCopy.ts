/**
 * BACKLOG-3927: the one place the Microsoft Store build's iPhone setup copy
 * lives. Every screen that shows it imports from here — edit the words here only.
 *
 * ALL TEXT IS DRAFT awaiting founder sign-off (OPEN QUESTION on BACKLOG-3927).
 * Each screen picks its text from the Apple Devices state (not-installed,
 * not-running, usb-driver-missing).
 *
 * The Store build ships no Apple driver (Store policy 10.2.4.2). The user gets
 * Apple Mobile Device Support from Apple's own "Apple Devices" app instead.
 */
export const APPLE_DEVICES_HEADING = "Install Apple Devices";

export const APPLE_DEVICES_BODY =
  "To sync messages from your iPhone, Windows needs Apple's iPhone driver. It comes with Apple's free Apple Devices app from the Microsoft Store.";

export const APPLE_DEVICES_STEPS: readonly string[] = [
  "Click Open Microsoft Store and install Apple Devices.",
  "Come back to Keepr and click Check again.",
];

export const APPLE_DEVICES_OPEN_BUTTON = "Open Microsoft Store";

export const APPLE_DEVICES_CHECK_BUTTON = "Check again";

export const APPLE_DEVICES_CHECKING = "Checking...";

export const APPLE_DEVICES_NOT_FOUND =
  "Apple Devices isn't installed yet. Finish the install in the Microsoft Store, then click Check again.";

export const APPLE_DEVICES_OPEN_FAILED =
  'Couldn\'t open the Microsoft Store. Open the Microsoft Store app and search for "Apple Devices".';

export const APPLE_DEVICES_FOOTER =
  "Apple Devices is Apple's free app. Keepr doesn't install any drivers.";

/**
 * Installed, but Apple Mobile Device Support is not running. Measured on a
 * real PC (2026-10-12): Apple Devices runs it as per-user processes, not a
 * Windows service, so opening the app is what starts it.
 */
export const APPLE_DEVICES_SERVICE_STOPPED =
  "Apple Devices is installed, but its iPhone support isn't running. Open the Apple Devices app once, then click Check again.";

/** Package present, Apple Mobile Device Support not answering. */
export const APPLE_DEVICES_NOT_RUNNING_HEADING = "Open Apple Devices";

export const APPLE_DEVICES_NOT_RUNNING_BODY = APPLE_DEVICES_SERVICE_STOPPED;

export const APPLE_DEVICES_NOT_RUNNING_STEPS: readonly string[] = [
  "Open the Apple Devices app from the Start menu.",
  "Keep your iPhone plugged in, then come back to Keepr and click Check again.",
];

export const APPLE_DEVICES_STILL_NOT_RUNNING =
  "Apple Devices still isn't running. Open it, wait a few seconds, then click Check again.";

/**
 * The iPhone is plugged in but Windows has it on its own photo driver, not
 * Apple's USB driver. Apple Devices does not bring this driver; Windows Update
 * offers it as an optional driver (measured 2026-10-12).
 */
export const APPLE_USB_DRIVER_HEADING = "Install Apple's iPhone USB driver";

export const APPLE_USB_DRIVER_BODY =
  "Windows sees your iPhone, but it isn't using Apple's USB driver yet. Windows Update provides this driver.";

export const APPLE_USB_DRIVER_STEPS: readonly string[] = [
  "Open Device Manager, find Apple iPhone, right-click it and choose Update driver, then Search automatically for drivers.",
  "If nothing is found, open Settings > Windows Update > Advanced options > Optional updates and install the Apple driver.",
  "Unplug your iPhone, plug it back in, then click Check again.",
];

export const APPLE_USB_DRIVER_STILL_MISSING =
  "Your iPhone still isn't using Apple's USB driver. Follow the steps above, reconnect your iPhone, then click Check again.";

/** Onboarding skip (Store build). */
export const APPLE_DEVICES_SKIP_DESCRIPTION =
  "You can install Apple Devices later to sync iPhone messages";

export const APPLE_DEVICES_SKIP_WARNING =
  "Without Apple Devices, your iPhone can't be detected and sync won't work. You can install it later from Settings, or install it now.";
