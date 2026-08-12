/**
 * NotificationContainer Component
 * Container for stacking multiple notifications at bottom-right of screen.
 *
 * BACKLOG-2447: this is the ONLY toast container in the app. The former
 * parallel system (`useToast` + `Toast.tsx`) rendered its own container at
 * `bottom-4 right-4` while this one rendered at `top-16 right-4`, so which
 * corner a message appeared in depended on which screen you were on. That
 * system is deleted; every caller now goes through `useNotification`.
 *
 * Do not move the position below, and do not add a second fixed-position
 * notification container elsewhere. Both are asserted; a violation fails the
 * suite rather than needing anyone to have read this.
 *
 * (No test filename is named here on purpose. The first draft of this comment
 * pointed at a test that did not exist, which would have told a maintainer the
 * position was unguarded — the exact mistake the comment was written to
 * prevent. See BACKLOG-2454.)
 */
import React from "react";
import { NotificationToast } from "./NotificationToast";
import type { Notification } from "./types";

interface NotificationContainerProps {
  notifications: Notification[];
  onDismiss: (id: string) => void;
}

/**
 * NotificationContainer - Renders stacked notifications
 * Positioned fixed at bottom-right with proper z-index layering.
 *
 * `bottom-4 right-4` is the exact position the deleted `ToastContainer` used,
 * so screens that moved off it are visually unchanged. The support-access
 * banner (BACKLOG-2431) sits at `bottom-4 left-4` and does not overlap.
 */
export function NotificationContainer({
  notifications,
  onDismiss,
}: NotificationContainerProps): React.ReactElement | null {
  if (notifications.length === 0) {
    return null;
  }

  return (
    <div
      className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-md"
      role="region"
      aria-live="polite"
      aria-label="Notifications"
      data-testid="notification-container"
    >
      {notifications.map((notification) => (
        <NotificationToast
          key={notification.id}
          notification={notification}
          onDismiss={onDismiss}
        />
      ))}
    </div>
  );
}

export default NotificationContainer;
