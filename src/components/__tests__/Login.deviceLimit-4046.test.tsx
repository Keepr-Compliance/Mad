/**
 * BACKLOG-4046: Login handles the narrowed device-limit payload
 * { userId, deviceCount, deviceLimit }. AppRouter mounts Login without
 * onDeviceLimitReached, so the default message is the live path.
 */
import React from "react";
import { act, render, screen } from "@testing-library/react";
import Login from "../Login";

type Cleanup = () => void;
type Handler<T> = (data: T) => void;
type DeviceLimit = { userId: string; deviceCount: number; deviceLimit: number };

describe("Login — device limit at sign-in (BACKLOG-4046)", () => {
  let deviceLimitHandler: Handler<DeviceLimit> | null = null;
  const mockApi = {
    auth: { openAuthInBrowser: jest.fn().mockResolvedValue({ success: true }) },
    onDeepLinkAuthCallback: jest.fn((_h: Handler<unknown>): Cleanup => () => {}),
    onDeepLinkAuthError: jest.fn((_h: Handler<unknown>): Cleanup => () => {}),
    onDeepLinkLicenseBlocked: jest.fn((_h: Handler<unknown>): Cleanup => () => {}),
    onDeepLinkDeviceLimit: jest.fn((h: Handler<DeviceLimit>): Cleanup => {
      deviceLimitHandler = h;
      return () => {};
    }),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    deviceLimitHandler = null;
    (window as unknown as { api: typeof mockApi }).api = mockApi;
  });

  afterEach(() => {
    delete (window as unknown as { api?: typeof mockApi }).api;
  });

  it("without onDeviceLimitReached (as AppRouter mounts it), shows the counts from the payload", () => {
    render(<Login onLoginSuccess={jest.fn()} />);
    expect(deviceLimitHandler).not.toBeNull();
    act(() => deviceLimitHandler!({ userId: "user-1", deviceCount: 3, deviceLimit: 2 }));
    expect(screen.getByText(/Device limit reached \(3\/2\)/)).toBeInTheDocument();
  });

  it("passes exactly userId, deviceCount and deviceLimit to onDeviceLimitReached", () => {
    const onDeviceLimitReached = jest.fn();
    render(<Login onLoginSuccess={jest.fn()} onDeviceLimitReached={onDeviceLimitReached} />);
    act(() => deviceLimitHandler!({ userId: "user-1", deviceCount: 4, deviceLimit: 2 }));
    expect(onDeviceLimitReached).toHaveBeenCalledTimes(1);
    expect(onDeviceLimitReached.mock.calls[0][0]).toEqual({ userId: "user-1", deviceCount: 4, deviceLimit: 2 });
    expect(Object.keys(onDeviceLimitReached.mock.calls[0][0]).sort()).toEqual(["deviceCount", "deviceLimit", "userId"]);
  });
});
