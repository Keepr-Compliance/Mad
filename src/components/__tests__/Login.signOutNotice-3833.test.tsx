/**
 * BACKLOG-3833: after main signs the session out for inactivity, the sign-in
 * screen says why (not a dialog over client data).
 */
import React from "react";
import { act, render, screen } from "@testing-library/react";
import Login from "../Login";
import { setSignInNotice } from "../../services/sessionActivityService";
import { IDLE_SIGN_OUT_MESSAGE } from "../../hooks/useIdleSessionExpiry";

type Cleanup = () => void;
type Handler<T> = (data: T) => void;

describe("Login — sign-out notice (BACKLOG-3833)", () => {
  const mockApi = {
    auth: { openAuthInBrowser: jest.fn().mockResolvedValue({ success: true }) },
    onDeepLinkAuthCallback: jest.fn((_h: Handler<unknown>): Cleanup => () => {}),
    onDeepLinkAuthError: jest.fn((_h: Handler<unknown>): Cleanup => () => {}),
    onDeepLinkLicenseBlocked: jest.fn((_h: Handler<unknown>): Cleanup => () => {}),
    onDeepLinkDeviceLimit: jest.fn((_h: Handler<unknown>): Cleanup => () => {}),
  };

  beforeEach(() => {
    (window as unknown as { api: typeof mockApi }).api = mockApi;
    setSignInNotice(null);
  });
  afterEach(() => {
    setSignInNotice(null);
    delete (window as unknown as { api?: typeof mockApi }).api;
  });

  it("shows nothing without a notice", () => {
    render(<Login onLoginSuccess={jest.fn()} />);
    expect(screen.queryByTestId("sign-in-notice")).toBeNull();
  });

  it("shows the inactivity message set after the sign-out", () => {
    render(<Login onLoginSuccess={jest.fn()} />);
    act(() => setSignInNotice(IDLE_SIGN_OUT_MESSAGE));
    expect(screen.getByTestId("sign-in-notice")).toHaveTextContent(IDLE_SIGN_OUT_MESSAGE);
  });
});
