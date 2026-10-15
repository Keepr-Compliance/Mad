/**
 * Login — deep link auth error copy (BACKLOG-2173b)
 *
 * BACKLOG-2173b root cause: on a fresh macOS profile, a deep-link login can
 * dead-end when the FDA-grant relaunch outruns session persistence. Part of
 * the fix is honest error copy: LOGIN_RETRY_CONFIG.maxRetries is 0, so a
 * single callback timeout was reaching the "max retries reached" branch
 * and showing "Login failed after multiple attempts" -- misleading, since
 * exactly ONE attempt was made (retryAttempt is always 0 with maxRetries: 0).
 *
 * This pins:
 *   - A retryable timeout (code: UNKNOWN_ERROR) with maxRetries: 0 shows the
 *     honest single-attempt copy, NOT "multiple attempts".
 *   - A non-retryable error (e.g. MISSING_TOKENS) still shows the underlying
 *     error message verbatim (unchanged behavior).
 */

import React from "react";
import { render, screen, act } from "@testing-library/react";
import Login from "../Login";

type Cleanup = () => void;
type Handler<T> = (data: T) => void;

describe("Login — deep link auth error copy (BACKLOG-2173b)", () => {
  let deepLinkErrorHandler: Handler<{ error: string; code: string }> | null;

  const mockApi = {
    auth: {
      openAuthInBrowser: jest.fn().mockResolvedValue({ success: true }),
    },
    onDeepLinkAuthCallback: jest.fn((_handler: Handler<unknown>): Cleanup => () => {}),
    onDeepLinkAuthError: jest.fn((handler: Handler<{ error: string; code: string }>): Cleanup => {
      deepLinkErrorHandler = handler;
      return () => {
        deepLinkErrorHandler = null;
      };
    }),
    onDeepLinkLicenseBlocked: jest.fn((_handler: Handler<unknown>): Cleanup => () => {}),
    onDeepLinkDeviceLimit: jest.fn((_handler: Handler<unknown>): Cleanup => () => {}),
  };

  beforeEach(() => {
    deepLinkErrorHandler = null;
    jest.clearAllMocks();
    (window as unknown as { api: typeof mockApi }).api = mockApi;
  });

  afterEach(() => {
    delete (window as unknown as { api?: typeof mockApi }).api;
  });

  it("a retryable timeout (maxRetries: 0, exactly one attempt) shows honest single-attempt copy, not 'multiple attempts'", () => {
    render(<Login onLoginSuccess={jest.fn()} />);

    expect(deepLinkErrorHandler).not.toBeNull();
    act(() => {
      deepLinkErrorHandler?.({ error: "Authentication timed out", code: "UNKNOWN_ERROR" });
    });

    const errorText = screen.getByText(/sign-in is taking longer than expected/i);
    expect(errorText).toBeInTheDocument();
    expect(screen.queryByText(/multiple attempts/i)).not.toBeInTheDocument();
  });

  it("a non-retryable error (e.g. MISSING_TOKENS) still shows the underlying message verbatim", () => {
    render(<Login onLoginSuccess={jest.fn()} />);

    expect(deepLinkErrorHandler).not.toBeNull();
    act(() => {
      deepLinkErrorHandler?.({ error: "Missing tokens in callback URL", code: "MISSING_TOKENS" });
    });

    expect(screen.getByText("Missing tokens in callback URL")).toBeInTheDocument();
    expect(screen.queryByText(/multiple attempts/i)).not.toBeInTheDocument();
  });

  // BACKLOG-3768 L1: main's copy is shown verbatim AND the Try Again button.
  it.each([
    "Can't connect securely. Check your antivirus or network, then try again.",
    "Can't connect to Keepr. Check your network, then try again.",
  ])("CONNECTION_FAILED shows main's message and a Try Again button: %s", (copy) => {
    render(<Login onLoginSuccess={jest.fn()} />);

    expect(deepLinkErrorHandler).not.toBeNull();
    act(() => {
      deepLinkErrorHandler?.({ error: copy, code: "CONNECTION_FAILED" });
    });

    expect(screen.getByText(copy)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(screen.queryByText(/taking longer than expected/i)).not.toBeInTheDocument();
  });

  it("BACKLOG-3768: INVALID_TOKENS still shows no Try Again button", () => {
    render(<Login onLoginSuccess={jest.fn()} />);
    act(() => {
      deepLinkErrorHandler?.({ error: "Invalid authentication tokens", code: "INVALID_TOKENS" });
    });
    expect(screen.getByText("Invalid authentication tokens")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
  });
});
