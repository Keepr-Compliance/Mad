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

  it("keeps an empty left slot before the title and the initials on the right", () => {
    renderBar();
    const btn = screen.getByTestId("nav-profile");
    const bar = btn.parentElement as HTMLElement;
    expect(bar.children[0]).toHaveClass("w-8");
    expect(bar.children[0]).toBeEmptyDOMElement();
    expect(bar.lastElementChild).toBe(btn);
    expect(btn).toHaveClass("no-drag-region");
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
    fireEvent.click(btn);
    expect(props.onOpenAccount).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when signed out", () => {
    const { container } = renderBar({ runningInElectron: false, isAuthenticated: false });
    expect(container).toBeEmptyDOMElement();
  });
});

describe("getAccountInitials (one letter today)", () => {
  it.each([
    [{ display_name: "avery example", email: "x@y.z" }, "A"],
    [{ display_name: undefined, email: "mia@x.io" }, "M"],
    [{ display_name: "", email: "" }, "?"],
  ])("%o -> %s", (u, expected) => {
    expect(getAccountInitials(u)).toBe(expected);
  });
});
