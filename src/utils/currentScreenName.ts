/**
 * BACKLOG-3785: the NAME of the screen the renderer is showing, for freeze
 * telemetry only — the app step plus the names of any open modals, e.g.
 * "dashboard+Transactions". Names only; never ids or user data.
 *
 * Set by AppRouter on every render that changes it; read by the iPhone sync
 * heartbeat, so main knows which screen a renderer freeze happened on.
 */
import { useEffect } from "react";

let current = "unknown";

export function getCurrentScreenName(): string {
  return current;
}

/** `step` + the open `show*` flags of `modals`, as one name. */
export function screenNameFor(step: string, modals: Record<string, unknown> = {}): string {
  const open = Object.keys(modals)
    .filter((key) => key.startsWith("show") && modals[key] === true)
    .map((key) => key.slice(4))
    .sort();
  return [step, ...open].join("+");
}

export function useReportCurrentScreenName(step: string, modals?: Record<string, unknown>): void {
  const name = screenNameFor(step, modals);
  useEffect(() => {
    current = name;
    // Tell main too, so a window freeze outside a sync can name its screen.
    try {
      (window as unknown as { api?: { log?: { reportScreen?: (n: string) => void } } }).api?.log?.reportScreen?.(name);
    } catch {
      // Telemetry only.
    }
  }, [name]);
}
