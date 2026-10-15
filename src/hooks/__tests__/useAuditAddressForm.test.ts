/**
 * Tests for useAuditAddressForm hook
 *
 * BACKLOG-1824: Covers the address autocomplete state management paths —
 * specifically that stale suggestions are cleared on API error, ensuring the
 * child component's `suggestions.length > 0` guard cannot show ghost results.
 */

import { renderHook, act } from "@testing-library/react";
import { ADDRESS_SUGGEST_DEBOUNCE_MS } from "../audit/useAuditAddressForm";
import { useAuditAddressForm } from "../audit/useAuditAddressForm";

const mockSuggestions = [
  {
    description: "123 Main Street, Anytown, CA 90210",
    place_id: "place1",
    main_text: "123 Main Street",
    secondary_text: "Anytown, CA 90210",
  },
];

const defaultProps = {
  userId: "user-123",
  isEditing: false,
  editTransaction: undefined,
};

describe("useAuditAddressForm — autocomplete state (BACKLOG-1824)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    // Reset to a predictable default so each test can configure it.
    (window.api.address.getSuggestions as jest.Mock).mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("sets suggestions and showAutocomplete=true on successful non-empty response", async () => {
    (window.api.address.getSuggestions as jest.Mock).mockResolvedValue({
      success: true,
      suggestions: mockSuggestions,
    });

    const { result } = renderHook(() => useAuditAddressForm(defaultProps));

    await act(async () => {
      await result.current.handleAddressChange("123 Main");
      await jest.advanceTimersByTimeAsync(ADDRESS_SUGGEST_DEBOUNCE_MS);
    });

    expect(result.current.showAddressAutocomplete).toBe(true);
    expect(result.current.addressSuggestions).toEqual(mockSuggestions);
  });

  it("clears suggestions and sets showAutocomplete=false on empty result", async () => {
    // First call returns suggestions so state is populated.
    (window.api.address.getSuggestions as jest.Mock).mockResolvedValueOnce({
      success: true,
      suggestions: mockSuggestions,
    });

    const { result } = renderHook(() => useAuditAddressForm(defaultProps));

    await act(async () => {
      await result.current.handleAddressChange("123 Main");
      await jest.advanceTimersByTimeAsync(ADDRESS_SUGGEST_DEBOUNCE_MS);
    });
    expect(result.current.addressSuggestions).toHaveLength(1);

    // Second call returns empty — no-API-key / zero-results path.
    (window.api.address.getSuggestions as jest.Mock).mockResolvedValueOnce({
      success: true,
      suggestions: [],
    });

    await act(async () => {
      await result.current.handleAddressChange("123 Main Stree");
      await jest.advanceTimersByTimeAsync(ADDRESS_SUGGEST_DEBOUNCE_MS);
    });

    expect(result.current.showAddressAutocomplete).toBe(false);
    expect(result.current.addressSuggestions).toHaveLength(0);
  });

  it("clears suggestions AND sets showAutocomplete=false on API error (BACKLOG-1824 root cause)", async () => {
    // Populate stale suggestions first.
    (window.api.address.getSuggestions as jest.Mock).mockResolvedValueOnce({
      success: true,
      suggestions: mockSuggestions,
    });

    const { result } = renderHook(() => useAuditAddressForm(defaultProps));

    await act(async () => {
      await result.current.handleAddressChange("123 Main");
      await jest.advanceTimersByTimeAsync(ADDRESS_SUGGEST_DEBOUNCE_MS);
    });
    expect(result.current.addressSuggestions).toHaveLength(1);

    // Next call throws — simulates missing API key or network error.
    (window.api.address.getSuggestions as jest.Mock).mockRejectedValueOnce(
      new Error("API key missing"),
    );

    await act(async () => {
      await result.current.handleAddressChange("123 Main St");
      await jest.advanceTimersByTimeAsync(ADDRESS_SUGGEST_DEBOUNCE_MS);
    });

    // Both must be reset so no stale dropdown can appear.
    expect(result.current.showAddressAutocomplete).toBe(false);
    expect(result.current.addressSuggestions).toHaveLength(0);
  });

  it("clears suggestions when input is too short (API not called)", async () => {
    // Populate state first.
    (window.api.address.getSuggestions as jest.Mock).mockResolvedValueOnce({
      success: true,
      suggestions: mockSuggestions,
    });

    const { result } = renderHook(() => useAuditAddressForm(defaultProps));

    await act(async () => {
      await result.current.handleAddressChange("123 Main");
      await jest.advanceTimersByTimeAsync(ADDRESS_SUGGEST_DEBOUNCE_MS);
    });
    expect(result.current.addressSuggestions).toHaveLength(1);

    // User clears the field — input too short → API not invoked.
    await act(async () => {
      await result.current.handleAddressChange("12");
      await jest.advanceTimersByTimeAsync(ADDRESS_SUGGEST_DEBOUNCE_MS);
    });

    expect(result.current.showAddressAutocomplete).toBe(false);
    expect(result.current.addressSuggestions).toHaveLength(0);
  });
});

