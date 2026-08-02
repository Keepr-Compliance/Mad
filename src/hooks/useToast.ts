/**
 * Toast notification hook
 * Simple toast system for displaying success/error messages
 */
import { useState, useCallback, useRef } from "react";

export type ToastType = "success" | "error" | "warning" | "info";

/**
 * BACKLOG-2390: optional action button rendered inside a toast (e.g. "Undo").
 * Clicking it runs `onClick` and dismisses the toast.
 */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  /** BACKLOG-2390: optional inline action (e.g. Undo). */
  action?: ToastAction;
}

export interface UseToastReturn {
  toasts: Toast[];
  showToast: (message: string, type?: ToastType, action?: ToastAction) => void;
  showSuccess: (message: string, action?: ToastAction) => void;
  showError: (message: string) => void;
  showWarning: (message: string) => void;
  removeToast: (id: string) => void;
  clearAll: () => void;
}

/**
 * Custom hook for managing toast notifications
 * @param autoDismissMs - Time in ms before toasts auto-dismiss (default: 5000)
 * @returns Toast state and handler functions
 */
export function useToast(autoDismissMs = 5000): UseToastReturn {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextIdRef = useRef(0);

  const removeToast = useCallback((id: string): void => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(
    (message: string, type: ToastType = "info", action?: ToastAction): void => {
      const id = `toast-${nextIdRef.current++}`;
      const newToast: Toast = { id, message, type, action };

      setToasts((prev) => [...prev, newToast]);

      // Auto-dismiss after specified time
      if (autoDismissMs > 0) {
        setTimeout(() => {
          removeToast(id);
        }, autoDismissMs);
      }
    },
    [autoDismissMs, removeToast]
  );

  const showSuccess = useCallback(
    (message: string, action?: ToastAction): void => {
      showToast(message, "success", action);
    },
    [showToast]
  );

  const showError = useCallback(
    (message: string): void => {
      showToast(message, "error");
    },
    [showToast]
  );

  const showWarning = useCallback(
    (message: string): void => {
      showToast(message, "warning");
    },
    [showToast]
  );

  const clearAll = useCallback((): void => {
    setToasts([]);
  }, []);

  return {
    toasts,
    showToast,
    showSuccess,
    showError,
    showWarning,
    removeToast,
    clearAll,
  };
}
