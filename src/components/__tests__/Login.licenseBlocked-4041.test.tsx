/**
 * BACKLOG-4041: Login handles the narrowed license-blocked payload
 * { userId, blockReason } and hands exactly those two fields to
 * onLicenseBlocked (AppRouter shows the blocked screen from them).
 */
import React from "react";
import { act, render, screen } from "@testing-library/react";
import Login from "../Login";

type Cleanup = () => void;
type Handler<T> = (data: T) => void;
type Blocked = { userId: string; blockReason: string };

describe("Login — license blocked at sign-in (BACKLOG-4041)", () => {
  let blockedHandler: Handler<Blocked> | null = null;
  const mockApi = {
    auth: { openAuthInBrowser: jest.fn().mockResolvedValue({ success: true }) },
    onDeepLinkAuthCallback: jest.fn((_h: Handler<unknown>): Cleanup => () => {}),
    onDeepLinkAuthError: jest.fn((_h: Handler<unknown>): Cleanup => () => {}),
    onDeepLinkLicenseBlocked: jest.fn((h: Handler<Blocked>): Cleanup => {
      blockedHandler = h;
      return () => {};
    }),
    onDeepLinkDeviceLimit: jest.fn((_h: Handler<unknown>): Cleanup => () => {}),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    blockedHandler = null;
    (window as unknown as { api: typeof mockApi }).api = mockApi;
  });

  afterEach(() => {
    delete (window as unknown as { api?: typeof mockApi }).api;
  });

  it("passes exactly userId and blockReason to onLicenseBlocked", () => {
    const onLicenseBlocked = jest.fn();
    render(<Login onLoginSuccess={jest.fn()} onLicenseBlocked={onLicenseBlocked} />);
    expect(blockedHandler).not.toBeNull();

    act(() => blockedHandler!({ userId: "user-1", blockReason: "expired" }));

    expect(onLicenseBlocked).toHaveBeenCalledTimes(1);
    expect(onLicenseBlocked.mock.calls[0][0]).toEqual({ userId: "user-1", blockReason: "expired" });
    expect(Object.keys(onLicenseBlocked.mock.calls[0][0]).sort()).toEqual(["blockReason", "userId"]);
  });

  it("without onLicenseBlocked, shows the default message from blockReason", () => {
    render(<Login onLoginSuccess={jest.fn()} />);
    act(() => blockedHandler!({ userId: "user-1", blockReason: "suspended" }));
    expect(screen.getByText(/Your license is suspended/)).toBeInTheDocument();
  });
});