describe("useAuditAddressForm — request throttling (BACKLOG-3834)", () => {
  const getSuggestions = () => window.api.address.getSuggestions as jest.Mock;
  const type = async (
    result: { current: ReturnType<typeof useAuditAddressForm> },
    value: string,
  ) => {
    await act(async () => {
      await result.current.handleAddressChange(value);
    });
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    getSuggestions().mockReset();
    getSuggestions().mockResolvedValue({ success: true, suggestions: mockSuggestions });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("rapid typing issues one request, after the pause, for the latest value", async () => {
    const { result } = renderHook(() => useAuditAddressForm(defaultProps));
    for (const v of ["123", "123 M", "123 Ma", "123 Mai", "123 Main"]) {
      await type(result, v);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(ADDRESS_SUGGEST_DEBOUNCE_MS - 50);
      });
    }
    expect(getSuggestions()).not.toHaveBeenCalled();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ADDRESS_SUGGEST_DEBOUNCE_MS);
    });
    expect(getSuggestions()).toHaveBeenCalledTimes(1);
    expect(getSuggestions().mock.calls[0][0]).toBe("123 Main");
  });

  it("makes no request below 3 characters", async () => {
    const { result } = renderHook(() => useAuditAddressForm(defaultProps));
    await type(result, "12");
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ADDRESS_SUGGEST_DEBOUNCE_MS * 3);
    });
    expect(getSuggestions()).not.toHaveBeenCalled();
    await type(result, "123");
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ADDRESS_SUGGEST_DEBOUNCE_MS);
    });
    expect(getSuggestions()).toHaveBeenCalledTimes(1);
  });

  it("applies only the latest reply when replies arrive out of order", async () => {
    const older = [{ ...mockSuggestions[0], place_id: "older" }];
    const newer = [{ ...mockSuggestions[0], place_id: "newer" }];
    let resolveOld!: (v: unknown) => void;
    let resolveNew!: (v: unknown) => void;
    getSuggestions()
      .mockImplementationOnce(() => new Promise(r => { resolveOld = r; }))
      .mockImplementationOnce(() => new Promise(r => { resolveNew = r; }));

    const { result } = renderHook(() => useAuditAddressForm(defaultProps));
    await type(result, "123 Mai");
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ADDRESS_SUGGEST_DEBOUNCE_MS);
    });
    await type(result, "123 Main");
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ADDRESS_SUGGEST_DEBOUNCE_MS);
    });
    expect(getSuggestions()).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveNew({ success: true, suggestions: newer });
    });
    await act(async () => {
      resolveOld({ success: true, suggestions: older });
    });

    expect(result.current.addressSuggestions).toEqual(newer);
  });

  it("clears the pending timer on unmount", async () => {
    const { result, unmount } = renderHook(() => useAuditAddressForm(defaultProps));
    await type(result, "123 Main");
    unmount();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ADDRESS_SUGGEST_DEBOUNCE_MS * 2);
    });
    expect(getSuggestions()).not.toHaveBeenCalled();
  });
});
