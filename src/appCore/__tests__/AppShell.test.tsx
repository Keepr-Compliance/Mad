/**
 * Tests for AppShell drag-region behavior (BACKLOG-1790)
 *
 * The AppShell title bar is no longer a drag region of its own — the single
 * global drag surface is WindowDragStrip (rendered in App.tsx). Interactive
 * elements that geometrically overlap that top strip (the profile button)
 * must carry .no-drag-region so their clicks are not swallowed by the
 * Electron drag rect.
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AppShell } from "../AppShell";
import type { AppStateMachine } from "../state/types";

// Isolate from IPC-heavy children/hooks
jest.mock("../../hooks/useSessionValidator", () => ({
  useSessionValidator: jest.fn(),
}));
// BACKLOG-3219: the mock records `hidden`, because AppShell's job for the tour
// / terms-pending case is to PASS that prop, not to unmount the monitor — the
// component suppresses itself on it (SystemHealthMonitor.tsx: `if (hidden ||
// visibleIssues.length === 0) return null`). A mock that swallowed the prop
// would make that state unassertable here.
jest.mock("../../components/SystemHealthMonitor", () => {
  const MockMonitor = ({ hidden }: { hidden?: boolean }) => (
    <div data-testid="system-health-monitor" data-hidden={String(!!hidden)} />
  );
  MockMonitor.displayName = "SystemHealthMonitor";
  return { __esModule: true, default: MockMonitor };
});

const mockUser = {
  id: "user-123",
  email: "test@example.com",
  display_name: "Test User",
  avatar_url: undefined,
};

const createShellAppMock = (
  overrides: Partial<AppStateMachine> = {}
): AppStateMachine =>
  ({
    currentStep: "dashboard",
    isAuthenticated: true,
    isDatabaseInitialized: true,
    currentUser: mockUser,
    authProvider: "google",
    hasPermissions: true,
    hasEmailConnected: false,
    isTourActive: false,
    needsTermsAcceptance: false,
    isOnline: true,
    isChecking: false,
    openProfile: jest.fn(),
    openSettings: jest.fn(),
    handleRetryConnection: jest.fn(),
    handleLogout: jest.fn(),
    getPageTitle: jest.fn().mockReturnValue("Dashboard"),
    ...overrides,
  }) as unknown as AppStateMachine;

describe("AppShell drag regions (BACKLOG-1790)", () => {
  it("does not declare any drag region of its own (WindowDragStrip owns dragging)", () => {
    const { container } = render(
      <AppShell app={createShellAppMock()}>
        <div>content</div>
      </AppShell>
    );
    expect(container.querySelector(".drag-region")).toBeNull();
  });

  it("profile button in the title-bar band opts out with no-drag-region and stays clickable", () => {
    const openProfile = jest.fn();
    render(
      <AppShell app={createShellAppMock({ openProfile })}>
        <div>content</div>
      </AppShell>
    );

    const profileButton = screen.getByTitle(/Click for account settings/);
    expect(profileButton).toHaveClass("no-drag-region");

    fireEvent.click(profileButton);
    expect(openProfile).toHaveBeenCalledTimes(1);
  });

  it("DB-init loading screen has no local drag strip (global strip covers it)", () => {
    const { container } = render(
      <AppShell
        app={createShellAppMock({ isDatabaseInitialized: false })}
      >
        <div>content</div>
      </AppShell>
    );
    expect(container.querySelector(".drag-region")).toBeNull();
    expect(
      screen.getByText(/Initializing secure storage/)
    ).toBeInTheDocument();
  });
});

describe("SystemHealthMonitor mount gate (BACKLOG-2127)", () => {
  it("mounts on the dashboard even when hasEmailConnected is false", () => {
    // The whole point: the reconnect banner must be able to render when a
    // stored connection's token breaks (hasEmailConnected flips false).
    render(
      <AppShell app={createShellAppMock({ hasEmailConnected: false })}>
        <div>content</div>
      </AppShell>
    );
    expect(screen.getByTestId("system-health-monitor")).toBeInTheDocument();
  });

  it("still does NOT mount when not on the dashboard", () => {
    // "onboarding" is NOT a member of AppStep (the real onboarding steps are
    // "phone-type-selection" / "email-onboarding" / "permissions"). The
    // assertion only depends on the value not being "dashboard", so the literal
    // is preserved and widened rather than corrected here.
    render(
      <AppShell
        app={createShellAppMock({
          currentStep: "onboarding" as unknown as AppStateMachine["currentStep"],
          hasEmailConnected: true,
        })}
      >
        <div>content</div>
      </AppShell>
    );
    expect(screen.queryByTestId("system-health-monitor")).not.toBeInTheDocument();
  });

});

/**
 * BACKLOG-3219 — the banner that reports a missing permission used to be gated
 * on that permission being present.
 *
 * The assertion this replaces ("still does NOT mount without permissions") was
 * the bug, written down and passing. It is deleted rather than skipped: it
 * asserted the inversion, so leaving it green in any form would keep the fix
 * from being provable.
 *
 * Before BACKLOG-3212 a user without Full Disk Access never reached the
 * dashboard, so the gate was never exercised in the failing direction. 3212
 * correctly releases a user who skipped, and that is what made it reachable.
 */
