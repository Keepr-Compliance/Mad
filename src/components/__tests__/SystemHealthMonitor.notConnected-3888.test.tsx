/**
 * BACKLOG-3888 — the amber strip for a recorded provider with no mailbox
 * connected: same component and style as the expired-connection strip, a
 * "Connect" button that lands on that provider's Connect button in Settings,
 * Dismiss as today, and the row goes away as soon as a mailbox connects.
 *
 * Harness copied from SystemHealthMonitor.test.tsx. The issue rows are
 * transcribed from electron/services/mailboxNotConnectedIssue.ts
 * (mailboxNotConnectedIssue), which diagnosticHandlers pushes for this case.
 */

import { render, screen, fireEvent, act } from "@testing-library/react";
import SystemHealthMonitor from "../SystemHealthMonitor";
import { emitEmailConnectionChanged } from "../../utils/emailConnectionEvents";

const mockHealthCheck = jest.fn();
jest.mock("../../services", () => ({
  systemService: {
    healthCheck: (...args: unknown[]) => mockHealthCheck(...args),
    openPrivacyPane: jest.fn(),
    openFullDiskAccessSettings: jest.fn(),
    checkMessagesPermission: jest.fn(),
  },
  authService: {
    googleConnectMailbox: jest.fn(),
    microsoftConnectMailbox: jest.fn(),
    onMailboxConnected: jest.fn(),
  },
}));

