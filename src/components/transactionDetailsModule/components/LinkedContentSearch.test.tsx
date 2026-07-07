/**
 * Tests for LinkedContentSearch (BACKLOG-1866, generalized in BACKLOG-1876)
 *
 * Covers both scopes:
 *   - Transaction scope: debounce, grouped rendering, empty state, navigation
 *     callbacks (attribution null), IPC-unavailable state. Behavior parity with
 *     the original BACKLOG-1866 overview panel.
 *   - Global scope: five groups (transactions/contacts/emails/texts/unattached),
 *     attribution badges + "Not attached", inert unattached rows, and navigation
 *     callbacks carrying the owning-transaction attribution.
 */
import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { LinkedContentSearch } from "./LinkedContentSearch";
import type {
  LinkedContentSearchResults,
  GlobalContentSearchResults,
} from "@electron/types/ipc/window-api-transactions";

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

const ATTR_MAIN = { transactionId: "t1", propertyAddress: "123 Main St" };
const ATTR_OAK = { transactionId: "t2", propertyAddress: "456 Oak Ave" };

const globalResults: GlobalContentSearchResults = {
  transactions: {
    items: [{ id: "t1", propertyAddress: "123 Main St" }],
    total: 1,
  },
  contacts: {
    items: [
      { contactId: "c1", displayName: "John Doe", role: "Buyer", attribution: ATTR_MAIN },
      { contactId: "c2", displayName: "Jane Roe", role: null, attribution: null },
    ],
    total: 2,
  },
  emails: {
    items: [
      {
        id: "e1",
        subject: "Escrow docs",
        sender: "agent@x.com",
        sentAt: null,
        snippet: "hi",
        attribution: ATTR_MAIN,
      },
    ],
    total: 1,
  },
  texts: {
    items: [
      { id: "m1", sender: "+15551234567", snippet: "omw", sentAt: null, attribution: ATTR_OAK },
    ],
    total: 1,
  },
  unattached: {
    items: [
      { kind: "email", id: "u1", title: "Unlinked mail", sender: "b@x.com", snippet: "sn", sentAt: null },
    ],
    total: 1,
  },
};

const mockScoped = jest.fn();
const mockGlobal = jest.fn();

beforeEach(() => {
  jest.useFakeTimers();
  mockScoped.mockReset();
  mockGlobal.mockReset();
  mockScoped.mockResolvedValue({ success: true, results: emptyResults });
  mockGlobal.mockResolvedValue({ success: true, results: globalResults });
  (window as unknown as { api: unknown }).api = {
    transactions: {
      searchLinkedContent: mockScoped,
      searchGlobalContent: mockGlobal,
    },
  };
});

afterEach(() => {
  jest.useRealTimers();
});

/** Advance past the debounce window and flush the resolved IPC promise. */
async function flushDebounce() {
  await act(async () => {
    jest.advanceTimersByTime(250);
  });
}

function renderScoped(overrides?: {
  onNavigateContact?: jest.Mock;
  onNavigateEmail?: jest.Mock;
  onNavigateText?: jest.Mock;
}) {
  const onNavigateContact = overrides?.onNavigateContact ?? jest.fn();
  const onNavigateEmail = overrides?.onNavigateEmail ?? jest.fn();
  const onNavigateText = overrides?.onNavigateText ?? jest.fn();
  render(
    <LinkedContentSearch
      scope={{ type: "transaction", id: "txn-1" }}
      onNavigateContact={onNavigateContact}
      onNavigateEmail={onNavigateEmail}
      onNavigateText={onNavigateText}
    />,
  );
  return { onNavigateContact, onNavigateEmail, onNavigateText };
}