describe("SystemHealthMonitor permission gate (BACKLOG-3219)", () => {
  it("STATE 1 — mounts on the dashboard when permissions are MISSING", () => {
    // The population the banner exists for. This is the assertion the old gate
    // made impossible.
    render(
      <AppShell app={createShellAppMock({ hasPermissions: false })}>
        <div>content</div>
      </AppShell>
    );
    expect(screen.getByTestId("system-health-monitor")).toBeInTheDocument();
  });

  it("STATE 2 — still mounts when permissions are granted (nothing else changed)", () => {
    // The monitor decides its own visibility from the health check; mounting is
    // not the same as showing. That half of state 2 — granted and quiet renders
    // NOTHING — is asserted in SystemHealthMonitor.test.tsx, where the health
    // result is real enough to be empty.
    render(
      <AppShell app={createShellAppMock({ hasPermissions: true })}>
        <div>content</div>
      </AppShell>
    );
    expect(screen.getByTestId("system-health-monitor")).toBeInTheDocument();
  });

  it("STATE 3 — a missing permission during the tour is passed hidden, not unmounted", () => {
    render(
      <AppShell
        app={createShellAppMock({ hasPermissions: false, isTourActive: true })}
      >
        <div>content</div>
      </AppShell>
    );
    expect(screen.getByTestId("system-health-monitor")).toHaveAttribute(
      "data-hidden",
      "true"
    );
  });

  it("STATE 3 — the same for a pending terms acceptance", () => {
    render(
      <AppShell
        app={createShellAppMock({
          hasPermissions: false,
          needsTermsAcceptance: true,
        })}
      >
        <div>content</div>
      </AppShell>
    );
    expect(screen.getByTestId("system-health-monitor")).toHaveAttribute(
      "data-hidden",
      "true"
    );
  });

  it("is NOT hidden when neither the tour nor terms are pending", () => {
    // Pairs with the two above: without this, a `hidden` hard-wired to true
    // would satisfy them both.
    render(
      <AppShell app={createShellAppMock({ hasPermissions: false })}>
        <div>content</div>
      </AppShell>
    );
    expect(screen.getByTestId("system-health-monitor")).toHaveAttribute(
      "data-hidden",
      "false"
    );
  });

  it("the sibling conditions that were KEPT still gate the mount", () => {
    // Each of these was re-examined for BACKLOG-3219 and deliberately left in
    // place. Asserted so a later "simplify the gate" cannot quietly drop one.
    const off = (overrides: Partial<AppStateMachine>) => {
      const { unmount } = render(
        <AppShell app={createShellAppMock({ hasPermissions: false, ...overrides })}>
          <div>content</div>
        </AppShell>
      );
      const present = screen.queryByTestId("system-health-monitor") !== null;
      unmount();
      return present;
    };

    // Not on the dashboard — deliberate placement.
    expect(
      off({
        currentStep: "login" as unknown as AppStateMachine["currentStep"],
      })
    ).toBe(false);
    // No provider — it supplies the `provider` prop.
    expect(off({ authProvider: null })).toBe(false);
    // No user — `currentUser.id` is the userId prop and the remount key.
    expect(off({ currentUser: null as unknown as AppStateMachine["currentUser"] })).toBe(
      false
    );
  });
});
