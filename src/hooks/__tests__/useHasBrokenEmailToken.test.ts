/**
 * useHasBrokenEmailToken Tests (BACKLOG-2127, CHANGE 3)
 *
 * The setup-prompt gate keys off this hook: a broken token (row exists, dead)
 * must SUPPRESS the "complete your setup" onboarding prompt (the user needs a
 * reconnect banner instead), while a pure NOT_CONNECTED provider must NOT
 * suppress it. Distinction is made via the typed ConnectionErrorType — never by
 * parsing a message.
 */

import { renderHook, waitFor } from "@testing-library/react";
import { useHasBrokenEmailToken } from "../useHasBrokenEmailToken";

const mockCheckAllConnections = jest.fn();

beforeAll(() => {
  (window as unknown as { api: unknown }).api = {
    system: { checkAllConnections: (...a: unknown[]) => mockCheckAllConnections(...a) },
  };
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe("useHasBrokenEmailToken", () => {
  it("returns TRUE when a provider has a broken token (TOKEN_REFRESH_FAILED)", async () => {
    mockCheckAllConnections.mockResolvedValue({
      success: true,
      google: { connected: true, error: null },
      microsoft: { connected: false, error: { type: "TOKEN_REFRESH_FAILED", userMessage: "x" } },
    });

    const { result } = renderHook(() => useHasBrokenEmailToken("user-1"));
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("returns FALSE for a pure NOT_CONNECTED provider (setup prompt should still show)", async () => {
    mockCheckAllConnections.mockResolvedValue({
      success: true,
      google: undefined,
      microsoft: { connected: false, error: { type: "NOT_CONNECTED", userMessage: "x" } },
    });

    const { result } = renderHook(() => useHasBrokenEmailToken("user-1"));
    // Give the async check a chance to resolve, then assert it stayed false.
    await waitFor(() => expect(mockCheckAllConnections).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it("returns FALSE when both providers are connected", async () => {
    mockCheckAllConnections.mockResolvedValue({
      success: true,
      google: { connected: true, error: null },
      microsoft: { connected: true, error: null },
    });

    const { result } = renderHook(() => useHasBrokenEmailToken("user-1"));
    await waitFor(() => expect(mockCheckAllConnections).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it("returns FALSE (does not suppress) when the check throws", async () => {
    mockCheckAllConnections.mockRejectedValue(new Error("network"));

    const { result } = renderHook(() => useHasBrokenEmailToken("user-1"));
    await waitFor(() => expect(mockCheckAllConnections).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it("does not call the API when userId is missing", () => {
    const { result } = renderHook(() => useHasBrokenEmailToken(null));
    expect(mockCheckAllConnections).not.toHaveBeenCalled();
    expect(result.current).toBe(false);
  });
});
