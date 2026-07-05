/**
 * Tests for useAuditAddressForm hook
 *
 * BACKLOG-1824: Covers the address autocomplete state management paths —
 * specifically that stale suggestions are cleared on API error, ensuring the
 * child component's `suggestions.length > 0` guard cannot show ghost results.
 */

import { renderHook, act } from "@testing-library/react";
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
    jest.clearAllMocks();
    // Reset to a predictable default so each test can configure it.
    (window.api.address.getSuggestions as jest.Mock).mockReset();
  });

  it("sets suggestions and showAutocomplete=true on successful non-empty response", async () => {
    (window.api.address.getSuggestions as jest.Mock).mockResolvedValue({
      success: true,
      suggestions: mockSuggestions,
    });

    const { result } = renderHook(() => useAuditAddressForm(defaultProps));

    await act(async () => {
      await result.current.handleAddressChange("123 Main");
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
    });
    expect(result.current.addressSuggestions).toHaveLength(1);

    // Second call returns empty — no-API-key / zero-results path.
    (window.api.address.getSuggestions as jest.Mock).mockResolvedValueOnce({
      success: true,
      suggestions: [],
    });

    await act(async () => {
      await result.current.handleAddressChange("123 Main Stree");
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
    });
    expect(result.current.addressSuggestions).toHaveLength(1);

    // Next call throws — simulates missing API key or network error.
    (window.api.address.getSuggestions as jest.Mock).mockRejectedValueOnce(
      new Error("API key missing"),
    );

    await act(async () => {
      await result.current.handleAddressChange("123 Main St");
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
    });
    expect(result.current.addressSuggestions).toHaveLength(1);

    // User clears the field — input too short → API not invoked.
    await act(async () => {
      await result.current.handleAddressChange("12");
    });

    expect(result.current.showAddressAutocomplete).toBe(false);
    expect(result.current.addressSuggestions).toHaveLength(0);
  });
});
