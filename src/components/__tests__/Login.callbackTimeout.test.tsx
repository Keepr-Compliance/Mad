/**
 * Login — browser sign-in callback timeout.
 *
 * Pins the fix for the false "Sign-in is taking longer than expected" failure:
 * the client callback timer used to give up after 60s, while a human picking an
 * account and reading a consent screen routinely takes longer. There is no
 * server-side deadline on this flow (auth:open-in-browser only calls
 * shell.openExternal; the main process handles keepr://callback reactively), so
 * this timer is the only thing besides Cancel that can end the wait.
 *
 * Pins:
 *   - no failure is shown at 60s, 2min or 5min
 *   - a failure IS still shown past 5:10
 *   - a late success clears an error that was already on screen
 */
import React from "react";
import { render, screen, act, waitFor } from "@testing-library/react";
import Login from "../Login";

type Cleanup = () => void;
type Handler<T> = (data: T) => void;

describe("Login — browser sign-in callback timeout", () => {
  let successHandler: Handler<unknown> | null = null;

  const mockApi = {
    auth: { openAuthInBrowser: jest.fn().mockResolvedValue({ success: true }) },
    onDeepLinkAuthCallback: jest.fn((h: Handler<unknown>): Cleanup => {
      successHandler = h;
      return () => {};
    }),
    onDeepLinkAuthError: jest.fn((_h: Handler<unknown>): Cleanup => () => {}),
    onDeepLinkLicenseBlocked: jest.fn((_h: Handler<unknown>): Cleanup => () => {}),
    onDeepLinkDeviceLimit: jest.fn((_h: Handler<unknown>): Cleanup => () => {}),
  };

  beforeEach(() => {
    successHandler = null;
    jest.clearAllMocks();
    jest.useFakeTimers();
    (window as unknown as { api: typeof mockApi }).api = mockApi;
  });

  afterEach(() => {
    jest.useRealTimers();
    delete (window as unknown as { api?: typeof mockApi }).api;
  });

  const startLogin = async () => {
    render(<Login onLoginSuccess={jest.fn()} />);
    const btn = screen.getByText("Sign in");
    await act(async () => {
      btn.click();
      await Promise.resolve();
    });
  };

  const err = () => screen.queryByText(/taking longer than expected/i);

  it("no false failure at 60s, 2min, or 5min", async () => {
    await startLogin();
    expect(mockApi.auth.openAuthInBrowser).toHaveBeenCalled();

    act(() => { jest.advanceTimersByTime(60_000); });
    expect(err()).toBeNull();

    act(() => { jest.advanceTimersByTime(60_000); });
    expect(err()).toBeNull();

    act(() => { jest.advanceTimersByTime(3 * 60_000); });
    expect(err()).toBeNull();
  });

  it("still fails past the backend's 5min window (5:10)", async () => {
    await startLogin();
    act(() => { jest.advanceTimersByTime(5 * 60_000 + 10_000 + 1); });
    await waitFor(() => expect(err()).not.toBeNull());
  });

  it("a late success clears a previously shown error (Fix 2)", async () => {
    await startLogin();
    act(() => { jest.advanceTimersByTime(5 * 60_000 + 10_000 + 1); });
    await waitFor(() => expect(err()).not.toBeNull());

    expect(successHandler).not.toBeNull();
    act(() => {
      successHandler?.({ accessToken: "a", refreshToken: "r", userId: "u" });
    });
    expect(err()).toBeNull();
  });
});
