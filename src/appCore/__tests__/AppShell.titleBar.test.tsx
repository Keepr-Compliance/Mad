/**
 * BACKLOG-3964 slice 1 — pins the title-bar behaviour AppShell renders.
 *
 * Written against AppShell BEFORE the title bar was extracted into
 * shell/TitleBar.tsx, and kept unchanged after, so it proves the move did not
 * alter what the user sees or what the initials button does.
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AppShell } from "../AppShell";
import type { AppStateMachine } from "../state/types";

let mockElectron = true;
var mockMac = false; // eslint-disable-line no-var -- read during import, before a let would initialise
jest.mock("../../utils/platform", () => ({
  ...jest.requireActual("../../utils/platform"),
  isElectron: () => mockElectron,
  isMacOS: () => mockMac,
}));
jest.mock("../../hooks/useSessionValidator", () => ({
  useSessionValidator: jest.fn(),
}));
jest.mock("../../hooks/useIdleSessionExpiry", () => ({
  useSessionIdleTimeout: jest.fn(),
}));
jest.mock("../../components/SystemHealthMonitor", () => {
  const MockMonitor = () => <div data-testid="system-health-monitor" />;
  MockMonitor.displayName = "SystemHealthMonitor";
  return { __esModule: true, default: MockMonitor };
});
jest.mock("../shell", () => ({
  ...jest.requireActual("../shell"),
  ShellBanners: () => null,
}));

const baseUser = {
  id: "user-123",
  email: "test@example.com",
  display_name: "Test User",
  avatar_url: undefined as string | undefined,
};

const makeApp = (overrides: Partial<AppStateMachine> = {}): AppStateMachine =>
  ({
    currentStep: "dashboard",
    isAuthenticated: true,
    isDatabaseInitialized: true,
    currentUser: baseUser,
    authProvider: "google",
    isTourActive: false,
    needsTermsAcceptance: false,
    openProfile: jest.fn(),
    openSettings: jest.fn(),
    handleLogout: jest.fn(),
    getPageTitle: jest.fn().mockReturnValue("Dashboard"),
    // BACKLOG-3964: AppShell reads showSettings (title + Settings layer).
    modalState: { showSettings: false },
    ...overrides,
  }) as unknown as AppStateMachine;

const renderShell = (app: AppStateMachine) =>
  render(
    <AppShell app={app}>
      <div data-testid="routed-content">content</div>
    </AppShell>
  );

beforeEach(() => {
  mockElectron = true;
  mockMac = false;
});

describe("Electron title bar platform offset (AppShell -> TitleBar wiring)", () => {
  it("Windows/Linux: pl-4, not the macOS pl-20, initials in the left slot", () => {
    mockMac = false;
    renderShell(makeApp());
    const bar = screen.getByTestId("title-bar");
    expect(bar).toHaveClass("pl-4");
    expect(bar).not.toHaveClass("pl-20");
    expect(screen.getByTestId("title-bar-left")).toContainElement(screen.getByTestId("nav-profile"));
  });

  it("macOS: pl-20 to clear the traffic lights", () => {
    mockMac = true;
    renderShell(makeApp());
    const bar = screen.getByTestId("title-bar");
    expect(bar).toHaveClass("pl-20");
    expect(bar).not.toHaveClass("pl-4");
  });
});

describe("Electron title bar", () => {
  it("shows the page title from getPageTitle", () => {
    renderShell(makeApp({ getPageTitle: jest.fn().mockReturnValue("Transactions") }));
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("Transactions");
    expect(heading).toHaveClass("text-sm", "font-semibold", "text-gray-700");
  });

  it("initials button opens the profile, once per click", () => {
    const openProfile = jest.fn();
    renderShell(makeApp({ openProfile }));
    fireEvent.click(screen.getByTestId("nav-profile"));
    expect(openProfile).toHaveBeenCalledTimes(1);
  });

  it("initials button keeps its tour hook, title, drag opt-out and sits on the LEFT (slice 3)", () => {
    renderShell(makeApp());
    const btn = screen.getByTestId("nav-profile");
    expect(btn).toHaveAttribute("data-tour", "profile-button");
    expect(btn).toHaveAttribute("title", "Test User - Click for account settings");
    expect(btn).toHaveClass("no-drag-region", "w-8", "h-8", "shrink-0", "rounded-full");
    // Bar order: initials slot, title, empty right spacer.
    const bar = screen.getByTestId("title-bar");
    expect(bar.children).toHaveLength(3);
    expect(bar.children[0]).toContainElement(btn);
    expect(bar.children[1].tagName).toBe("H1");
    expect(bar.children[2]).toHaveClass("w-8");
    expect(bar.children[2]).toBeEmptyDOMElement();
    expect(bar).toHaveClass("flex-shrink-0", "justify-between", "select-none", "bg-white", "py-3");
    expect(bar.className).not.toMatch(/gradient/);
  });

  it("title attr falls back to the email when there is no display name", () => {
    renderShell(makeApp({ currentUser: { ...baseUser, display_name: undefined } }));
    expect(screen.getByTestId("nav-profile")).toHaveAttribute(
      "title",
      "test@example.com - Click for account settings"
    );
  });

  it.each([
    ["two words -> two letters", { display_name: "Ann Lee", email: "a@b.c" }, "AL"],
    ["one word -> its first letter, upper-cased", { display_name: "zed", email: "a@b.c" }, "Z"],
    ["email first letter when no display name", { display_name: undefined, email: "mia@x.io" }, "M"],
    ["'?' when neither is set", { display_name: "", email: "" }, "?"],
  ])("shows the initials: %s", (_label, fields, expected) => {
    renderShell(makeApp({ currentUser: { ...baseUser, ...fields } }));
    expect(screen.getByTestId("nav-profile").textContent).toBe(expected);
  });

  it("shows the avatar image instead of initials when avatar_url is set", () => {
    renderShell(makeApp({ currentUser: { ...baseUser, avatar_url: "https://x/a.png" } }));
    const btn = screen.getByTestId("nav-profile");
    const img = btn.querySelector("img") as HTMLImageElement;
    expect(img).toHaveAttribute("src", "https://x/a.png");
    expect(img).toHaveAttribute("alt", "");
    expect(img).toHaveClass("h-full", "w-full", "object-cover");
    expect(btn.textContent).toBe("");
  });

  it("shows the bar but no initials button when signed out", () => {
    renderShell(makeApp({ isAuthenticated: false, currentUser: null }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Dashboard");
    expect(screen.queryByTestId("nav-profile")).not.toBeInTheDocument();
  });

  it("shows the bar but no initials button when authenticated with no user loaded", () => {
    renderShell(makeApp({ currentUser: null }));
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(screen.queryByTestId("nav-profile")).not.toBeInTheDocument();
  });

  it("is hidden on the login step", () => {
    renderShell(makeApp({ currentStep: "login" }));
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(screen.queryByTestId("nav-profile")).not.toBeInTheDocument();
  });

  it("still shows during an onboarding step", () => {
    renderShell(makeApp({ currentStep: "permissions" }));
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(screen.getByTestId("nav-profile")).toBeInTheDocument();
  });

  it("renders exactly one title bar, before the routed content", () => {
    const { container } = renderShell(makeApp());
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const shell = container.firstElementChild as HTMLElement;
    const heading = screen.getByRole("heading", { level: 1 });
    const content = screen.getByTestId("routed-content");
    expect(
      heading.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(shell.firstElementChild).toContainElement(heading);
  });
});

describe("Mobile (non-Electron) header", () => {
  beforeEach(() => {
    mockElectron = false;
  });

  it("shows title and initials, hidden at lg, with no drag opt-out", () => {
    const openProfile = jest.fn();
    renderShell(makeApp({ openProfile }));
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("Dashboard");
    expect(heading).toHaveClass("text-base", "font-semibold", "text-gray-900");
    const btn = screen.getByTestId("nav-profile");
    expect(btn).not.toHaveClass("no-drag-region");
    expect(btn).toHaveAttribute("data-tour", "profile-button");
    expect(btn).toHaveAttribute("title", "Test User - Click for account settings");
    expect(btn.textContent).toBe("TU");
    const bar = btn.parentElement as HTMLElement;
    expect(bar).toHaveClass("lg:hidden", "bg-white");
    // Order: initials left, then the title (slice 3); no spacer.
    expect(bar.children).toHaveLength(2);
    expect(bar.children[0]).toBe(btn);
    expect(bar.children[1]).toBe(heading);
    fireEvent.click(btn);
    expect(openProfile).toHaveBeenCalledTimes(1);
  });

  it("is absent entirely when signed out (no title either)", () => {
    renderShell(makeApp({ isAuthenticated: false, currentUser: null }));
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(screen.queryByTestId("nav-profile")).not.toBeInTheDocument();
  });

  it("is hidden on the login step", () => {
    renderShell(makeApp({ currentStep: "login" }));
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
  });
});
