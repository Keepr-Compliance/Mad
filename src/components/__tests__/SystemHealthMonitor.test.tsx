/**
 * SystemHealthMonitor Tests (BACKLOG-2127)
 *
 * Focus of this iteration:
 * - CHANGE 2: the banner actually RENDERS a visible reconnect surface for a
 *   broken-token health issue (title + Reconnect action button), and clicking
 *   Reconnect routes to the shared email-settings navigation.
 * - CHANGE 4: the recoverable reconnect state renders in the AMBER family
 *   (not red), and there is no redundant subtitle echoing the button.
 *
 * These assert exact copy/testids/classes rather than counts.
 */

import { render, screen, fireEvent, act } from "@testing-library/react";
import SystemHealthMonitor from "../SystemHealthMonitor";

// Mock the services barrel that SystemHealthMonitor imports from.
const mockHealthCheck = jest.fn();
jest.mock("../../services", () => ({
  systemService: {
    healthCheck: (...args: unknown[]) => mockHealthCheck(...args),
    openPrivacyPane: jest.fn(),
  },
  authService: {
    googleConnectMailbox: jest.fn(),
    microsoftConnectMailbox: jest.fn(),
    onMailboxConnected: jest.fn(),
  },
}));

// A broken-Outlook health result as produced by system:health-check.
const brokenOutlookIssue = {
  type: "TOKEN_REFRESH_FAILED",
  provider: "microsoft",
  severity: "error",
  userMessage: "Your Outlook connection expired. Reconnect to keep capturing email.",
  action: "Reconnect",
  actionHandler: "reconnect-microsoft",
};

const healthResult = (issues: unknown[]) => ({
  success: true,
  data: { healthy: issues.length === 0, issues },
});

/** Render and fire the component's 3s initial-check timer. */
async function renderAndCheck(props: Partial<React.ComponentProps<typeof SystemHealthMonitor>> = {}) {
  const utils = render(
    <SystemHealthMonitor
      userId="user-1"
      provider="google"
      onOpenSettings={jest.fn()}
      {...props}
    />,
  );
  // Advance past the 3s initial delay and flush the async healthCheck.
  await act(async () => {
    jest.advanceTimersByTime(3000);
    await Promise.resolve();
  });
  return utils;
}

describe("SystemHealthMonitor (BACKLOG-2127)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockHealthCheck.mockResolvedValue(healthResult([brokenOutlookIssue]));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("renders a visible reconnect banner (title + Reconnect button) for a broken token", async () => {
    await renderAndCheck();

    // Title = the full reconnect sentence (userMessage).
    expect(
      screen.getByText("Your Outlook connection expired. Reconnect to keep capturing email."),
    ).toBeInTheDocument();
    // A visible action button labelled just "Reconnect".
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
  });

  it("clicking Reconnect opens Settings (shared email-settings navigation)", async () => {
    const onOpenSettings = jest.fn();
    await renderAndCheck({ onOpenSettings });

    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("renders the recoverable reconnect state in the AMBER family, not red (CHANGE 4)", async () => {
    await renderAndCheck();

    const title = screen.getByText(
      "Your Outlook connection expired. Reconnect to keep capturing email.",
    );
    // The banner row is the title's ancestor carrying the severity background.
    const banner = title.closest("div.border-b");
    expect(banner).not.toBeNull();
    // Amber (warning) palette — NOT the red error palette.
    expect(banner?.className).toContain("amber");
    expect(banner?.className).not.toContain("bg-red-50");
    // Button uses the amber CTA styling.
    expect(screen.getByRole("button", { name: "Reconnect" }).className).toContain("amber");
  });

  it("does NOT render a redundant subtitle that echoes the button (CHANGE 4)", async () => {
    await renderAndCheck();

    // The word "Reconnect" appears once — as the button — not also as a subtitle.
    expect(screen.getAllByText("Reconnect")).toHaveLength(1);
  });

  it("renders nothing when the health check reports no issues", async () => {
    mockHealthCheck.mockResolvedValue(healthResult([]));
    const { container } = await renderAndCheck();
    expect(container).toBeEmptyDOMElement();
  });
});
