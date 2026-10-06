/**
 * Session change events — BACKLOG-3658 (SR P1 optional).
 *
 * A tiny listener registry so services can react to sign-in, session refresh
 * and sign-out WITHOUT the session handlers importing them (e.g. the Google
 * Messages Sync keeps the signed-in user id in memory and cancels a running
 * Sync when the user signs out or someone else signs in).
 *
 * sessionService emits: "saved" (sign-in or refresh, with the user id) and
 * "cleared" (sign-out). A failing listener never breaks the session write.
 */

export interface SessionChange {
  kind: "saved" | "cleared";
  /** The signed-in user after the change; null when cleared or unknown. */
  userId: string | null;
}

type Listener = (change: SessionChange) => void;

const listeners = new Set<Listener>();

/** Subscribe; returns an unsubscribe. */
export function onSessionChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tell every listener; each one's error is swallowed (cosmetic to the session). */
export function emitSessionChanged(change: SessionChange): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener(change);
    } catch {
      // A listener must never break the session write that triggered it.
    }
  }
}

/** Tests only. */
export function resetSessionListenersForTests(): void {
  listeners.clear();
}
