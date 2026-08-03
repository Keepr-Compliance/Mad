/**
 * Notification System Tests
 * Tests for NotificationProvider, useNotification hook, and notification components
 */
import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { NotificationProvider } from "../../../../contexts/NotificationContext";
import { useNotification } from "../../../../hooks/useNotification";
import { NotificationToast } from "../NotificationToast";
import { NotificationContainer } from "../NotificationContainer";
import type { Notification } from "../types";

// Test component that uses the notification hook
function TestConsumer({ onMount }: { onMount?: (notify: ReturnType<typeof useNotification>) => void }) {
  const notificationApi = useNotification();

  React.useEffect(() => {
    if (onMount) {
      onMount(notificationApi);
    }
  }, [notificationApi, onMount]);

  return (
    <div>
      <button onClick={() => notificationApi.notify.success("Success message")}>
        Show Success
      </button>
      <button onClick={() => notificationApi.notify.error("Error message")}>
        Show Error
      </button>
      <button onClick={() => notificationApi.notify.warning("Warning message")}>
        Show Warning
      </button>
      <button onClick={() => notificationApi.notify.info("Info message")}>
        Show Info
      </button>
      <button onClick={() => notificationApi.notify.success("Persistent", { persistent: true })}>
        Show Persistent
      </button>
      <button onClick={() => notificationApi.notify.success("Custom Duration", { duration: 1000 })}>
        Show Custom Duration
      </button>
      <button
        onClick={() =>
          notificationApi.notify.success("With Action", {
            action: { label: "Action", onClick: () => {} },
          })
        }
      >
        Show With Action
      </button>
      <button onClick={() => notificationApi.dismissAll()}>
        Dismiss All
      </button>
    </div>
  );
}

describe("NotificationProvider", () => {
  it("renders children", () => {
    render(
      <NotificationProvider>
        <div data-testid="child">Child content</div>
      </NotificationProvider>
    );

    expect(screen.getByTestId("child")).toBeInTheDocument();
    expect(screen.getByText("Child content")).toBeInTheDocument();
  });

  it("does not render container when no notifications", () => {
    render(
      <NotificationProvider>
        <div>Content</div>
      </NotificationProvider>
    );

    expect(screen.queryByTestId("notification-container")).not.toBeInTheDocument();
  });
});

describe("useNotification hook", () => {
  it("throws error when used outside provider", () => {
    // Suppress console.error for this test
    const originalError = console.error;
    console.error = jest.fn();

    function BadComponent() {
      useNotification();
      return null;
    }

    expect(() => render(<BadComponent />)).toThrow(
      "useNotification must be used within a NotificationProvider"
    );

    console.error = originalError;
  });

  it("returns notify methods", () => {
    let notificationApi: ReturnType<typeof useNotification> | null = null;

    render(
      <NotificationProvider>
        <TestConsumer
          onMount={(api) => {
            notificationApi = api;
          }}
        />
      </NotificationProvider>
    );

    expect(notificationApi).not.toBeNull();
    expect(notificationApi!.notify.success).toBeInstanceOf(Function);
    expect(notificationApi!.notify.error).toBeInstanceOf(Function);
    expect(notificationApi!.notify.warning).toBeInstanceOf(Function);
    expect(notificationApi!.notify.info).toBeInstanceOf(Function);
    expect(notificationApi!.dismiss).toBeInstanceOf(Function);
    expect(notificationApi!.dismissAll).toBeInstanceOf(Function);
  });
});

