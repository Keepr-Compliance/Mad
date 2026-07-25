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
import { render, screen, fireEvent, act, within } from "@testing-library/react";
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
    // BACKLOG-2248: the "escrow" query highlights the subject, splitting it across a
    // <mark>, so assert on the row's full text content rather than a single node.
    expect(screen.getByTestId("email-result")).toHaveTextContent("Escrow docs");
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

describe("LinkedContentSearch — BACKLOG-1870 Phase 1.5 matched-attachment indicator", () => {
  const withMatchedAttachment: LinkedContentSearchResults = {
    contacts: { items: [], total: 0 },
    emails: {
      items: [
        {
          id: "e1",
          subject: "Closing docs",
          sender: "agent@x.com",
          sentAt: null,
          snippet: "see attached",
          matchedAttachmentFilenames: ["wire-instructions.pdf"],
        },
      ],
      total: 1,
    },
    texts: {
      items: [
        {
          id: "m1",
          sender: "+15551234567",
          snippet: "pic",
          sentAt: null,
          matchedAttachmentFilenames: ["IMG_2201.heic"],
        },
      ],
      total: 1,
    },
  };

  it("shows the matched attachment filename under the email and text results", async () => {
    mockScoped.mockResolvedValue({ success: true, results: withMatchedAttachment });
    renderScoped();

    fireEvent.change(screen.getByTestId("linked-search-input"), {
      target: { value: "wire" },
    });
    await flushDebounce();

    const indicators = screen.getAllByTestId("matched-attachment");
    expect(indicators).toHaveLength(2); // one under the email, one under the text
    // BACKLOG-2248: the "wire" query highlights part of the filename (splitting it
    // across a <mark>), so assert on the row's full text content.
    expect(screen.getByTestId("email-result")).toHaveTextContent(
      "wire-instructions.pdf",
    );
    expect(screen.getByTestId("text-result")).toHaveTextContent("IMG_2201.heic");
  });

  it("does NOT show the indicator when the match was subject/body-only", async () => {
    // richResults hits carry no matchedAttachmentFilenames.
    mockScoped.mockResolvedValue({ success: true, results: richResults });
    renderScoped();

    fireEvent.change(screen.getByTestId("linked-search-input"), {
      target: { value: "escrow" },
    });
    await flushDebounce();

    expect(screen.getByTestId("email-result")).toBeInTheDocument();
    expect(screen.queryByTestId("matched-attachment")).not.toBeInTheDocument();
  });
});

