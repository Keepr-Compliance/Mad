/**
 * BACKLOG-2816 (founder ruling, 2026-08-23) — what a group-chat-name result row
 * actually renders.
 *
 * His words: "just show the group name, not anything from the body. If you want
 * you can show a few of the members of the group chat (with name not numbers)."
 *
 * So this suite asserts three things, one of which is an ABSENCE:
 *   1. the primary line is the GROUP NAME;
 *   2. the member line is contact NAMES;
 *   3. NO message body appears on that row — asserted as absence, so a snippet
 *      cannot creep back in later without a test going red.
 *
 * Message hits are unchanged and asserted alongside, because the founder chose to
 * keep them per-message and that is now a promise rather than an accident.
 *
 * All names and handles are invented.
 */
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { LinkedContentSearch } from "../LinkedContentSearch";

const mockSearchGlobal = jest.fn();
const mockSearchLinked = jest.fn();

beforeAll(() => {
  Object.defineProperty(window, "api", {
    value: {
      transactions: {
        searchGlobalContent: mockSearchGlobal,
        searchLinkedContent: mockSearchLinked,
      },
    },
    writable: true,
  });
});

const GROUP_NAME = "Kingfisher Lane Closing";
const MEMBER_A = "Dana Whitfield";
const MEMBER_B = "Marcus Otero";
const BODY_TEXT = "the lockbox code is on the counter";

const emptyGroup = { items: [], total: 0 };

function resultsWith(textItems: unknown[]) {
  return {
    transactions: emptyGroup,
    contacts: emptyGroup,
    emails: emptyGroup,
    texts: { items: textItems, total: 546 },
    unattached: emptyGroup,
  };
}

/** A collapsed group-name row, exactly as the service now shapes it. */
const groupRow = {
  id: "m-newest",
  sender: null,
  snippet: null,
  sentAt: "2026-06-25T00:00:00.000Z",
  attribution: null,
  threadDisplayName: GROUP_NAME,
  memberNames: [MEMBER_A, MEMBER_B],
};

/** An ordinary per-message row, unchanged by this work. */
const messageRow = {
  id: "m-body",
  sender: "+14155550190",
  snippet: BODY_TEXT,
  sentAt: "2026-05-01T00:00:00.000Z",
  attribution: null,
};

/**
 * The rendered primary line is split across text nodes — `highlightMatch` wraps
 * the matched term in its own element, so "Kingfisher Lane Closing" reaches the
 * DOM as <mark>Kingfisher</mark> + " Lane Closing" and `getByText` cannot see it
 * whole. Assert on the row's text content instead.
 */
function rowText(index = 0): string {
  return screen.getAllByTestId("text-result")[index].textContent ?? "";
}

async function searchFor(items: unknown[]): Promise<void> {
  mockSearchGlobal.mockResolvedValue({ success: true, results: resultsWith(items) });
  render(
    <LinkedContentSearch
      scope={{ type: "global", userId: "u-1" }}
      onNavigateContact={jest.fn()}
      onNavigateEmail={jest.fn()}
      onNavigateText={jest.fn()}
      onNavigateTransaction={jest.fn()}
    />,
  );
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "kingfisher" } });
  await waitFor(() => expect(screen.getAllByTestId("text-result").length).toBeGreaterThan(0));
}

describe("BACKLOG-2816 — the group-name result row", () => {
  beforeEach(() => jest.clearAllMocks());

  it("is headed by the GROUP CHAT NAME", async () => {
    await searchFor([groupRow]);
    expect(rowText()).toContain(GROUP_NAME);
  });

  it("lists members by resolved contact NAME, never a raw number", async () => {
    await searchFor([groupRow]);
    const members = screen.getByTestId("text-result-members");
    expect(members).toHaveTextContent(MEMBER_A);
    expect(members).toHaveTextContent(MEMBER_B);
    // The thing he ruled out: a secondary line of raw digits.
    expect(members.textContent ?? "").not.toMatch(/\d{3}/);
  });

  it("renders NO message body on that row", async () => {
    await searchFor([groupRow]);
    expect(screen.queryByText(BODY_TEXT)).not.toBeInTheDocument();
    const row = screen.getByTestId("text-result");
    expect(row.textContent ?? "").not.toContain("lockbox");
  });

  it("omits the member line entirely when no member resolved to a contact", async () => {
    // The handler drops unresolved members, so memberNames arrives empty. The row
    // must then show the group name ALONE — not a list of numbers.
    await searchFor([{ ...groupRow, memberNames: [] }]);
    expect(rowText()).toContain(GROUP_NAME);
    expect(screen.queryByTestId("text-result-members")).not.toBeInTheDocument();
    // And nothing resembling a phone number took its place.
    expect(rowText()).not.toMatch(/\d{3}/);
  });

  it("leaves an ordinary message row showing its sender and body", async () => {
    await searchFor([messageRow]);
    expect(screen.getByText("+14155550190")).toBeInTheDocument();
    expect(screen.getByText(BODY_TEXT)).toBeInTheDocument();
    expect(screen.queryByTestId("text-result-members")).not.toBeInTheDocument();
  });

  it("shows both shapes in one list — the accepted outcome", async () => {
    await searchFor([groupRow, messageRow]);
    expect(screen.getAllByTestId("text-result")).toHaveLength(2);
    // Thread row first (a named conversation is the more specific answer),
    // then the per-message row — two shapes, one list.
    expect(rowText(0)).toContain(GROUP_NAME);
    expect(rowText(0)).not.toContain("lockbox");
    expect(rowText(1)).toContain(BODY_TEXT);
  });

  it("still shows the message count the founder chose to keep", async () => {
    await searchFor([groupRow]);
    // One collapsed row under a badge of 546 — stated, not a defect.
    expect(screen.getByText("546")).toBeInTheDocument();
  });
});
