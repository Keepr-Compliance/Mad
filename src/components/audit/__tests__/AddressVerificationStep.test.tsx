/**
 * Tests for AddressVerificationStep component
 *
 * Original suite: TASK-1974 — Manual Mode (Auto/Manual toggle removed)
 * BACKLOG-1824 suite: autocomplete dropdown dismiss behaviour regression
 */

import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import AddressVerificationStep from "../AddressVerificationStep";
import type { AddressData } from "../../../hooks/useAuditTransaction";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const defaultAddressData: AddressData = {
  property_address: "123 Main St",
  property_street: "123 Main St",
  property_city: "Anytown",
  property_state: "CA",
  property_zip: "90210",
  property_coordinates: null,
  transaction_type: "purchase",
  started_at: "2025-01-15",
  closing_deadline: undefined,
  closed_at: undefined,
};

const mockSuggestions = [
  {
    description: "123 Main Street, Anytown, CA 90210",
    place_id: "place1",
    main_text: "123 Main Street",
    secondary_text: "Anytown, CA 90210",
  },
  {
    description: "456 Oak Avenue, Somewhere, CA 91234",
    place_id: "place2",
    main_text: "456 Oak Avenue",
    secondary_text: "Somewhere, CA 91234",
  },
];

const baseProps = {
  addressData: defaultAddressData,
  onAddressChange: jest.fn(),
  onTransactionTypeChange: jest.fn(),
  onStartDateChange: jest.fn(),
  onClosingDateChange: jest.fn(),
  onEndDateChange: jest.fn(),
  onSelectSuggestion: jest.fn(),
};

// ---------------------------------------------------------------------------
// Original suite: Manual Mode
// ---------------------------------------------------------------------------