describe("LinkedContentSearch — BACKLOG-2248 matched-term highlighting", () => {
  /** Render the scoped panel with a custom result set and settle a query. */
  async function searchScopedWith(
    results: LinkedContentSearchResults,
    query: string,
  ) {
    mockScoped.mockResolvedValue({ success: true, results });
    renderScoped();
    fireEvent.change(screen.getByTestId("linked-search-input"), {
      target: { value: query },
    });
    await flushDebounce();
  }

  it("highlights the term in BOTH the subject line and the 📎 filename line", async () => {
    const results: LinkedContentSearchResults = {
      contacts: { items: [], total: 0 },
      emails: {
        items: [
          {
            id: "e1",
            subject: "Closing docs",
            sender: "agent@x.com",
            sentAt: null,
            snippet: "see attached",
            matchedAttachmentFilenames: ["final-doc.pdf"],
          },
        ],
        total: 1,
      },
      texts: { items: [], total: 0 },
    };
    // "doc" appears in the subject ("docs") and the filename ("final-doc.pdf"),
    // but NOT in the sender or snippet.
    await searchScopedWith(results, "doc");

    const row = screen.getByTestId("email-result");
    const rowHighlights = within(row).getAllByTestId("search-highlight");
    // At least one in the subject and one in the filename line.
    expect(rowHighlights.length).toBeGreaterThanOrEqual(2);

    // The 📎 filename line is highlighted.
    const fileLine = within(row).getByTestId("matched-attachment");
    expect(
      within(fileLine).getAllByTestId("search-highlight").length,
    ).toBeGreaterThanOrEqual(1);

    // A highlight also exists OUTSIDE the filename line (the subject).
    const outsideFileLine = rowHighlights.filter((h) => !fileLine.contains(h));
    expect(outsideFileLine.length).toBeGreaterThanOrEqual(1);

    // Every highlight is the matched term (original casing preserved, here "doc").
    rowHighlights.forEach((h) =>
      expect(h.textContent?.toLowerCase()).toBe("doc"),
    );
  });

  it("highlights the sender in a text result's primary line", async () => {
    const results: LinkedContentSearchResults = {
      contacts: { items: [], total: 0 },
      emails: { items: [], total: 0 },
      texts: {
        items: [
          { id: "m1", sender: "Alice Agent", snippet: "on my way", sentAt: null },
        ],
        total: 1,
      },
    };
    await searchScopedWith(results, "agent");

    const row = screen.getByTestId("text-result");
    const highlights = within(row).getAllByTestId("search-highlight");
    expect(highlights.length).toBeGreaterThanOrEqual(1);
    // "Agent" (original casing) is highlighted from the case-insensitive "agent".
    expect(highlights.some((h) => h.textContent === "Agent")).toBe(true);
  });

  it("renders NO highlight in a field that does not contain the term", async () => {
    const results: LinkedContentSearchResults = {
      contacts: { items: [], total: 0 },
      emails: {
        items: [
          {
            id: "e1",
            subject: "Closing docs",
            sender: "agent@x.com",
            sentAt: null,
            snippet: "see attached",
            // Filename does NOT contain "closing".
            matchedAttachmentFilenames: ["wire-instructions.pdf"],
          },
        ],
        total: 1,
      },
      texts: { items: [], total: 0 },
    };
    await searchScopedWith(results, "closing");

    const row = screen.getByTestId("email-result");
    // Subject IS highlighted…
    expect(
      within(row).getAllByTestId("search-highlight").length,
    ).toBeGreaterThanOrEqual(1);
    // …but the filename line, which lacks the term, has NO highlight span.
    const fileLine = within(row).getByTestId("matched-attachment");
    expect(within(fileLine).queryByTestId("search-highlight")).toBeNull();
  });

  it("renders no highlight anywhere when the query is absent from every field", async () => {
    const results: LinkedContentSearchResults = {
      contacts: {
        items: [{ contactId: "c1", displayName: "John Doe", role: "Buyer" }],
        total: 1,
      },
      emails: { items: [], total: 0 },
      texts: { items: [], total: 0 },
    };
    // "zzz" matches the (mocked) result set server-side but is not a substring of
    // any displayed field, so nothing should be visually highlighted.
    await searchScopedWith(results, "zzz");

    expect(screen.getByTestId("contact-result")).toHaveTextContent("John Doe");
    expect(screen.queryByTestId("search-highlight")).toBeNull();
  });

  it("treats regex metacharacters as a literal substring — parentheses", async () => {
    const results: LinkedContentSearchResults = {
      contacts: { items: [], total: 0 },
      emails: {
        items: [
          {
            id: "e1",
            subject: "value (x) here",
            sender: "s@x.com",
            sentAt: null,
            snippet: "n/a",
          },
        ],
        total: 1,
      },
      texts: { items: [], total: 0 },
    };
    await searchScopedWith(results, "(x)");

    const highlights = screen.getAllByTestId("search-highlight");
    // Literal "(x)" is highlighted — NOT the regex-group interpretation ("x").
    expect(highlights.some((h) => h.textContent === "(x)")).toBe(true);
    expect(highlights.every((h) => h.textContent !== "x")).toBe(true);
  });

  it("escapes '.' so it matches a literal dot, not any character", async () => {
    const results: LinkedContentSearchResults = {
      contacts: { items: [], total: 0 },
      emails: {
        items: [
          {
            id: "e1",
            subject: "a.b literal",
            sender: "s@x.com",
            // If "." were an unescaped wildcard, "aXb" here would match "a.b".
            snippet: "aXb random",
            sentAt: null,
          },
        ],
        total: 1,
      },
      texts: { items: [], total: 0 },
    };
    await searchScopedWith(results, "a.b");

    const highlights = screen.getAllByTestId("search-highlight");
    // Only the literal "a.b" in the subject is highlighted; "aXb" is not.
    expect(highlights).toHaveLength(1);
    expect(highlights[0].textContent).toBe("a.b");
  });

  it("does not throw on an unbalanced-parenthesis query", async () => {
    const results: LinkedContentSearchResults = {
      contacts: { items: [], total: 0 },
      emails: {
        items: [
          {
            id: "e1",
            subject: "ring (now) please",
            sender: "s@x.com",
            sentAt: null,
            snippet: "n/a",
          },
        ],
        total: 1,
      },
      texts: { items: [], total: 0 },
    };
    // A raw "(" would make an invalid RegExp if not escaped — rendering must not throw.
    await searchScopedWith(results, "(");

    const highlights = screen.getAllByTestId("search-highlight");
    expect(highlights.length).toBeGreaterThanOrEqual(1);
    expect(highlights[0].textContent).toBe("(");
  });
});