describe("notify methods", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("notify.success adds success notification", () => {
    render(
      <NotificationProvider>
        <TestConsumer />
      </NotificationProvider>
    );

    fireEvent.click(screen.getByText("Show Success"));

    expect(screen.getByTestId("notification-success")).toBeInTheDocument();
    expect(screen.getByText("Success message")).toBeInTheDocument();
  });

  it("notify.error adds error notification", () => {
    render(
      <NotificationProvider>
        <TestConsumer />
      </NotificationProvider>
    );

    fireEvent.click(screen.getByText("Show Error"));

    expect(screen.getByTestId("notification-error")).toBeInTheDocument();
    expect(screen.getByText("Error message")).toBeInTheDocument();
  });

  it("notify.warning adds warning notification", () => {
    render(
      <NotificationProvider>
        <TestConsumer />
      </NotificationProvider>
    );

    fireEvent.click(screen.getByText("Show Warning"));

    expect(screen.getByTestId("notification-warning")).toBeInTheDocument();
    expect(screen.getByText("Warning message")).toBeInTheDocument();
  });

  it("notify.info adds info notification", () => {
    render(
      <NotificationProvider>
        <TestConsumer />
      </NotificationProvider>
    );

    fireEvent.click(screen.getByText("Show Info"));

    expect(screen.getByTestId("notification-info")).toBeInTheDocument();
    expect(screen.getByText("Info message")).toBeInTheDocument();
  });

  it("auto-dismiss removes notification after duration", async () => {
    render(
      <NotificationProvider>
        <TestConsumer />
      </NotificationProvider>
    );

    fireEvent.click(screen.getByText("Show Success"));
    expect(screen.getByText("Success message")).toBeInTheDocument();

    // BACKLOG-2447: the default is 5000ms, not 3000ms. The two toast systems
    // disagreed (3000 here, 5000 in the deleted useToast); unified on the
    // longer value so migrated callers did not lose 2s of read time.
    act(() => {
      jest.advanceTimersByTime(4000);
    });
    expect(screen.getByText("Success message")).toBeInTheDocument();

    act(() => {
      jest.advanceTimersByTime(1500);
    });

    await waitFor(() => {
      expect(screen.queryByText("Success message")).not.toBeInTheDocument();
    });
  });

  it("persistent notification does not auto-dismiss", async () => {
    render(
      <NotificationProvider>
        <TestConsumer />
      </NotificationProvider>
    );

    fireEvent.click(screen.getByText("Show Persistent"));
    expect(screen.getByText("Persistent")).toBeInTheDocument();

    // Fast-forward well past the default duration
    act(() => {
      jest.advanceTimersByTime(10000);
    });

    // Should still be visible
    expect(screen.getByText("Persistent")).toBeInTheDocument();
  });

  it("custom duration works correctly", async () => {
    render(
      <NotificationProvider>
        <TestConsumer />
      </NotificationProvider>
    );

    fireEvent.click(screen.getByText("Show Custom Duration"));
    expect(screen.getByText("Custom Duration")).toBeInTheDocument();

    // Advance just past 1000ms
    act(() => {
      jest.advanceTimersByTime(1100);
    });

    await waitFor(() => {
      expect(screen.queryByText("Custom Duration")).not.toBeInTheDocument();
    });
  });

  it("manual dismiss removes notification", () => {
    render(
      <NotificationProvider>
        <TestConsumer />
      </NotificationProvider>
    );

    fireEvent.click(screen.getByText("Show Success"));
    expect(screen.getByText("Success message")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("notification-dismiss"));

    expect(screen.queryByText("Success message")).not.toBeInTheDocument();
  });

  it("dismissAll removes all notifications", () => {
    render(
      <NotificationProvider>
        <TestConsumer />
      </NotificationProvider>
    );

    // Add multiple notifications
    fireEvent.click(screen.getByText("Show Success"));
    fireEvent.click(screen.getByText("Show Error"));
    fireEvent.click(screen.getByText("Show Warning"));

    expect(screen.getByText("Success message")).toBeInTheDocument();
    expect(screen.getByText("Error message")).toBeInTheDocument();
    expect(screen.getByText("Warning message")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Dismiss All"));

    expect(screen.queryByText("Success message")).not.toBeInTheDocument();
    expect(screen.queryByText("Error message")).not.toBeInTheDocument();
    expect(screen.queryByText("Warning message")).not.toBeInTheDocument();
  });

  it("action button renders and triggers callback when clicked", () => {
    const actionFn = jest.fn();

    function ActionTestConsumer() {
      const { notify } = useNotification();

      return (
        <button
          onClick={() =>
            notify.success("Action notification", {
              action: { label: "Click Me", onClick: actionFn },
            })
          }
        >
          Show With Action
        </button>
      );
    }

    render(
      <NotificationProvider>
        <ActionTestConsumer />
      </NotificationProvider>
    );

    fireEvent.click(screen.getByText("Show With Action"));
    expect(screen.getByText("Action notification")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("notification-action"));
    expect(actionFn).toHaveBeenCalledTimes(1);
  });

  it("max 5 notifications maintained", () => {
    function ManyNotificationsConsumer() {
      const { notify } = useNotification();

      return (
        <button
          onClick={() => {
            for (let i = 1; i <= 7; i++) {
              notify.info(`Message ${i}`, { persistent: true });
            }
          }}
        >
          Add 7 Notifications
        </button>
      );
    }

    render(
      <NotificationProvider>
        <ManyNotificationsConsumer />
      </NotificationProvider>
    );

    fireEvent.click(screen.getByText("Add 7 Notifications"));

    // Should only have 5 notifications visible (the last 5)
    const notifications = screen.getAllByTestId("notification-info");
    expect(notifications).toHaveLength(5);

    // First two should be removed (FIFO)
    expect(screen.queryByText("Message 1")).not.toBeInTheDocument();
    expect(screen.queryByText("Message 2")).not.toBeInTheDocument();

    // Last 5 should be present
    expect(screen.getByText("Message 3")).toBeInTheDocument();
    expect(screen.getByText("Message 4")).toBeInTheDocument();
    expect(screen.getByText("Message 5")).toBeInTheDocument();
    expect(screen.getByText("Message 6")).toBeInTheDocument();
    expect(screen.getByText("Message 7")).toBeInTheDocument();
  });
});

