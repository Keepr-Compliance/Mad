/**
 * AttachEmailsModal Tests (TASK-1993)
 * Tests for server-side email search, date filtering, and load more.
 */
import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { AttachEmailsModal } from "../AttachEmailsModal";

// Mock useAuth
jest.mock("../../../../../contexts", () => ({
  useAuth: () => ({ currentUser: { id: "user-123", email: "test@example.com" } }),
}));

// Mock IntersectionObserver (not available in jsdom)
const mockObserve = jest.fn();
const mockDisconnect = jest.fn();
beforeAll(() => {
  (global as Record<string, unknown>).IntersectionObserver = jest.fn(() => ({
    observe: mockObserve,
    disconnect: mockDisconnect,
    unobserve: jest.fn(),
  }));
});

// Mock the window.api
const mockGetUnlinkedEmails = jest.fn();
const mockLinkEmails = jest.fn();

beforeAll(() => {
  Object.defineProperty(window, "api", {
    value: {
      transactions: {
        getUnlinkedEmails: mockGetUnlinkedEmails,
        linkEmails: mockLinkEmails,
      },
    },
    writable: true,
  });
});

describe("AttachEmailsModal", () => {
  const mockOnClose = jest.fn();
  const mockOnAttached = jest.fn();
  const defaultProps = {
    userId: "user-123",
    transactionId: "txn-456",
    propertyAddress: "123 Main St",
    onClose: mockOnClose,
    onAttached: mockOnAttached,
  };

  const mockEmails = [
    {
      id: "gmail:msg-1",
      subject: "Closing Documents",
      sender: "agent@example.com",
      sent_at: "2024-06-01T10:00:00Z",
      body_preview: "Here are the closing docs",
      thread_id: "thread-1",
    },
    {
      id: "gmail:msg-2",
      subject: "Closing Documents",
      sender: "buyer@example.com",
      sent_at: "2024-06-02T12:00:00Z",
      body_preview: "Thanks for sending",
      thread_id: "thread-1",
    },
    {
      id: "gmail:msg-3",
      subject: "Inspection Report",
      sender: "inspector@example.com",
      sent_at: "2024-05-15T09:00:00Z",
      body_preview: "Inspection complete",
      thread_id: "thread-2",
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockGetUnlinkedEmails.mockResolvedValue({
      success: true,
      emails: mockEmails,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("renders and fetches emails on mount", async () => {
    render(<AttachEmailsModal {...defaultProps} />);

    // Should show loading initially
    expect(screen.getByText("Loading emails...")).toBeInTheDocument();

    // Wait for the fetch to complete
    await waitFor(() => {
      expect(mockGetUnlinkedEmails).toHaveBeenCalledWith("user-123", { maxResults: 500, transactionId: "txn-456" });
    });

    // Should show conversations after loading
    await waitFor(() => {
      expect(screen.getByText(/conversation/)).toBeInTheDocument();
    });
  });

  it("passes no query on initial load (backward compatible)", async () => {
    render(<AttachEmailsModal {...defaultProps} />);

    await waitFor(() => {
      expect(mockGetUnlinkedEmails).toHaveBeenCalledWith("user-123", { maxResults: 500, transactionId: "txn-456" });
    });

    // Verify the call does NOT include query, after, or before
    const callArgs = mockGetUnlinkedEmails.mock.calls[0][1];
    expect(callArgs.query).toBeUndefined();
    expect(callArgs.after).toBeUndefined();
    expect(callArgs.before).toBeUndefined();
  });

  it("debounces search input and triggers server-side fetch with query", async () => {
    render(<AttachEmailsModal {...defaultProps} />);

    // Wait for initial load
    await waitFor(() => {
      expect(mockGetUnlinkedEmails).toHaveBeenCalledTimes(1);
    });

    // Clear mock to track new calls
    mockGetUnlinkedEmails.mockClear();
    mockGetUnlinkedEmails.mockResolvedValue({
      success: true,
      emails: [mockEmails[0], mockEmails[1]], // Filtered results
    });

    // Type in search box
    const searchInput = screen.getByTestId("search-input");
    fireEvent.change(searchInput, { target: { value: "closing" } });

    // Should NOT have called yet (debounce not elapsed)
    expect(mockGetUnlinkedEmails).not.toHaveBeenCalled();

    // Advance timer past debounce delay
    act(() => {
      jest.advanceTimersByTime(500);
    });

    // Now should trigger a fetch with the query
    await waitFor(() => {
      expect(mockGetUnlinkedEmails).toHaveBeenCalledWith("user-123", {
        query: "closing",
        maxResults: 500,
        transactionId: "txn-456",
      });
    });
  });

  it("passes date filter values to the fetch call", async () => {
    render(<AttachEmailsModal {...defaultProps} />);

    // Wait for initial load
    await waitFor(() => {
      expect(mockGetUnlinkedEmails).toHaveBeenCalledTimes(1);
    });

    mockGetUnlinkedEmails.mockClear();
    mockGetUnlinkedEmails.mockResolvedValue({
      success: true,
      emails: [mockEmails[2]],
    });

    // Set date filter
    const afterInput = screen.getByTestId("after-date-input");
    fireEvent.change(afterInput, { target: { value: "2024-05-01" } });

    // Date change triggers fetch immediately (no debounce on date fields)
    await waitFor(() => {
      expect(mockGetUnlinkedEmails).toHaveBeenCalledWith("user-123", expect.objectContaining({
        after: expect.stringContaining("2024-05-01"),
        maxResults: 500,
      }));
    });
  });

  it("shows search placeholder with contact search hint", async () => {
    render(<AttachEmailsModal {...defaultProps} />);

    const searchInput = screen.getByTestId("search-input");
    expect(searchInput).toHaveAttribute("placeholder", "Search by name, email, subject, or content...");
  });

  it("shows empty state for search when no results", async () => {
    mockGetUnlinkedEmails.mockResolvedValue({
      success: true,
      emails: [],
    });

    render(<AttachEmailsModal {...defaultProps} />);

    // Wait for initial load (empty)
    await waitFor(() => {
      expect(screen.getByText("No unlinked emails available")).toBeInTheDocument();
    });

    // Now simulate a search that returns empty
    mockGetUnlinkedEmails.mockResolvedValue({
      success: true,
      emails: [],
    });

    const searchInput = screen.getByTestId("search-input");
    fireEvent.change(searchInput, { target: { value: "nonexistent" } });

    act(() => {
      jest.advanceTimersByTime(500);
    });

    await waitFor(() => {
      expect(screen.getByText("No emails matching your search")).toBeInTheDocument();
    });
  });

  it("shows Audit Period button when auditStartDate is provided", async () => {
    render(
      <AttachEmailsModal
        {...defaultProps}
        auditStartDate="2024-01-15T00:00:00Z"
        auditEndDate="2024-06-30T00:00:00Z"
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("audit-period-button")).toBeInTheDocument();
    });

    expect(screen.getByTestId("audit-period-button")).toHaveTextContent("Audit Period");
  });

  it("does not show Audit Period button when no audit dates provided", async () => {
    render(<AttachEmailsModal {...defaultProps} />);

    await waitFor(() => {
      expect(mockGetUnlinkedEmails).toHaveBeenCalled();
    });

    expect(screen.queryByTestId("audit-period-button")).not.toBeInTheDocument();
  });

  it("fills date fields when Audit Period button is clicked", async () => {
    render(
      <AttachEmailsModal
        {...defaultProps}
        auditStartDate="2024-01-15T00:00:00Z"
        auditEndDate="2024-06-30T00:00:00Z"
      />
    );

    await waitFor(() => {
      expect(mockGetUnlinkedEmails).toHaveBeenCalled();
    });

    // The dates should be pre-populated from props
    const afterInput = screen.getByTestId("after-date-input") as HTMLInputElement;
    const beforeInput = screen.getByTestId("before-date-input") as HTMLInputElement;
    expect(afterInput.value).toBe("2024-01-15");
    expect(beforeInput.value).toBe("2024-06-30");
  });

  it("shows date filter UI", async () => {
    render(<AttachEmailsModal {...defaultProps} />);

    expect(screen.getByTestId("date-filter")).toBeInTheDocument();
    expect(screen.getByTestId("after-date-input")).toBeInTheDocument();
    expect(screen.getByTestId("before-date-input")).toBeInTheDocument();
    expect(screen.getByText("Date range:")).toBeInTheDocument();
  });

  it("handles error state", async () => {
    mockGetUnlinkedEmails.mockResolvedValue({
      success: false,
      error: "No email account connected",
    });

    render(<AttachEmailsModal {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("No email account connected")).toBeInTheDocument();
    });
  });

  it("handles fetch exception", async () => {
    mockGetUnlinkedEmails.mockRejectedValue(new Error("Network error"));

    render(<AttachEmailsModal {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeInTheDocument();
    });
  });

  /**
   * BACKLOG-1841: Whole-thread attach guarantee tests.
   *
   * Thread IDs in these tests resolve as follows:
   *   mockEmails[0] + [1] share thread_id "thread-1"
   *     → getEmailThreadKey returns "thread-thread-1"
   *     → data-testid = "thread-thread-thread-1"
   *   mockEmails[2] has thread_id "thread-2"
   *     → getEmailThreadKey returns "thread-thread-2"
   *     → data-testid = "thread-thread-thread-2"
   *
   * Current granularity (verified via code trace, lines 270-278):
   *   Selecting a thread checkbox collects ALL email IDs from that thread
   *   via the selectedEmailIds memo, which iterates emailThreads (all loaded
   *   threads, not just the paginated displayedThreads subset). There is no
   *   per-email selection UI. The code was already whole-thread correct before
   *   this ticket; these tests lock in that guarantee going forward.
   */
  describe("Whole-thread attach (BACKLOG-1841)", () => {
    beforeEach(() => {
      // outer beforeEach already set mockGetUnlinkedEmails to return mockEmails
      // (thread-1: msg-1 + msg-2, thread-2: msg-3)
      mockLinkEmails.mockResolvedValue({ success: true });
    });

    it("(a) selecting a multi-email thread submits all member email IDs", async () => {
      render(<AttachEmailsModal {...defaultProps} />);

      // Wait for the multi-email thread to appear
      await waitFor(() => {
        expect(screen.getByTestId("thread-thread-thread-1")).toBeInTheDocument();
      });

      // Select thread-1 (contains msg-1 and msg-2)
      fireEvent.click(screen.getByTestId("thread-thread-thread-1"));

      // Button should reflect 2 emails selected
      await waitFor(() => {
        expect(screen.getByTestId("attach-button")).toHaveTextContent("2 emails");
      });

      // Submit
      fireEvent.click(screen.getByTestId("attach-button"));

      await waitFor(() => {
        expect(mockLinkEmails).toHaveBeenCalledTimes(1);
      });

      const [submittedIds] = mockLinkEmails.mock.calls[0] as [string[], string];
      expect(submittedIds).toHaveLength(2);
      expect(submittedIds).toEqual(expect.arrayContaining(["gmail:msg-1", "gmail:msg-2"]));
      // msg-3 (different thread, not selected) must NOT be included
      expect(submittedIds).not.toContain("gmail:msg-3");
    });

    it("(b) mixed selection (multi-email thread + single-email thread) submits the union", async () => {
      render(<AttachEmailsModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId("thread-thread-thread-1")).toBeInTheDocument();
        expect(screen.getByTestId("thread-thread-thread-2")).toBeInTheDocument();
      });

      // Select both threads
      fireEvent.click(screen.getByTestId("thread-thread-thread-1")); // 2 emails
      fireEvent.click(screen.getByTestId("thread-thread-thread-2")); // 1 email

      // Button should reflect 3 emails total
      await waitFor(() => {
        expect(screen.getByTestId("attach-button")).toHaveTextContent("3 emails");
      });

      fireEvent.click(screen.getByTestId("attach-button"));

      await waitFor(() => {
        expect(mockLinkEmails).toHaveBeenCalledTimes(1);
      });

      const [submittedIds] = mockLinkEmails.mock.calls[0] as [string[], string];
      expect(submittedIds).toHaveLength(3);
      expect(submittedIds).toEqual(
        expect.arrayContaining(["gmail:msg-1", "gmail:msg-2", "gmail:msg-3"]),
      );
    });

    it("(c) single-email thread submits only its own ID unchanged", async () => {
      render(<AttachEmailsModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId("thread-thread-thread-2")).toBeInTheDocument();
      });

      // Select the single-email thread only
      fireEvent.click(screen.getByTestId("thread-thread-thread-2")); // msg-3 only

      // Button should reflect 1 email
      await waitFor(() => {
        expect(screen.getByTestId("attach-button")).toHaveTextContent("1 email");
      });

      fireEvent.click(screen.getByTestId("attach-button"));

      await waitFor(() => {
        expect(mockLinkEmails).toHaveBeenCalledTimes(1);
      });

      const [submittedIds] = mockLinkEmails.mock.calls[0] as [string[], string];
      expect(submittedIds).toHaveLength(1);
      expect(submittedIds).toEqual(["gmail:msg-3"]);
    });
  });
});
