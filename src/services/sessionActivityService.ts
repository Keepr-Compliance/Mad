/**
 * BACKLOG-3833 — renderer side of the session idle timeout.
 *
 * Main measures idle time; the renderer only reports that a person used the
 * app and listens for main's idle sign-out. Components use the hooks
 * (`useUserActivityHeartbeat`, `useIdleSessionExpiry`), not this file directly.
 */

/** Report user input to main. Errors are swallowed: a missed heartbeat is harmless. */
export async function reportUserActivity(): Promise<void> {
  try {
    await window.api?.auth?.reportUserActivity?.();
  } catch {
    // ignore
  }
}

/** Subscribe to main's idle sign-out. Returns an unsubscribe function. */
export function onIdleSessionExpired(callback: () => void): () => void {
  const unsubscribe = window.api?.auth?.onIdleSessionExpired?.(callback);
  return typeof unsubscribe === "function" ? unsubscribe : () => {};
}

/**
 * One-shot notice for the sign-in screen (e.g. "signed out after 30 minutes of
 * inactivity"). Set after the app has left the signed-in screens; the sign-in
 * screen shows it. Never shown over client data.
 */
let signInNotice: string | null = null;
const noticeListeners = new Set<() => void>();

export function setSignInNotice(message: string | null): void {
  signInNotice = message;
  noticeListeners.forEach((l) => l());
}

export function getSignInNotice(): string | null {
  return signInNotice;
}

export function subscribeSignInNotice(listener: () => void): () => void {
  noticeListeners.add(listener);
  return () => {
    noticeListeners.delete(listener);
  };
}
