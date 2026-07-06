/**
 * Tests for LinkedContentSearch (BACKLOG-1866)
 *
 * Covers:
 *   - Debounce: rapid typing fires the IPC search exactly once with the final query.
 *   - Grouped rendering with per-type counts.
 *   - Clean empty state when there are no matches.
 *   - Clicking a result invokes the correct navigation callback.
 */
import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { LinkedContentSearch } from "./LinkedContentSearch";
import type { LinkedContentSearchResults } from "@electron/types/ipc/window-api-transactions";

const emptyResults: LinkedContentSearchResults = {
  contacts: { items: [], total: 0 },
  emails: { items: [], total: 0 },
  texts: { items: [], total: 0 },
};

const richResults: LinkedContentSearchResults = {
  contacts: {
    items: [{ contactId: "c1", displayName: "John Doe", role: "Buyer" }],
    total: 1,
  },
  emails: {
    items: [
      { id: "e1", subject: "Escrow docs", sender: "agent@x.com", sentAt: null, snippet: "hi" },
    ],
    total: 3,
  },
  texts: {
    items: [{ id: "m1", sender: "+15551234567", snippet: "on my way", sentAt: null }],
    total: 1,
  },
};

const mockSearch = jest.fn();

beforeEach(() => {
  jest.useFakeTimers();
  mockSearch.mockReset();
  mockSearch.mockResolvedValue({ success: true, results: emptyResults });
  (window as unknown as { api: unknown }).api = {
    transactions: { searchLinkedContent: mockSearch },
  };
});

afterEach(() => {
  jest.useRealTimers();
});

function renderSearch(overrides?: {
  onNavigateContact?: jest.Mock;
  onNavigateEmail?: jest.Mock;
  onNavigateText?: jest.Mock;
}) {
  const onNavigateContact = overrides?.onNavigateContact ?? jest.fn();
  const onNavigateEmail = overrides?.onNavigateEmail ?? jest.fn();
  const onNavigateText = overrides?.onNavigateText ?? jest.fn();
  render(
    <LinkedContentSearch
      transactionId="txn-1"
      onNavigateContact={onNavigateContact}
      onNavigateEmail={onNavigateEmail}
      onNavigateText={onNavigateText}
    />,
  );
  return { onNavigateContact, onNavigateEmail, onNavigateText };
}

/** Advance past the debounce window and flush the resolved IPC promise. */
async function flushDebounce() {
  await act(async () => {
    jest.advanceTimersByTime(250);
  });
}

describe("LinkedContentSearch", () => {
  it("debounces rapid input and calls the search API once with the final query", async () => {
    renderSearch();
    const input = screen.getByTestId("linked-search-input");

    fireEvent.change(input, { target: { value: "j" } });
    fireEvent.change(input, { target: { value: "jo" } });
    fireEvent.change(input, { target: { value: "john" } });

    // No call yet — still within the debounce window.
    expect(mockSearch).not.toHaveBeenCalled();

    await flushDebounce();

    expect(mockSearch).toHaveBeenCalledTimes(1);
    expect(mockSearch).toHaveBeenCalledWith("txn-1", "john");
  });

  it("renders results grouped by type with counts", async () => {
    mockSearch.mockResolvedValue({ success: true, results: richResults });
    renderSearch();

    fireEvent.change(screen.getByTestId("linked-search-input"), {
      target: { value: "escrow" },
    });
    await flushDebounce();

    // Groups present
    expect(screen.getByTestId("linked-group-contacts")).toBeInTheDocument();
    expect(screen.getByTestId("linked-group-emails")).toBeInTheDocument();
    expect(screen.getByTestId("linked-group-texts")).toBeInTheDocument();

    // Item content
    expect(screen.getByText("John Doe")).toBeInTheDocument();
    expect(screen.getByText("Escrow docs")).toBeInTheDocument();

    // Email total (3) exceeds shown items (1) ⇒ "+2 more" hint
    expect(screen.getByText(/\+2 more/)).toBeInTheDocument();
  });

  it("shows a clean empty state when there are no matches", async () => {
    mockSearch.mockResolvedValue({ success: true, results: emptyResults });
    renderSearch();

    fireEvent.change(screen.getByTestId("linked-search-input"), {
      target: { value: "zzz" },
    });
    await flushDebounce();

    expect(screen.getByTestId("linked-search-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("linked-group-contacts")).not.toBeInTheDocument();
  });

  it("invokes the matching navigation callback when a result is clicked", async () => {
    mockSearch.mockResolvedValue({ success: true, results: richResults });
    const { onNavigateContact, onNavigateEmail, onNavigateText } = renderSearch();

    fireEvent.change(screen.getByTestId("linked-search-input"), {
      target: { value: "x" },
    });
    await flushDebounce();

    fireEvent.click(screen.getByTestId("contact-result"));
    expect(onNavigateContact).toHaveBeenCalledWith("c1");

    fireEvent.click(screen.getByTestId("email-result"));
    expect(onNavigateEmail).toHaveBeenCalledWith("e1");

    fireEvent.click(screen.getByTestId("text-result"));
    expect(onNavigateText).toHaveBeenCalledWith("m1");
  });

  it("does not search on an empty query (no panel rendered)", async () => {
    renderSearch();
    await flushDebounce();
    expect(mockSearch).not.toHaveBeenCalled();
    expect(screen.queryByTestId("linked-search-panel")).not.toBeInTheDocument();
  });
});
