/**
 * BACKLOG-3785: tracks `transactionService.linkMessages` runs that are in flight.
 *
 * A link now writes in chunks and yields the event loop between them, so a quit
 * request can arrive between two chunks. Quitting there would leave the deal
 * partly linked (each chunk is atomic, the whole link is not). The quit handler
 * asks `waitForLinksToFinish` first, the same way it asks the iPhone backup
 * (BACKLOG-3598), and quits once the link is done or the wait bound passes.
 */
export const LINK_QUIT_MAX_WAIT_MS = 60_000;

let inFlight = 0;
let waiters: Array<() => void> = [];

/** Marks a link as started; call the returned function when it ends (finally). */
export function beginLink(): () => void {
  inFlight += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    inFlight -= 1;
    if (inFlight === 0) {
      const toWake = waiters;
      waiters = [];
      for (const wake of toWake) wake();
    }
  };
}

export function linkInFlightCount(): number {
  return inFlight;
}

/**
 * Null when no link is running (the quit goes ahead untouched). Otherwise a
 * promise that resolves when every running link has finished, or after
 * `maxWaitMs` — whichever comes first. Never rejects.
 */
export function waitForLinksToFinish(
  maxWaitMs: number = LINK_QUIT_MAX_WAIT_MS,
  onTimeout?: () => void,
): Promise<void> | null {
  if (inFlight === 0) return null;
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      waiters = waiters.filter((w) => w !== wake);
      try {
        onTimeout?.();
      } catch {
        /* logging must not block the quit */
      }
      resolve();
    }, maxWaitMs);
    const wake = () => {
      clearTimeout(timer);
      resolve();
    };
    waiters.push(wake);
  });
}
