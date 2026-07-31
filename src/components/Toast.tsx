/**
 * Toast Component
 * Displays toast notifications for success/error/warning/info messages
 */
import React from "react";
import type { Toast as ToastType, ToastType as ToastVariant } from "../hooks/useToast";

interface ToastProps {
  toast: ToastType;
  onDismiss: (id: string) => void;
}

/**
 * Get toast styling based on type
 */
function getToastStyles(type: ToastVariant): {
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
 * Single toast notification
 */
function Toast({ toast, onDismiss }: ToastProps) {
  const styles = getToastStyles(toast.type);

  return (
    <div
      className={`flex items-start gap-3 p-4 rounded-lg border shadow-lg animate-slide-in ${styles.container}`}
      role="alert"
    >
      <svg
        className={`w-5 h-5 flex-shrink-0 mt-0.5 ${styles.icon}`}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d={styles.iconPath}
        />
      </svg>
      <p className="flex-1 text-sm font-medium">{toast.message}</p>
      {/* BACKLOG-2390: optional inline action (e.g. Undo). Runs the action then
          dismisses so the same toast can't be actioned twice. */}
      {toast.action && (
        <button
          type="button"
          onClick={() => {
            toast.action?.onClick();
            onDismiss(toast.id);
          }}
          className={`flex-shrink-0 text-sm font-semibold underline underline-offset-2 hover:opacity-80 transition-opacity ${styles.icon}`}
          data-testid="toast-action-button"
        >
          {toast.action.label}
        </button>
      )}
      <button
        onClick={() => onDismiss(toast.id)}
        className="flex-shrink-0 text-gray-400 hover:text-gray-600 transition-colors"
        aria-label="Dismiss"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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

interface ToastContainerProps {
  toasts: ToastType[];
  onDismiss: (id: string) => void;
}

/**
 * Container for rendering multiple toasts
 * Positioned fixed at bottom-right of screen
 */
export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  if (toasts.length === 0) {
    return null;
  }

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-md">
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

export default Toast;
