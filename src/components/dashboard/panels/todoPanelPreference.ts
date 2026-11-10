/**
 * BACKLOG-4220 — "Show to-do list on the dashboard" (Settings > General).
 *
 * Stored in the user's preferences bag as `dashboard.showTodo`, the same bag
 * Settings writes every other desktop preference to (settingsService ->
 * `preferences:update`). Founder decision 2026-11-10: absent or not a boolean
 * = hidden. Only a stored `true` shows Todo.
 *
 * Settings is a layer over the still-mounted Dashboard, so the Dashboard does
 * not re-read on close: the Settings switch announces each change here and the
 * mounted panels follow it at once.
 */
import { useEffect, useState } from "react";
import { settingsService } from "../../../services/settingsService";

/** The value the dashboard uses for a preferences bag. Default: hidden. */
export function showTodoFromPreferences(preferences: unknown): boolean {
  const dashboard = (preferences as { dashboard?: { showTodo?: unknown } } | null | undefined)?.dashboard;
  const value = dashboard?.showTodo;
  return typeof value === "boolean" ? value : false;
}

const listeners = new Set<(showTodo: boolean) => void>();

/** Settings calls this when the switch changes (and again if the save is undone). */
export function notifyShowTodoChanged(showTodo: boolean): void {
  listeners.forEach((listener) => listener(showTodo));
}

export function subscribeShowTodoChanged(listener: (showTodo: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Whether the dashboard shows Todo for this user. `null` until the stored
 * preference has been read; the dashboard treats `null` as hidden, so Todo
 * never flashes up before the read. A failed read means hidden (the default).
 */
export function useShowTodoPanel(userId: string | undefined): boolean | null {
  const [showTodo, setShowTodo] = useState<boolean | null>(null);

  useEffect(() => subscribeShowTodoChanged(setShowTodo), []);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void settingsService.getPreferences(userId).then((result) => {
      if (cancelled) return;
      // Only fill in the stored value; a change announced while the read was
      // in flight is newer and wins.
      setShowTodo((prev) => (prev !== null ? prev : result.success ? showTodoFromPreferences(result.data) : false));
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  return showTodo;
}
