/**
 * Desktop platform detection from the browser's user agent.
 *
 * Moved out of app/download/page.tsx (BACKLOG-4067) so the download page and
 * the Microsoft Store badge share ONE Windows check and cannot disagree.
 * Call it only in the browser (inside useEffect): on the server there is no
 * navigator, and reading the UA during render would cause a hydration mismatch.
 */

export type Platform = 'mac-arm' | 'mac-intel' | 'windows' | 'unknown';

export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('mac')) {
    if (
      navigator.platform === 'MacIntel' &&
      typeof (navigator as Navigator & { maxTouchPoints?: number }).maxTouchPoints === 'number' &&
      (navigator as Navigator & { maxTouchPoints?: number }).maxTouchPoints! > 0
    ) {
      return 'mac-arm';
    }
    return 'mac-arm';
  }
  if (ua.includes('win')) return 'windows';
  return 'unknown';
}
