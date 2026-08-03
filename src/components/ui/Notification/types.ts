/**
 * Notification Types
 * TypeScript interfaces for the unified notification system
 */

export type NotificationType = "success" | "error" | "warning" | "info";

export interface NotificationAction {
  label: string;
  onClick: () => void;
}

export interface NotificationOptions {
  /**
   * Auto-dismiss duration in milliseconds (default: 5000, 0 = persistent).
   *
   * BACKLOG-2447: this said 3000 while `NotificationContext` used 5000 — the
   * default was unified upward when the second toast system was deleted, and
   * this comment was not updated with it. Same defect class as the one that
   * caused BACKLOG-2447 (two comments claiming "bottom-right" over code that
   * rendered top). If you change `DEFAULT_DURATION`, change this line.
   */
  duration?: number;
  /** Equivalent to duration: 0 - notification won't auto-dismiss. Wins over `duration` if both are set. */
  persistent?: boolean;
  /**
   * Optional action button. Clicking it runs `onClick` and then dismisses the
   * notification, so the same action cannot be fired twice (BACKLOG-2390).
   */
  action?: NotificationAction;
}

export interface Notification {
  id: string;
  type: NotificationType;
  message: string;
  duration: number;
  action?: NotificationAction;
}

/**
 * The app-wide notification API (BACKLOG-2447: the only one — `useToast` and
 * `Toast.tsx` were deleted).
 *
 * At most `MAX_NOTIFICATIONS` (5) are visible at once; raising a sixth drops
 * the oldest, FIFO. The deleted `useToast` had no cap, so a caller that raises
 * more than five in one burst now loses the earliest rather than stacking them
 * all. See `NotificationContext.tsx`.
 */
export interface NotifyMethods {
  success: (message: string, options?: NotificationOptions) => void;
  error: (message: string, options?: NotificationOptions) => void;
  warning: (message: string, options?: NotificationOptions) => void;
  info: (message: string, options?: NotificationOptions) => void;
}

export interface NotificationContextValue {
  notify: NotifyMethods;
  dismiss: (id: string) => void;
  dismissAll: () => void;
}
