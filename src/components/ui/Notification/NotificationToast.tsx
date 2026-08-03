/**
 * NotificationToast Component
 * Single notification toast with support for all variants and optional action button
 */
import React from "react";
import type { Notification, NotificationType } from "./types";

interface NotificationToastProps {
  notification: Notification;
  onDismiss: (id: string) => void;
}

/**
 * Get toast styling based on type
 */
function getToastStyles(type: NotificationType): {
  container: string;
  icon: string;
  iconPath: string;
} {
  switch (type) {
    case "success":
      return {
        container: "bg-green-50 border-green-200 text-green-900",
        icon: "text-green-600",
        iconPath: "M5 13l4 4L19 7",
      };
    case "error":
      return {
        container: "bg-red-50 border-red-200 text-red-900",
        icon: "text-red-600",
        iconPath: "M6 18L18 6M6 6l12 12",
      };
    case "warning":
      return {
        container: "bg-amber-50 border-amber-200 text-amber-900",
        icon: "text-amber-600",
        iconPath:
          "M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z",
      };
    case "info":
    default:
      return {
        container: "bg-blue-50 border-blue-200 text-blue-900",
        icon: "text-blue-600",
        iconPath:
          "M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
      };
  }
}

/**
 * NotificationToast - Single notification component
 */
export function NotificationToast({
  notification,
  onDismiss,
}: NotificationToastProps): React.ReactElement {
  const styles = getToastStyles(notification.type);

  return (
    <div
      className={`flex items-start gap-3 p-4 rounded-lg border shadow-lg animate-slide-in ${styles.container}`}
      role="alert"
      data-testid={`notification-${notification.type}`}
    >
      {/* Icon */}
      <svg
        className={`w-5 h-5 flex-shrink-0 mt-0.5 ${styles.icon}`}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d={styles.iconPath}
        />
      </svg>

      {/* Message — defensive: ensure non-string values don't crash React (#310) */}
      <p className="flex-1 text-sm font-medium">
        {typeof notification.message === 'string'
          ? notification.message
          : String(notification.message ?? 'An error occurred')}
      </p>

      {/* Action Button (optional).
          BACKLOG-2390 / BACKLOG-2447: run the action then dismiss, so the same
          notification cannot be actioned twice. The deleted `Toast.tsx` did
          this; this container did not, which would have made a double-click on
          "Undo" replay the undo. Carried over deliberately — do not drop the
          onDismiss call. */}
      {notification.action && (
        <button
          type="button"
          onClick={() => {
            notification.action?.onClick();
            onDismiss(notification.id);
          }}
          className="flex-shrink-0 text-sm font-medium underline hover:no-underline transition-all"
          data-testid="notification-action"
        >
          {notification.action.label}
        </button>
      )}

      {/* Dismiss Button */}
      <button
        onClick={() => onDismiss(notification.id)}
        className="flex-shrink-0 text-gray-400 hover:text-gray-600 transition-colors"
        aria-label="Dismiss notification"
        data-testid="notification-dismiss"
      >
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </button>
    </div>
  );
}

export default NotificationToast;
