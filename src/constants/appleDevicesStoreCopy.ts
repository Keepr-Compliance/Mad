/**
 * BACKLOG-3927: the one place the Microsoft Store build's iPhone setup copy
 * lives. Every screen that shows it imports from here — edit the words here only.
 *
 * ALL TEXT IS DRAFT awaiting founder sign-off (OPEN QUESTION on BACKLOG-3927).
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

/** Settings: installed, but Apple's service is not running. */
export const APPLE_DEVICES_SERVICE_STOPPED =
  "Apple's iPhone service isn't running. Restart your computer. If that doesn't help, reinstall Apple Devices from the Microsoft Store.";

/** Onboarding skip (Store build). */
export const APPLE_DEVICES_SKIP_DESCRIPTION =
  "You can install Apple Devices later to sync iPhone messages";

export const APPLE_DEVICES_SKIP_WARNING =
  "Without Apple Devices, your iPhone can't be detected and sync won't work. You can install it later from Settings, or install it now.";