function renderGlobal(overrides?: {
  onNavigateContact?: jest.Mock;
  onNavigateEmail?: jest.Mock;
  onNavigateText?: jest.Mock;
  onNavigateTransaction?: jest.Mock;
}) {
  const onNavigateContact = overrides?.onNavigateContact ?? jest.fn();
  const onNavigateEmail = overrides?.onNavigateEmail ?? jest.fn();
  const onNavigateText = overrides?.onNavigateText ?? jest.fn();
  const onNavigateTransaction = overrides?.onNavigateTransaction ?? jest.fn();
  render(
    <LinkedContentSearch
      scope={{ type: "global", userId: "user-1" }}
      onNavigateContact={onNavigateContact}
      onNavigateEmail={onNavigateEmail}
      onNavigateText={onNavigateText}
      onNavigateTransaction={onNavigateTransaction}
    />,
  );
  return { onNavigateContact, onNavigateEmail, onNavigateText, onNavigateTransaction };
}

describe("LinkedContentSearch — transaction scope", () => {
  it("debounces rapid input and calls the scoped API once with the final query", async () => {
    renderScoped();
    const input = screen.getByTestId("linked-search-input");

    fireEvent.change(input, { target: { value: "j" } });
    fireEvent.change(input, { target: { value: "jo" } });
    fireEvent.change(input, { target: { value: "john" } });

    expect(mockScoped).not.toHaveBeenCalled();

    await flushDebounce();

    expect(mockScoped).toHaveBeenCalledTimes(1);
    expect(mockScoped).toHaveBeenCalledWith("txn-1", "john");
    expect(mockGlobal).not.toHaveBeenCalled();
  });

  it("renders results grouped by type with counts (no transactions/unattached group)", async () => {
    mockScoped.mockResolvedValue({ success: true, results: richResults });
    renderScoped();

    fireEvent.change(screen.getByTestId("linked-search-input"), {
      target: { value: "escrow" },
    });
    await flushDebounce();

    expect(screen.getByTestId("linked-group-contacts")).toBeInTheDocument();
    expect(screen.getByTestId("linked-group-emails")).toBeInTheDocument();
    expect(screen.getByTestId("linked-group-texts")).toBeInTheDocument();
    // Scoped mode never renders the global-only groups or attribution badges.
    expect(screen.queryByTestId("linked-group-transactions")).not.toBeInTheDocument();
    expect(screen.queryByTestId("linked-group-unattached")).not.toBeInTheDocument();
    expect(screen.queryByTestId("attribution-badge")).not.toBeInTheDocument();

    expect(screen.getByText("John Doe")).toBeInTheDocument();
    expect(screen.getByText("Escrow docs")).toBeInTheDocument();
    expect(screen.getByText(/\+2 more/)).toBeInTheDocument();
  });

  it("shows a clean empty state when there are no matches", async () => {
    mockScoped.mockResolvedValue({ success: true, results: emptyResults });
    renderScoped();

    fireEvent.change(screen.getByTestId("linked-search-input"), {
      target: { value: "zzz" },
    });
    await flushDebounce();

    expect(screen.getByTestId("linked-search-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("linked-group-contacts")).not.toBeInTheDocument();
  });

  it("invokes the matching navigation callback (attribution null) when a result is clicked", async () => {
    mockScoped.mockResolvedValue({ success: true, results: richResults });
    const { onNavigateContact, onNavigateEmail, onNavigateText } = renderScoped();

    fireEvent.change(screen.getByTestId("linked-search-input"), {
      target: { value: "x" },
    });
    await flushDebounce();

    fireEvent.click(screen.getByTestId("contact-result"));
    expect(onNavigateContact).toHaveBeenCalledWith("c1", null);

    fireEvent.click(screen.getByTestId("email-result"));
    expect(onNavigateEmail).toHaveBeenCalledWith("e1", null);

    fireEvent.click(screen.getByTestId("text-result"));
    expect(onNavigateText).toHaveBeenCalledWith("m1", null);
  });

  it("does not search on an empty query (no panel rendered)", async () => {
    renderScoped();
    await flushDebounce();
    expect(mockScoped).not.toHaveBeenCalled();
    expect(screen.queryByTestId("linked-search-panel")).not.toBeInTheDocument();
  });

  it("shows unavailable state on IPC rejection instead of empty results", async () => {
    mockScoped.mockRejectedValue(new Error("No handler registered"));
    renderScoped();

    fireEvent.change(screen.getByTestId("linked-search-input"), {
      target: { value: "test" },
    });
    await flushDebounce();

    expect(screen.getByTestId("linked-search-unavailable")).toBeInTheDocument();
    expect(screen.queryByTestId("linked-search-empty")).not.toBeInTheDocument();
  });
});

describe("LinkedContentSearch — global scope", () => {
  it("calls the global API (not the scoped one) with the query", async () => {
    renderGlobal();
    fireEvent.change(screen.getByTestId("linked-search-input"), {
      target: { value: "main" },
    });
    await flushDebounce();

    expect(mockGlobal).toHaveBeenCalledTimes(1);
    expect(mockGlobal).toHaveBeenCalledWith("user-1", "main");
    expect(mockScoped).not.toHaveBeenCalled();
  });

  it("renders all five groups with attribution badges and 'Not attached'", async () => {
    renderGlobal();
    fireEvent.change(screen.getByTestId("linked-search-input"), {
      target: { value: "main" },
    });
    await flushDebounce();

    expect(screen.getByTestId("linked-group-transactions")).toBeInTheDocument();
    expect(screen.getByTestId("linked-group-contacts")).toBeInTheDocument();
    expect(screen.getByTestId("linked-group-emails")).toBeInTheDocument();
    expect(screen.getByTestId("linked-group-texts")).toBeInTheDocument();
    expect(screen.getByTestId("linked-group-unattached")).toBeInTheDocument();

    // Owning-transaction badges appear (e.g. the email + contact on 123 Main St).
    expect(screen.getAllByTestId("attribution-badge").length).toBeGreaterThan(0);
    // The unattributed contact renders a "Not attached" marker.
    expect(screen.getAllByTestId("attribution-none").length).toBeGreaterThan(0);
  });

  it("navigates: transaction hit opens the transaction directly", async () => {
    const { onNavigateTransaction } = renderGlobal();
    fireEvent.change(screen.getByTestId("linked-search-input"), {
      target: { value: "main" },
    });
    await flushDebounce();

    fireEvent.click(screen.getByTestId("transaction-result"));
    expect(onNavigateTransaction).toHaveBeenCalledWith("t1");
  });

  it("navigates: email/text hits carry their owning-transaction attribution", async () => {
    const { onNavigateEmail, onNavigateText, onNavigateContact } = renderGlobal();
    fireEvent.change(screen.getByTestId("linked-search-input"), {
      target: { value: "main" },
    });
    await flushDebounce();

    fireEvent.click(screen.getByTestId("email-result"));
    expect(onNavigateEmail).toHaveBeenCalledWith("e1", ATTR_MAIN);

    fireEvent.click(screen.getByTestId("text-result"));
    expect(onNavigateText).toHaveBeenCalledWith("m1", ATTR_OAK);

    // First contact carries attribution; navigation passes it through.
    fireEvent.click(screen.getAllByTestId("contact-result")[0]);
    expect(onNavigateContact).toHaveBeenCalledWith("c1", ATTR_MAIN);
  });

  it("renders unattached hits as inert rows (no navigation)", async () => {
    const { onNavigateEmail, onNavigateText, onNavigateContact, onNavigateTransaction } =
      renderGlobal();
    fireEvent.change(screen.getByTestId("linked-search-input"), {
      target: { value: "main" },
    });
    await flushDebounce();

    const unattached = screen.getByTestId("unattached-result");
    // The row is not a button and clicking it triggers no navigation callback.
    expect(unattached.tagName).not.toBe("BUTTON");
    fireEvent.click(unattached);
    expect(onNavigateEmail).not.toHaveBeenCalled();
    expect(onNavigateText).not.toHaveBeenCalled();
    expect(onNavigateContact).not.toHaveBeenCalled();
    expect(onNavigateTransaction).not.toHaveBeenCalled();
  });
});
