/**
 * Phone connectivity probe (Android Companion).
 *
 * BACKLOG-2296: when a WiFi sync attempt fails, the companion must tell the user
 * WHY — the two root causes need different, actionable recovery:
 *   (a) the phone IS on Wi-Fi but the desktop Keepr app is closed / the LAN
 *       server is unreachable (connection refused / timeout); or
 *   (b) the PHONE itself is disconnected — no Wi-Fi, or on cellular and thus not
 *       on the same LAN as the desktop.
 *
 * The classification checks the PHONE's own connectivity FIRST (this module,
 * backed by `@react-native-community/netinfo`): if the phone is not on Wi-Fi it
 * is case (b); only when the phone IS on Wi-Fi but the desktop fetch fails is it
 * case (a). See services/backgroundSync.ts for where this is threaded into the
 * sync error path.
 *
 * IMPORTANT — LAN sync does NOT require internet. Reaching the desktop needs the
 * phone to be on the SAME local Wi-Fi network, not to have working internet, so
 * this deliberately keys off `type === 'wifi'` (+ `isConnected`) and NEVER off
 * `isInternetReachable` (a phone on the right Wi-Fi with no internet can still
 * reach the desktop). Using internet-reachability would produce false "you're
 * offline" errors for exactly the local-only setups this feature targets.
 */

import NetInfo from "@react-native-community/netinfo";

export interface PhoneConnectivity {
  /** Whether the device reports an active network connection. */
  isConnected: boolean;
  /** Whether that connection is Wi-Fi specifically (a prerequisite for LAN sync). */
  isWifi: boolean;
}

/**
 * Read the phone's current connectivity via NetInfo.
 *
 * Never throws. If NetInfo is unavailable or errors (e.g. an unexpected native
 * failure), we ASSUME the phone is on the local network (`isConnected: true,
 * isWifi: true`). That is the safe default: it falls back to the pre-existing
 * "desktop unreachable" classification rather than asserting a NEW, possibly
 * wrong "you're offline" message. A false "desktop down" is the status quo; a
 * false "you're not on Wi-Fi" would be a regression.
 */
export async function getPhoneConnectivity(): Promise<PhoneConnectivity> {
  try {
    const state = await NetInfo.fetch();
    return {
      // `isConnected` is `boolean | null` — treat null (undetermined) as
      // connected so we don't over-report offline.
      isConnected: state.isConnected !== false,
      isWifi: state.type === "wifi",
    };
  } catch {
    // Assume on-network (see doc comment) — degrade to the desktop-down path.
    return { isConnected: true, isWifi: true };
  }
}

/**
 * True when the phone is on Wi-Fi and connected — the precondition for reaching
 * a desktop on the same LAN. When this is FALSE a failed sync is case (b)
 * (phone off Wi-Fi); when it is TRUE a failed sync is case (a) (desktop
 * unreachable).
 */
export function isOnLocalNetwork(connectivity: PhoneConnectivity): boolean {
  return connectivity.isConnected && connectivity.isWifi;
}

/**
 * Convenience: fetch connectivity and reduce it to the single "is the phone on
 * the local network?" decision used by the sync error classifier.
 */
export async function isPhoneOnLocalNetwork(): Promise<boolean> {
  return isOnLocalNetwork(await getPhoneConnectivity());
}
