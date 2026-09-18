/**
 * Login — sign-in button appearance (BACKLOG-3415).
 *
 * Pins the pre-release polish on the primary sign-in button:
 *   - the button carries no icon (the globe svg was removed)
 *   - the "Sign in" label renders at text-lg
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import Login from "../Login";

type Cleanup = () => void;
type Handler<T> = (data: T) => void;

describe("Login — sign-in button appearance (BACKLOG-3415)", () => {
  const mockApi = {
    auth: { openAuthInBrowser: jest.fn().mockResolvedValue({ success: true }) },
    onDeepLinkAuthCallback: jest.fn((_h: Handler<unknown>): Cleanup => () => {}),
    onDeepLinkAuthError: jest.fn((_h: Handler<unknown>): Cleanup => () => {}),
    onDeepLinkLicenseBlocked: jest.fn((_h: Handler<unknown>): Cleanup => () => {}),
    onDeepLinkDeviceLimit: jest.fn((_h: Handler<unknown>): Cleanup => () => {}),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (window as unknown as { api: typeof mockApi }).api = mockApi;
  });

  afterEach(() => {
    delete (window as unknown as { api?: typeof mockApi }).api;
  });

  it("renders the sign-in button with no icon and a text-lg label", () => {
    render(<Login onLoginSuccess={jest.fn()} />);

    const label = screen.getByText("Sign in");
    const button = label.closest("button");
    expect(button).not.toBeNull();
    expect(button?.querySelector("svg")).toBeNull();
    expect(label).toHaveClass("text-lg", "font-medium");
  });
});
