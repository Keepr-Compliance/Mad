/**
 * Notification Context
 * Provides a unified notification system with a centralized API
 *
 * Usage:
 *   const { notify } = useNotification();
 *   notify.success("Message saved");
 *   notify.error("Failed to connect");
 *   notify.warning("Sync delayed");
 *   notify.info("New messages");
 */
import React, {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { NotificationContainer } from "../components/ui/Notification";
import type {
  Notification,
  NotificationContextValue,
  NotificationOptions,
  NotificationType,
  NotifyMethods,
} from "../components/ui/Notification/types";

/**
 * Maximum number of visible notifications. Raising a sixth drops the oldest.
 *
 * BACKLOG-2447: this is a BEHAVIOUR CHANGE for the 9 callers migrated off the
 * deleted `useToast`, which had no cap and stacked without limit. A caller that
 * raises more than five in one burst now silently loses the earliest. Kept as
 * is — an unbounded stack can cover the viewport — but it is a real difference,
 * so it is documented here and on `NotifyMethods`.
 */
const MAX_NOTIFICATIONS = 5;

/**
 * Default auto-dismiss duration in milliseconds.
 *
 * BACKLOG-2447: was 3000 here and 5000 in the deleted `useToast`. Unified on
 * the longer value so migrated callers do not silently lose 2 seconds of read
 * time — several of them show multi-clause sync results ("12 emails linked,
 * 3 skipped") that are not readable in 3s.
 *
 * This value is also stated in the `NotificationOptions.duration` doc comment
 * in `components/ui/Notification/types.ts`. Change both together.
 */
const DEFAULT_DURATION = 5000;

// Create context with null default to ensure provider is used
const NotificationContext = createContext<NotificationContextValue | null>(
  null
);

interface NotificationProviderProps {
  children: React.ReactNode;
}

/**
 * NotificationProvider component
 * Wraps the application and provides notification state and actions
 */
export function NotificationProvider({
  children,
}: NotificationProviderProps): React.ReactElement {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const idRef = useRef(0);
  const timeoutRefs = useRef<Map<string, NodeJS.Timeout>>(new Map());

  // Clean up all timeouts on unmount
  useEffect(() => {
    const timeouts = timeoutRefs.current;
    return () => {
      timeouts.forEach(clearTimeout);
      timeouts.clear();
    };
  }, []);

  /**
   * Dismiss a notification by ID
   */
  const dismiss = useCallback((id: string) => {
    // Clear any pending timeout for this notification
    const timeout = timeoutRefs.current.get(id);
    if (timeout) {
      clearTimeout(timeout);
      timeoutRefs.current.delete(id);
    }

    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  /**
   * Dismiss all notifications
   */
  const dismissAll = useCallback(() => {
    // Clear all pending timeouts
    timeoutRefs.current.forEach(clearTimeout);
    timeoutRefs.current.clear();

    setNotifications([]);
  }, []);

  /**
   * Add a notification
   */
  const addNotification = useCallback(
    (
      type: NotificationType,
      message: string,
      options?: NotificationOptions
    ) => {
      const id = `notification-${++idRef.current}`;
      const duration = options?.persistent
        ? 0
        : options?.duration ?? DEFAULT_DURATION;

      const notification: Notification = {
        id,
        type,
        message,
        duration,
        action: options?.action,
      };

      setNotifications((prev) => {
        // Keep max MAX_NOTIFICATIONS notifications (FIFO)
        const updated = [...prev, notification];
        if (updated.length > MAX_NOTIFICATIONS) {
          // Clear timeouts for notifications being removed
          const removedNotifications = updated.slice(
            0,
            updated.length - MAX_NOTIFICATIONS
          );
          removedNotifications.forEach((n) => {
            const timeout = timeoutRefs.current.get(n.id);
            if (timeout) {
              clearTimeout(timeout);
              timeoutRefs.current.delete(n.id);
            }
          });
          return updated.slice(-MAX_NOTIFICATIONS);
        }
        return updated;
      });

      // Set up auto-dismiss if duration > 0
      if (duration > 0) {
        const timeout = setTimeout(() => {
          dismiss(id);
        }, duration);
        timeoutRefs.current.set(id, timeout);
      }
    },
    [dismiss]
  );

  /**
   * Notify methods object
   */
  const notify: NotifyMethods = useMemo(
    () => ({
      success: (message: string, options?: NotificationOptions) =>
        addNotification("success", message, options),
      error: (message: string, options?: NotificationOptions) =>
        addNotification("error", message, options),
      warning: (message: string, options?: NotificationOptions) =>
        addNotification("warning", message, options),
      info: (message: string, options?: NotificationOptions) =>
        addNotification("info", message, options),
    }),
    [addNotification]
  );

  // Memoize context value to prevent unnecessary re-renders
  const contextValue = useMemo<NotificationContextValue>(
    () => ({
      notify,
      dismiss,
      dismissAll,
    }),
    [notify, dismiss, dismissAll]
  );

  // Expose notify to window for dev tools debugging (development only)
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__notify = notify;
    // Log once on initial mount only (not on every re-render)
    // The empty dep array below ensures this runs once
  }, []);

  return (
    <NotificationContext.Provider value={contextValue}>
      {children}
      <NotificationContainer notifications={notifications} onDismiss={dismiss} />
    </NotificationContext.Provider>
  );
}

export { NotificationContext };
export default NotificationContext;
