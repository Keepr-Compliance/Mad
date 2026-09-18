/**
 * Login — "Stuck? Retry" in the browser sign-in waiting panel (BACKLOG-3415).
 *
 * The waiting panel used to offer Cancel and nothing else for the full 5:10
 * give-up window. A user whose browser hand-off silently failed had no way to
 * start over except giving up and waiting for the failure message. After 60s of
 * waiting a second button now joins Cancel: "Stuck? Retry" cancels the current
 * attempt and starts a fresh sign-in in one click.
 *
 * Pins:
 *   - hidden at 59s, shown at 60s (and the threshold is NOT callbackTimeoutMs)
 *   - clicking it reopens the browser and keeps the wait alive
 *   - after Retry it hides again until another 60s passes
 *   - Retry clears the first attempt's 5:10 timer and starts a fresh one
 *   - the 5:10 give-up itself is unchanged
 *   - Cancel leaves no timer behind
 */
import React from "react";
import { render, screen, act, waitFor } from "@testing-library/react";
import Login from "../Login";

type Cleanup = () => void;
type Handler<T> = (data: T) => void;

describe("Login — Stuck? Retry", () => {
  const mockApi = {
    auth: { openAuthInBrowser: jest.fn() },
    onDeepLinkAuthCallback: jest.fn((_h: Handler<unknown>): Cleanup => () => {}),
    onDeepLinkAuthError: jest.fn((_h: Handler<unknown>): Cleanup => () => {}),
    onDeepLinkLicenseBlocked: jest.fn((_h: Handler<unknown>): Cleanup => () => {}),
    onDeepLinkDeviceLimit: jest.fn((_h: Handler<unknown>): Cleanup => () => {}),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockApi.auth.openAuthInBrowser.mockResolvedValue({ success: true });
    jest.useFakeTimers();
    (window as unknown as { api: typeof mockApi }).api = mockApi;
  });

  afterEach(() => {
    jest.useRealTimers();
    delete (window as unknown as { api?: typeof mockApi }).api;
  });

  const stuck = () => screen.queryByText("Stuck? Retry");
  const cancel = () => screen.queryByText("Cancel");
  const err = () => screen.queryByText(/taking longer than expected/i);
  const waiting = () => screen.queryByText(/Authenticating in Browser/i);

  /** Render, record the pending-timer baseline, then start a browser sign-in. */
  const startLogin = async () => {
    render(<Login onLoginSuccess={jest.fn()} />);
    const baseline = jest.getTimerCount();
    await act(async () => {
      screen.getByText("Sign in").click();
      await Promise.resolve();
    });
    return baseline;
  };

  const clickStuck = async () => {
    const button = stuck();
    expect(button).not.toBeNull();
    await act(async () => {
      button!.click();
      await Promise.resolve();
    });
  };

  it("is hidden at 59s and appears at 60s, with Cancel alone before that", async () => {
    await startLogin();
    expect(waiting()).not.toBeNull();
    expect(cancel()).not.toBeNull();
    expect(stuck()).toBeNull();

    act(() => { jest.advanceTimersByTime(59_000); });
    expect(stuck()).toBeNull();
    expect(cancel()).not.toBeNull();

    act(() => { jest.advanceTimersByTime(1_000); });
    expect(stuck()).not.toBeNull();
    expect(cancel()).not.toBeNull();
    // It is an offer, not a failure: nothing about the give-up message yet.
    expect(err()).toBeNull();
  });

  it("reopens the browser and keeps the wait alive when clicked", async () => {
    await startLogin();
    expect(mockApi.auth.openAuthInBrowser).toHaveBeenCalledTimes(1);

    act(() => { jest.advanceTimersByTime(60_000); });
    await clickStuck();

    expect(mockApi.auth.openAuthInBrowser).toHaveBeenCalledTimes(2);
    expect(waiting()).not.toBeNull();
    // Guard, not proof. No reachable state shows the error box while the
    // waiting panel is up — every setError(non-null) also clears
    // browserAuthInProgress — so this cannot fail against today's code. It is
    // here to catch the most likely wrong implementation: one that routes Retry
    // through the give-up handler and surfaces "taking longer than expected".
    expect(err()).toBeNull();
  });

  it("hides again after Retry until another 60s of waiting", async () => {
    await startLogin();
    act(() => { jest.advanceTimersByTime(60_000); });
    await clickStuck();

    expect(stuck()).toBeNull();
    act(() => { jest.advanceTimersByTime(59_000); });
    expect(stuck()).toBeNull();
    act(() => { jest.advanceTimersByTime(1_000); });
    expect(stuck()).not.toBeNull();
  });

  it("clears the first attempt's give-up timer and starts a fresh one", async () => {
    await startLogin();
    act(() => { jest.advanceTimersByTime(60_000); });
    await clickStuck();

    // t = 5:10 exactly, measured from the FIRST attempt. A Retry that left the
    // old timer running would fire the give-up message here.
    act(() => { jest.advanceTimersByTime(4 * 60_000 + 10_000 + 1); });
    expect(err()).toBeNull();
    expect(waiting()).not.toBeNull();

    // 5:10 measured from the Retry click does fire.
    act(() => { jest.advanceTimersByTime(60_000); });
    await waitFor(() => expect(err()).not.toBeNull());
  });

  it("leaves the 5:10 give-up unchanged when nothing arrives", async () => {
    await startLogin();
    act(() => { jest.advanceTimersByTime(60_000); });
    expect(stuck()).not.toBeNull();
    expect(err()).toBeNull();

    act(() => { jest.advanceTimersByTime(4 * 60_000 + 10_000 + 1); });
    await waitFor(() => expect(err()).not.toBeNull());
    // The waiting panel — and both its buttons — are gone with it.
    expect(stuck()).toBeNull();
    expect(waiting()).toBeNull();
  });

  it("Cancel before the threshold leaves no timer running", async () => {
    const baseline = await startLogin();

    act(() => { jest.advanceTimersByTime(30_000); });
    // Precondition: both the reveal timer and the give-up timer are pending, so
    // a missing cleanup has something to leak.
    expect(stuck()).toBeNull();
    expect(jest.getTimerCount()).toBeGreaterThan(baseline);

    await act(async () => {
      cancel()!.click();
      await Promise.resolve();
    });
    expect(jest.getTimerCount()).toBe(baseline);

    act(() => { jest.advanceTimersByTime(10 * 60_000); });
    expect(stuck()).toBeNull();
    expect(err()).toBeNull();
    expect(waiting()).toBeNull();
  });
});
