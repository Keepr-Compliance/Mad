/**
 * BACKLOG-3674 — the tour-state handlers read and write ONE record,
 * `users.tour_dismissed_at`, for the SESSION user only (T6), and a failed write
 * is never reported as success (T8).
 */

const registered: Record<string, (...args: unknown[]) => unknown> = {};
jest.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      registered[channel] = fn;
    },
  },
}));

const mockGetAuthUserId = jest.fn();
const mockGetTourDismissedAt = jest.fn();
const mockDismissTour = jest.fn();
jest.mock("../../services/supabaseService", () => ({
  __esModule: true,
  default: {
    getAuthUserId: () => mockGetAuthUserId(),
    getTourDismissedAt: (...a: unknown[]) => mockGetTourDismissedAt(...a),
    dismissTour: (...a: unknown[]) => mockDismissTour(...a),
  },
}));

jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockCaptureException = jest.fn();
jest.mock("@sentry/electron/main", () => ({
  captureException: (...a: unknown[]) => mockCaptureException(...a),
}));

import { TOUR_STATE_READ_TIMEOUT_MS, registerTourStateHandlers } from "../tourStateHandlers";

const SESSION_USER = "session-user-id";
const OTHER_USER = "renderer-supplied-id";
const TS = "2026-10-07T12:00:00.000Z";

registerTourStateHandlers();
const getTourState = (...args: unknown[]) =>
  registered["user:get-tour-state"]({} as never, ...args) as Promise<{ success: boolean; tour: string }>;
const dismissTour = (...args: unknown[]) =>
  registered["user:dismiss-tour"]({} as never, ...args) as Promise<{ success: boolean; error?: string }>;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAuthUserId.mockReturnValue(SESSION_USER);
});

describe("tour-state handlers (BACKLOG-3674)", () => {
  it("registers exactly the two channels", () => {
    expect(Object.keys(registered).sort()).toEqual(["user:dismiss-tour", "user:get-tour-state"]);
  });

  it("T6: the read uses the session user and ignores a renderer-supplied id", async () => {
    mockGetTourDismissedAt.mockResolvedValue({ found: true, tourDismissedAt: TS });
    await expect(getTourState(OTHER_USER)).resolves.toEqual({ success: true, tour: "dismissed" });
    expect(mockGetTourDismissedAt).toHaveBeenCalledTimes(1);
    expect(mockGetTourDismissedAt).toHaveBeenCalledWith(SESSION_USER);
  });

  it("read: empty value -> not-dismissed; no row -> not-dismissed", async () => {
    mockGetTourDismissedAt.mockResolvedValueOnce({ found: true, tourDismissedAt: null });
    await expect(getTourState()).resolves.toEqual({ success: true, tour: "not-dismissed" });
    mockGetTourDismissedAt.mockResolvedValueOnce({ found: false, tourDismissedAt: null });
    await expect(getTourState()).resolves.toEqual({ success: true, tour: "not-dismissed" });
  });

  it("T6: no session user -> unknown, and no query", async () => {
    mockGetAuthUserId.mockReturnValue(null);
    await expect(getTourState(OTHER_USER)).resolves.toMatchObject({ success: false, tour: "unknown" });
    expect(mockGetTourDismissedAt).not.toHaveBeenCalled();
  });

  it("T7: a failing read (e.g. missing column) -> unknown, never not-dismissed", async () => {
    mockGetTourDismissedAt.mockRejectedValue({ message: "column users.tour_dismissed_at does not exist" });
    await expect(getTourState()).resolves.toMatchObject({ success: false, tour: "unknown" });
  });

  it("T7: a hung read -> unknown after the timeout", async () => {
    jest.useFakeTimers();
    try {
      mockGetTourDismissedAt.mockReturnValue(new Promise(() => {}));
      const p = getTourState();
      await jest.advanceTimersByTimeAsync(TOUR_STATE_READ_TIMEOUT_MS + 1);
      await expect(p).resolves.toMatchObject({ success: false, tour: "unknown" });
    } finally {
      jest.useRealTimers();
    }
  });

  it("T6: the write uses the session user and ignores a renderer-supplied id", async () => {
    mockDismissTour.mockResolvedValue(undefined);
    await expect(dismissTour(OTHER_USER)).resolves.toEqual({ success: true });
    expect(mockDismissTour).toHaveBeenCalledTimes(1);
    expect(mockDismissTour).toHaveBeenCalledWith(SESSION_USER);
  });

  it("T6: no session user -> success:false, no write", async () => {
    mockGetAuthUserId.mockReturnValue(null);
    await expect(dismissTour(OTHER_USER)).resolves.toMatchObject({ success: false });
    expect(mockDismissTour).not.toHaveBeenCalled();
  });

  it("T8: a failed write -> success:false and reported to Sentry", async () => {
    mockDismissTour.mockRejectedValue(new Error("permission denied for table users"));
    await expect(dismissTour()).resolves.toEqual({
      success: false,
      error: "permission denied for table users",
    });
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });
});
