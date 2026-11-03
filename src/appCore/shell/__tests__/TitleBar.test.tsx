/**
 * BACKLOG-3964 slice 1 — TitleBar / AccountButton unit tests.
 * The AppShell-level pins live in appCore/__tests__/AppShell.titleBar.test.tsx.
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TitleBar } from "../TitleBar";
import { getAccountInitials } from "../AccountButton";
import type { AppStep, AppUser } from "../../state/types";

const user: AppUser = { id: "u1", email: "avery@example.com", display_name: "Avery Example" };

const renderBar = (over: Partial<React.ComponentProps<typeof TitleBar>> = {}) => {
  const props = {
    runningInElectron: true,
    currentStep: "dashboard" as AppStep,
    isAuthenticated: true,
    currentUser: user,
    title: "Dashboard",
    onOpenAccount: jest.fn(),
    ...over,
  };
  return { props, ...render(<TitleBar {...props} />) };
};

describe("TitleBar (Electron)", () => {
  it("renders the title it is given", () => {
    renderBar({ title: "Settings" });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Settings");
  });

  it("calls onOpenAccount when the initials are clicked", () => {
    const { props } = renderBar();
    fireEvent.click(screen.getByTestId("nav-profile"));
    expect(props.onOpenAccount).toHaveBeenCalledTimes(1);
  });

  it("puts the initials in the RIGHT slot and keeps an empty left spacer (BACKLOG-4112)", () => {
    renderBar();
    const btn = screen.getByTestId("nav-profile");
    const bar = screen.getByTestId("title-bar");
    expect(bar.children).toHaveLength(3);
    expect(bar.firstElementChild).toHaveClass("w-8");
    expect(bar.firstElementChild).toBeEmptyDOMElement();
    expect(bar.children[1].tagName).toBe("H1");
    expect(bar.lastElementChild).toBe(screen.getByTestId("title-bar-right"));
    expect(bar.lastElementChild).toContainElement(btn);
    expect(bar.lastElementChild).toHaveClass("justify-end");
    expect(btn).toHaveClass("no-drag-region");
    expect(bar).toHaveClass("pl-4", "pr-4");
  });

  it("on macOS starts the left slot past the traffic lights", () => {
    renderBar({ isMacOS: true });
    expect(screen.getByTestId("title-bar")).toHaveClass("pl-20");
    expect(screen.getByTestId("title-bar")).not.toHaveClass("pl-4");
  });

  it("marks the initials expanded while the account panel is open", () => {
    renderBar({ accountOpen: true });
    const btn = screen.getByTestId("nav-profile");
    expect(btn).toHaveAttribute("aria-expanded", "true");
    expect(btn).toHaveAttribute("aria-haspopup", "dialog");
  });

  it("renders nothing on the login step", () => {
    const { container } = renderBar({ currentStep: "login" });
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the title without initials when not authenticated", () => {
    renderBar({ isAuthenticated: false });
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(screen.queryByTestId("nav-profile")).not.toBeInTheDocument();
  });
});

describe("TitleBar (mobile)", () => {
  it("is hidden at lg, has no drag opt-out, and opens the account", () => {
    const { props } = renderBar({ runningInElectron: false });
    const btn = screen.getByTestId("nav-profile");
    expect(btn).not.toHaveClass("no-drag-region");
    expect(btn.parentElement).toHaveClass("lg:hidden");
    expect(btn.parentElement?.firstElementChild).toBe(btn); // initials left
    fireEvent.click(btn);
    expect(props.onOpenAccount).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when signed out", () => {
    const { container } = renderBar({ runningInElectron: false, isAuthenticated: false });
    expect(container).toBeEmptyDOMElement();
  });
});

describe("getAccountInitials (two letters, SR R3b)", () => {
  it.each([
    [{ display_name: "avery example", email: "x@y.z" }, "AE"],
    [{ display_name: "Ann Lee", email: "x@y.z" }, "AL"],
    [{ display_name: "  Ann   Mary Lee ", email: "x@y.z" }, "AM"],
    [{ display_name: "ann", email: "x@y.z" }, "A"],
    [{ display_name: undefined, email: "mia@x.io" }, "M"],
    [{ display_name: "", email: "" }, "?"],
  ])("%o -> %s", (u, expected) => {
    expect(getAccountInitials(u)).toBe(expected);
  });
});

/**
 * BACKLOG-4110: the hairline and title ink are app-wide, so the check renders
 * NON-dashboard titles. A dashboard-only conditional would fail here.
 */
describe("TitleBar colours (BACKLOG-4110)", () => {
  it.each(["Transactions", "Clients & Contacts", "Settings"])(
    "%s: warm hairline, ink title, no gray border",
    (title) => {
      renderBar({ title, currentStep: "dashboard" as AppStep });
      const bar = screen.getByTestId("title-bar");
      expect(bar).toHaveClass("border-b", "border-warm-line");
      expect(bar).not.toHaveClass("border-gray-200");
      const h1 = screen.getByRole("heading", { level: 1 });
      expect(h1).toHaveTextContent(title);
      expect(h1).toHaveClass("text-ink");
      expect(h1).not.toHaveClass("text-gray-700");
    },
  );
});
