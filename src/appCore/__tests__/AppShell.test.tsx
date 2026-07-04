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
jest.mock("../../components/SystemHealthMonitor", () => {
  const MockMonitor = () => <div data-testid="system-health-monitor" />;
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