describe("AddressVerificationStep - Manual Mode (Auto/Manual toggle removed)", () => {
  const defaultProps = {
    ...baseProps,
    showAutocomplete: false,
    suggestions: [],
  };

  it("should render without Auto/Manual toggle", () => {
    render(<AddressVerificationStep {...defaultProps} />);

    expect(screen.queryByRole("button", { name: /auto/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /manual/i })).not.toBeInTheDocument();
  });

  it("should show date inputs in manual mode", () => {
    render(<AddressVerificationStep {...defaultProps} startDateMode="manual" />);

    expect(screen.getByText(/representation start date/i)).toBeInTheDocument();
  });

  it("should show Transaction Dates label", () => {
    render(<AddressVerificationStep {...defaultProps} startDateMode="manual" />);

    expect(screen.getByText("Transaction Dates")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// BACKLOG-1824: Autocomplete dropdown dismiss behaviour
// ---------------------------------------------------------------------------

describe("AddressVerificationStep - autocomplete dismiss (BACKLOG-1824)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // --- Visibility basics ---

  it("shows the dropdown when showAutocomplete=true and suggestions exist", () => {
    render(
      <AddressVerificationStep
        {...baseProps}
        showAutocomplete={true}
        suggestions={mockSuggestions}
      />,
    );
    expect(screen.getByText("123 Main Street")).toBeInTheDocument();
  });

  it("does not render the dropdown when suggestions array is empty", () => {
    render(
      <AddressVerificationStep
        {...baseProps}
        showAutocomplete={false}
        suggestions={[]}
      />,
    );
    expect(screen.queryByText("123 Main Street")).not.toBeInTheDocument();
  });

  it("does not render the dropdown when showAutocomplete=false even if suggestions exist", () => {
    render(
      <AddressVerificationStep
        {...baseProps}
        showAutocomplete={false}
        suggestions={mockSuggestions}
      />,
    );
    expect(screen.queryByText("123 Main Street")).not.toBeInTheDocument();
  });

  // --- Escape key ---

  it("dismisses the dropdown on Escape key", () => {
    render(
      <AddressVerificationStep
        {...baseProps}
        showAutocomplete={true}
        suggestions={mockSuggestions}
      />,
    );

    const input = screen.getByPlaceholderText("Enter property address...");
    expect(screen.getByText("123 Main Street")).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByText("123 Main Street")).not.toBeInTheDocument();
  });

  // --- Click outside ---

  it("dismisses the dropdown on mousedown outside the input wrapper", () => {
    render(
      <AddressVerificationStep
        {...baseProps}
        showAutocomplete={true}
        suggestions={mockSuggestions}
      />,
    );

    expect(screen.getByText("123 Main Street")).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByText("123 Main Street")).not.toBeInTheDocument();
  });

  // --- Blur ---

  it("dismisses the dropdown after input blur (after the 150 ms delay)", () => {
    render(
      <AddressVerificationStep
        {...baseProps}
        showAutocomplete={true}
        suggestions={mockSuggestions}
      />,
    );

    const input = screen.getByPlaceholderText("Enter property address...");
    expect(screen.getByText("123 Main Street")).toBeInTheDocument();

    fireEvent.blur(input);

    // Still visible within the delay window
    expect(screen.getByText("123 Main Street")).toBeInTheDocument();

    // Advance past the delay
    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(screen.queryByText("123 Main Street")).not.toBeInTheDocument();
  });

  // --- Free-text / manual address entry ---

  it("persists a free-text address value when no suggestion is selected", () => {
    const typedAddress = "789 Elm Street, Springfield, IL";
    render(
      <AddressVerificationStep
        {...baseProps}
        addressData={{ ...defaultAddressData, property_address: typedAddress }}
        showAutocomplete={false}
        suggestions={[]}
      />,
    );

    const input = screen.getByPlaceholderText("Enter property address...");
    expect(input).toHaveValue(typedAddress);
  });

  it("calls onAddressChange when the user types a free-text address", () => {
    render(
      <AddressVerificationStep
        {...baseProps}
        showAutocomplete={false}
        suggestions={[]}
      />,
    );

    const input = screen.getByPlaceholderText("Enter property address...");
    fireEvent.change(input, { target: { value: "999 Custom Rd" } });
    expect(baseProps.onAddressChange).toHaveBeenCalledWith("999 Custom Rd");
  });

  // --- Date fields remain reachable ---

  it("keeps date fields in the DOM and enabled while the dropdown is visible", () => {
    render(
      <AddressVerificationStep
        {...baseProps}
        showAutocomplete={true}
        suggestions={mockSuggestions}
      />,
    );

    // Dropdown is visible
    expect(screen.getByText("123 Main Street")).toBeInTheDocument();

    // Start date field is accessible and not disabled
    const startDateInput = screen.getByDisplayValue("2025-01-15");
    expect(startDateInput).toBeInTheDocument();
    expect(startDateInput).not.toBeDisabled();

    // Can still interact with the date field while the dropdown is open
    fireEvent.change(startDateInput, { target: { value: "2025-02-01" } });
    expect(baseProps.onStartDateChange).toHaveBeenCalledWith("2025-02-01");
  });

  it("clicking a date field outside the wrapper also dismisses the dropdown", () => {
    render(
      <AddressVerificationStep
        {...baseProps}
        showAutocomplete={true}
        suggestions={mockSuggestions}
      />,
    );

    expect(screen.getByText("123 Main Street")).toBeInTheDocument();

    const startDateInput = screen.getByDisplayValue("2025-01-15");
    fireEvent.mouseDown(startDateInput);

    expect(screen.queryByText("123 Main Street")).not.toBeInTheDocument();
  });

  // --- Re-shows after fresh suggestions ---

  it("re-shows the dropdown when new suggestions arrive after an Escape dismiss", () => {
    const { rerender } = render(
      <AddressVerificationStep
        {...baseProps}
        showAutocomplete={true}
        suggestions={mockSuggestions}
      />,
    );

    // Dismiss with Escape
    const input = screen.getByPlaceholderText("Enter property address...");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByText("123 Main Street")).not.toBeInTheDocument();

    // Parent delivers fresh results (user typed more characters)
    const newSuggestions = [
      {
        description: "789 Elm Street, Springfield, IL 62701",
        place_id: "place3",
        main_text: "789 Elm Street",
        secondary_text: "Springfield, IL 62701",
      },
    ];
    rerender(
      <AddressVerificationStep
        {...baseProps}
        showAutocomplete={true}
        suggestions={newSuggestions}
      />,
    );

    expect(screen.getByText("789 Elm Street")).toBeInTheDocument();
  });

  // --- Suggestion selection ---

  it("calls onSelectSuggestion and closes the dropdown when a suggestion is clicked", () => {
    render(
      <AddressVerificationStep
        {...baseProps}
        showAutocomplete={true}
        suggestions={mockSuggestions}
      />,
    );

    const suggestionButton = screen.getByText("123 Main Street");

    // Simulate mousedown (cancels blur timer) then click
    fireEvent.mouseDown(suggestionButton);
    fireEvent.click(suggestionButton);

    expect(baseProps.onSelectSuggestion).toHaveBeenCalledWith(mockSuggestions[0]);
    expect(screen.queryByText("123 Main Street")).not.toBeInTheDocument();
  });
});