const OUTLOOK_ROW = {
  type: "NOT_CONNECTED",
  severity: "warning",
  action: "Connect",
  provider: "microsoft",
  userMessage: "Your Outlook mailbox isn't connected. Connect to keep capturing email.",
  actionHandler: "connect-microsoft",
};
const GMAIL_ROW = {
  ...OUTLOOK_ROW,
  provider: "google",
  userMessage: "Your Gmail mailbox isn't connected. Connect to keep capturing email.",
  actionHandler: "connect-google",
};
const BOTH_ROW = {
  ...OUTLOOK_ROW,
  userMessage: "Your email isn't connected. Connect to keep capturing email.",
  actionHandler: "connect-email",
};
const EXPIRED_ROW = {
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

/** Stand-ins for the Settings elements the navigation looks for. */
function mountSettingsTargets(): Record<string, HTMLElement> {
  const ids = [
    "email-connection-microsoft-connect",
    "email-connection-google-connect",
    "emails-block-sources",
  ];
  const out: Record<string, HTMLElement> = {};
  const section = document.createElement("div");
  section.id = "settings-email";
  section.scrollIntoView = jest.fn();
  document.body.appendChild(section);
  out["settings-email"] = section;
  for (const id of ids) {
    const el = document.createElement("div");
    el.setAttribute("data-testid", id);
    el.scrollIntoView = jest.fn();
    section.appendChild(el);
    out[id] = el;
  }
  return out;
}

async function renderAndCheck(onOpenSettings = jest.fn()) {
  render(<SystemHealthMonitor userId="user-1" provider="microsoft" onOpenSettings={onOpenSettings} />);
  await act(async () => {
    jest.advanceTimersByTime(3000);
    await Promise.resolve();
  });
  return onOpenSettings;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  document.body.replaceChildren();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("BACKLOG-3888 — amber 'connect' strip", () => {
  it("renders the Outlook row in the amber family with a Connect button and Dismiss", async () => {
    mockHealthCheck.mockResolvedValue(healthResult([OUTLOOK_ROW]));
    await renderAndCheck();
    const title = screen.getByText(OUTLOOK_ROW.userMessage);
    expect(title.className).toContain("text-amber-900");
    expect(screen.getByRole("button", { name: "Connect" }).className).toContain("bg-amber-500");
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["Outlook", OUTLOOK_ROW, "email-connection-microsoft-connect"],
    ["Gmail", GMAIL_ROW, "email-connection-google-connect"],
    ["both", BOTH_ROW, "emails-block-sources"],
  ])("%s: Connect opens Settings and lands on %s", async (_n, row, target) => {
    const targets = mountSettingsTargets();
    mockHealthCheck.mockResolvedValue(healthResult([row]));
    const onOpenSettings = await renderAndCheck();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    act(() => {
      jest.advanceTimersByTime(150);
    });
    expect(targets[target].scrollIntoView).toHaveBeenCalledTimes(1);
    expect(targets[target].classList.contains("ring-amber-400")).toBe(true);
    for (const [id, el] of Object.entries(targets)) {
      if (id !== target) expect(el.scrollIntoView).not.toHaveBeenCalled();
    }
  });

  it("waits for the Connect button to appear (Settings still loading) instead of settling for the section", async () => {
    const targets = mountSettingsTargets();
    const button = targets["email-connection-microsoft-connect"];
    button.remove(); // not rendered yet
    mockHealthCheck.mockResolvedValue(healthResult([OUTLOOK_ROW]));
    await renderAndCheck();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    act(() => {
      jest.advanceTimersByTime(150 + 3 * 150);
    });
    targets["settings-email"].appendChild(button); // connection status loaded
    act(() => {
      jest.advanceTimersByTime(150);
    });
    expect(button.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(targets["settings-email"].scrollIntoView).not.toHaveBeenCalled();
  });

  it("falls back to the section if the button never appears", async () => {
    const targets = mountSettingsTargets();
    targets["email-connection-microsoft-connect"].remove();
    mockHealthCheck.mockResolvedValue(healthResult([OUTLOOK_ROW]));
    await renderAndCheck();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(targets["settings-email"].scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("the expired-token Reconnect row still lands on the section, not a Connect button", async () => {
    const targets = mountSettingsTargets();
    mockHealthCheck.mockResolvedValue(healthResult([EXPIRED_ROW]));
    await renderAndCheck();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    act(() => {
      jest.advanceTimersByTime(150);
    });
    expect(targets["settings-email"].scrollIntoView).toHaveBeenCalledTimes(1);
    expect(targets["email-connection-microsoft-connect"].scrollIntoView).not.toHaveBeenCalled();
  });

  it("Dismiss hides it", async () => {
    mockHealthCheck.mockResolvedValue(healthResult([OUTLOOK_ROW]));
    await renderAndCheck();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(OUTLOOK_ROW.userMessage)).not.toBeInTheDocument();
  });

  it("connecting a mailbox re-checks at once and the strip goes away (no 2-minute wait)", async () => {
    mockHealthCheck.mockResolvedValue(healthResult([OUTLOOK_ROW]));
    await renderAndCheck();
    expect(screen.getByText(OUTLOOK_ROW.userMessage)).toBeInTheDocument();

    mockHealthCheck.mockResolvedValue(healthResult([]));
    await act(async () => {
      emitEmailConnectionChanged({ connected: true, email: "b@example.com", provider: "microsoft" });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockHealthCheck).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(OUTLOOK_ROW.userMessage)).not.toBeInTheDocument();
  });

  it("a disconnect event does not trigger a re-check", async () => {
    mockHealthCheck.mockResolvedValue(healthResult([]));
    await renderAndCheck();
    await act(async () => {
      emitEmailConnectionChanged({ connected: false, provider: "microsoft" });
      await Promise.resolve();
    });
    expect(mockHealthCheck).toHaveBeenCalledTimes(1);
  });

  it("nothing is shown before the first (delayed) health check -> no flash at startup", async () => {
    mockHealthCheck.mockResolvedValue(healthResult([OUTLOOK_ROW]));
    render(<SystemHealthMonitor userId="user-1" provider="microsoft" onOpenSettings={jest.fn()} />);
    expect(screen.queryByText(OUTLOOK_ROW.userMessage)).not.toBeInTheDocument();
    expect(mockHealthCheck).not.toHaveBeenCalled();
  });
});