describe("NotificationToast", () => {
  const baseNotification: Notification = {
    id: "test-1",
    type: "success",
    message: "Test message",
    duration: 3000,
  };

  it("renders success styling correctly", () => {
    const onDismiss = jest.fn();
    render(<NotificationToast notification={baseNotification} onDismiss={onDismiss} />);

    const toast = screen.getByTestId("notification-success");
    expect(toast).toHaveClass("bg-green-50", "border-green-200", "text-green-900");
  });

  it("renders error styling correctly", () => {
    const onDismiss = jest.fn();
    render(
      <NotificationToast
        notification={{ ...baseNotification, type: "error" }}
        onDismiss={onDismiss}
      />
    );

    const toast = screen.getByTestId("notification-error");
    expect(toast).toHaveClass("bg-red-50", "border-red-200", "text-red-900");
  });

  it("renders warning styling correctly", () => {
    const onDismiss = jest.fn();
    render(
      <NotificationToast
        notification={{ ...baseNotification, type: "warning" }}
        onDismiss={onDismiss}
      />
    );

    const toast = screen.getByTestId("notification-warning");
    expect(toast).toHaveClass("bg-amber-50", "border-amber-200", "text-amber-900");
  });

  it("renders info styling correctly", () => {
    const onDismiss = jest.fn();
    render(
      <NotificationToast
        notification={{ ...baseNotification, type: "info" }}
        onDismiss={onDismiss}
      />
    );

    const toast = screen.getByTestId("notification-info");
    expect(toast).toHaveClass("bg-blue-50", "border-blue-200", "text-blue-900");
  });

  it("calls onDismiss when dismiss button clicked", () => {
    const onDismiss = jest.fn();
    render(<NotificationToast notification={baseNotification} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByTestId("notification-dismiss"));
    expect(onDismiss).toHaveBeenCalledWith("test-1");
  });

  it("renders action button when provided", () => {
    const onDismiss = jest.fn();
    const actionFn = jest.fn();
    render(
      <NotificationToast
        notification={{
          ...baseNotification,
          action: { label: "View", onClick: actionFn },
        }}
        onDismiss={onDismiss}
      />
    );

    const actionButton = screen.getByTestId("notification-action");
    expect(actionButton).toHaveTextContent("View");

    fireEvent.click(actionButton);
    expect(actionFn).toHaveBeenCalledTimes(1);
  });

  it("does not render action button when not provided", () => {
    const onDismiss = jest.fn();
    render(<NotificationToast notification={baseNotification} onDismiss={onDismiss} />);

    expect(screen.queryByTestId("notification-action")).not.toBeInTheDocument();
  });
});

describe("NotificationContainer", () => {
  it("returns null when no notifications", () => {
    const { container } = render(
      <NotificationContainer notifications={[]} onDismiss={jest.fn()} />
    );

    expect(container.firstChild).toBeNull();
  });

  it("renders all notifications", () => {
    const notifications: Notification[] = [
      { id: "1", type: "success", message: "First", duration: 3000 },
      { id: "2", type: "error", message: "Second", duration: 3000 },
      { id: "3", type: "warning", message: "Third", duration: 3000 },
    ];

    render(<NotificationContainer notifications={notifications} onDismiss={jest.fn()} />);

    expect(screen.getByText("First")).toBeInTheDocument();
    expect(screen.getByText("Second")).toBeInTheDocument();
    expect(screen.getByText("Third")).toBeInTheDocument();
  });

  it("has correct accessibility attributes", () => {
    const notifications: Notification[] = [
      { id: "1", type: "info", message: "Test", duration: 3000 },
    ];

    render(<NotificationContainer notifications={notifications} onDismiss={jest.fn()} />);

    const container = screen.getByTestId("notification-container");
    expect(container).toHaveAttribute("role", "region");
    expect(container).toHaveAttribute("aria-live", "polite");
    expect(container).toHaveAttribute("aria-label", "Notifications");
  });

  it("passes onDismiss to each toast", () => {
    const onDismiss = jest.fn();
    const notifications: Notification[] = [
      { id: "1", type: "info", message: "Test", duration: 3000 },
    ];

    render(<NotificationContainer notifications={notifications} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByTestId("notification-dismiss"));
    expect(onDismiss).toHaveBeenCalledWith("1");
  });
});
