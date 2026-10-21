/**
 * BACKLOG-4038 — the license-blocked screen: founder-approved wording per
 * reason, the three actions, and no trial/limit copy anywhere.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { UpgradeScreen, upgradeReasonFor, type UpgradeReason } from "../UpgradeScreen";

const COPY: Record<UpgradeReason, { title: string; body: string }> = {
  suspended: {
    title: "Your account is paused",
    body: "This usually follows a payment dispute or a request from support. Sign in on the Keepr website to review your billing, or contact support.",
  },
  ended: {
    title: "Your Keepr license has ended",
    body: "Sign in on the Keepr website to see your plan and billing.",
  },
  unknown: {
    title: "Your Keepr license isn't active",
    body: "Sign in on the Keepr website to see your plan and billing.",
  },
};

const REASONS = Object.keys(COPY) as UpgradeReason[];

beforeEach(() => {
  jest.clearAllMocks();
});

describe("UpgradeScreen (BACKLOG-4038)", () => {
  it.each(REASONS)("%s renders its exact title and body", (reason) => {
    render(<UpgradeScreen reason={reason} onLogout={jest.fn()} />);
    expect(screen.getByRole("heading", { name: COPY[reason].title })).toBeInTheDocument();
    expect(screen.getByText(COPY[reason].body)).toBeInTheDocument();
  });

  it.each(REASONS)("%s shows no trial, 14-day or 5-transaction copy, and no feature list", (reason) => {
    const { container } = render(<UpgradeScreen reason={reason} onLogout={jest.fn()} />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/trial/i);
    expect(text).not.toMatch(/14-day/i);
    expect(text).not.toMatch(/5 transactions/i);
    expect(text).not.toMatch(/With a paid plan/i);
  });

  it.each(REASONS)("%s has exactly the three approved buttons", (reason) => {
    render(<UpgradeScreen reason={reason} onLogout={jest.fn()} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Manage billing on the website",
      "Contact support",
      "Sign out",
    ]);
  });

  it("Manage billing on the website calls billing:open-portal once, with no argument, and opens nothing else", async () => {
    render(<UpgradeScreen reason="ended" onLogout={jest.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Manage billing on the website" }));
    expect(window.api.billing.openPortal).toHaveBeenCalledTimes(1);
    expect(jest.mocked(window.api.billing.openPortal).mock.calls[0]).toEqual([]);
    expect(window.api.shell.openExternal).not.toHaveBeenCalled();
  });

  it("Contact support opens the support mailto through shell.openExternal", async () => {
    render(<UpgradeScreen reason="suspended" onLogout={jest.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Contact support" }));
    expect(window.api.shell.openExternal).toHaveBeenCalledTimes(1);
    expect(window.api.shell.openExternal).toHaveBeenCalledWith("mailto:support@keeprcompliance.com");
    expect(window.api.billing.openPortal).not.toHaveBeenCalled();
  });

  it("Sign out runs the provided logout handler", async () => {
    const onLogout = jest.fn().mockResolvedValue(undefined);
    render(<UpgradeScreen reason="unknown" onLogout={onLogout} />);
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });
});

describe("upgradeReasonFor (BACKLOG-4038)", () => {
  it.each([
    ["expired", "ended"],
    ["suspended", "suspended"],
    ["limit_reached", "unknown"],
    ["no_license", "unknown"],
    ["load_error", "unknown"],
    ["transaction_limit", "unknown"],
    ["", "unknown"],
    [null, "unknown"],
    [undefined, "unknown"],
  ] as const)("%p -> %p", (input, expected) => {
    expect(upgradeReasonFor(input)).toBe(expected);
  });
});
