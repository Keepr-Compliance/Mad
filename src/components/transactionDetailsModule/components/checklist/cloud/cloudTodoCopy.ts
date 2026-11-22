/**
 * Every user-visible string of the Checklist tab's Keepr Cloud parts — BACKLOG-4263 PR-6 (plan §7). One file so
 * the wording can change without touching the components. Shown only to a user with Keepr Cloud on.
 */
export const CLOUD_TODO_COPY = {
  dueDateMenu: "Due date…",
  historyMenu: "History",
  dueLabel: "Due date",
  save: "Save",
  clear: "Clear",
  cancel: "Cancel",
  due: (shortDay: string) => `Due ${shortDay}`,
  marker: (kind: "ticked" | "unticked" | "changed" | "added", who: string, ago: string) =>
    `${kind === "ticked" ? "Ticked" : kind === "unticked" ? "Unticked" : kind === "added" ? "Added" : "Changed"} by ${who} · ${ago}`,
  // plan §7: "This note was also changed by Claude. Keepr kept the later change. Other version: “…”"
  conflict: (part: "done" | "title" | "note" | "due", who: string) =>
    `This ${part === "done" ? "tick" : part === "title" ? "name" : part === "due" ? "due date" : "note"} was also changed by ${who}. Keepr kept the later change.`,
  otherVersion: "Other version:",
  showAll: "Show all",
  useThisVersion: "Use this version",
  dismiss: "Dismiss",
  historyOffline: "History needs an internet connection.",
  historyEmpty: "No changes yet.",
  historyFailed: "History could not be loaded. Try again later.",
  partName: { done: "Tick", title: "Name", note: "Note", due: "Due date" } as Readonly<Record<string, string>>,
  empty: "empty",
  added: "added",
  removed: "removed",
  restored: "restored",
  notKept: "(not kept)",
  showMore: "Show more",
  closeHistory: "Close history",
  // Read by a screen reader only: "Note from start to from ai".
  historyFrom: "from",
  historyTo: "to",
  recentlyRemoved: "Recently removed",
  removedOn: (when: string) => `removed ${when}`,
  restore: "Restore",
  removedOffline: "Recently removed needs an internet connection.",
  restoredLine: "Restored. It shows here within a minute.",
  restoreLocked: "This deal is locked, so nothing can be restored.",
  restoreFailed: "That did not work. Try again.",
  dropped: (title: string) => `A change to “${title}” could not be saved online because the todo was removed there.`,
  writeFailed: (title: string) => `A change to “${title}” from an AI app or another device could not be applied here yet. Keepr tries again.`,
  notAccepted: (title: string) => `A change to “${title}” was not accepted online.`,
  linksNotRestored: (n: number) =>
    `Restored. ${n === 1 ? "1 link" : `${n} links`} to emails or texts that no longer exist could not come back.`,
  aTodo: "a todo",
} as const;

/** "Nov 20" from YYYY-MM-DD (the calendar day itself, never shifted by a time zone). */
export function shortDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** "just now", "5 min ago", "2 h ago", else "Nov 20". */
export function ago(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const m = Math.max(0, Math.round((now - t) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
