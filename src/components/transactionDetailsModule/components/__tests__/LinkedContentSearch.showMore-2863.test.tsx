/**
 * BACKLOG-2863 — the search panel counts nothing and offers "Show more".
 *
 * ===========================================================================
 * WHAT WAS REMOVED, AND WHY IT WAS THE UI'S PROBLEM TO SOLVE
 * ===========================================================================
 * Every section heading carried a match COUNT. Behind each one was a
 * `SELECT COUNT(*)` with no `LIMIT` — six of them per keystroke, 190-210 ms each
 * on a 150k-message database — and unlike the row queries they could not exit
 * early, because proving a total means visiting every match. Capping them was
 * possible; it would have made the badges read "200+".
 *
 * Founder, given that choice: *"i'm also fine with just show more and not
 * counting it."*
 *
 * ===========================================================================
 * THE TWO THINGS THIS FILE PINS
 * ===========================================================================
 * **1. There is no dead control.** A "Show more" button renders only while it has
 * fetched rows left to reveal. A section already showing everything that came
 * back, over a database that held more, gets a SENTENCE — because a click could
 * not do anything, and a control that opens nothing is the founder's standing
 * ruling from BACKLOG-2791. The two cases are asserted separately, on fixtures
 * that differ only in how many rows came back, so a footer wired to the wrong
 * condition cannot pass both.
 *
 * **2. The heading carries no number.** Asserted against a fixture whose row
 * count (6) and cap (5) are DIFFERENT, so a heading that quietly started printing
 * `items.length` would still be caught.
 *
 * All names, addresses and handles are invented.
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

const emptyGroup = { items: [], hasMore: false };

/** `COLLAPSED_ROWS` in the component. Restated so a drift is a failure here. */
const COLLAPSED_ROWS = 5;

function emailRow(n: number): Record<string, unknown> {
  return {
    id: `e-${n}`,
    subject: `Alderman Way disclosure ${n}`,
    sender: `agent${n}@example.invalid`,
    sentAt: `2026-06-${String(n + 1).padStart(2, "0")}T00:00:00.000Z`,
    snippet: "please countersign",
    attribution: null,
  };
}

function resultsWithEmails(count: number, hasMore: boolean): Record<string, unknown> {
  return {
    transactions: emptyGroup,
    contacts: emptyGroup,
    emails: {
      items: Array.from({ length: count }, (_, i) => emailRow(i)),
      hasMore,
    },
    texts: emptyGroup,
    groupChats: emptyGroup,
    unattached: emptyGroup,
  };
}

async function search(results: Record<string, unknown>): Promise<void> {
  mockSearchGlobal.mockResolvedValue({ success: true, results });
  render(
    <LinkedContentSearch
      scope={{ type: "global", userId: "u-2863" }}
      onNavigateContact={jest.fn()}
      onNavigateEmail={jest.fn()}
      onNavigateText={jest.fn()}
      onNavigateTransaction={jest.fn()}
    />,
  );
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "alderman" } });
  await waitFor(() =>
    expect(screen.getByTestId("linked-search-panel")).toBeInTheDocument(),
  );
}

describe("BACKLOG-2863 — Show more replaces the count badge", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("caps a long section and reveals the rest when Show more is clicked", async () => {
    // Six rows came back and the database had nothing more. Five are shown; the
    // sixth is one click away, and after that click there is nothing left to say.
    await search(resultsWithEmails(6, false));
    await waitFor(() =>
      expect(screen.getByTestId("linked-group-emails")).toBeInTheDocument(),
    );

    expect(screen.getAllByTestId("email-result")).toHaveLength(COLLAPSED_ROWS);
    // Named by IDENTITY, not just counted: the row that must be hidden is the
    // SIXTH, and a cap that kept the wrong five would pass a length assertion.
    expect(screen.getByTestId("linked-group-emails").textContent ?? "").not.toContain(
      "disclosure 5",
    );

    fireEvent.click(screen.getByTestId("show-more-emails"));

    expect(screen.getAllByTestId("email-result")).toHaveLength(6);
    expect(screen.getByTestId("linked-group-emails").textContent ?? "").toContain(
      "disclosure 5",
    );
    // Everything fetched is now on screen and nothing was left behind, so the
    // footer is gone entirely rather than becoming an inert button.
    expect(screen.queryByTestId("show-more-emails")).not.toBeInTheDocument();
    expect(screen.queryByTestId("show-more-emails-refine")).not.toBeInTheDocument();
  });

  it("offers no control at all when the section fits", async () => {
    await search(resultsWithEmails(3, false));
    await waitFor(() =>
      expect(screen.getByTestId("linked-group-emails")).toBeInTheDocument(),
    );
    expect(screen.getAllByTestId("email-result")).toHaveLength(3);
    expect(screen.queryByTestId("show-more-emails")).not.toBeInTheDocument();
    expect(screen.queryByTestId("show-more-emails-refine")).not.toBeInTheDocument();
  });

  it("says so in words when more matches exist that were never fetched", async () => {
    // THE DEAD-CONTROL BOUNDARY (BACKLOG-2791). Three rows fetched, all three
    // shown, and the database held more. A "Show more" button here would be a
    // control with nothing behind it.
    await search(resultsWithEmails(3, true));
    await waitFor(() =>
      expect(screen.getByTestId("linked-group-emails")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("show-more-emails")).not.toBeInTheDocument();
    expect(screen.getByTestId("show-more-emails-refine")).toBeInTheDocument();
  });

  it("swaps the button for the note once the fetched rows run out", async () => {
    // Both halves in one flow: six fetched with more behind them. The button
    // reveals the sixth, and THEN the honest note takes its place.
    await search(resultsWithEmails(6, true));
    await waitFor(() =>
      expect(screen.getByTestId("linked-group-emails")).toBeInTheDocument(),
    );

    expect(screen.getByTestId("show-more-emails")).toBeInTheDocument();
    expect(screen.queryByTestId("show-more-emails-refine")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("show-more-emails"));

    expect(screen.queryByTestId("show-more-emails")).not.toBeInTheDocument();
    expect(screen.getByTestId("show-more-emails-refine")).toBeInTheDocument();
  });

  it("prints no number in the heading", async () => {
    // The fixture's row count (6), cap (5) and shown count all differ, so a
    // heading that started printing any of them would be caught here.
    await search(resultsWithEmails(6, true));
    await waitFor(() =>
      expect(screen.getByTestId("linked-group-emails")).toBeInTheDocument(),
    );
    const heading = screen.getByText("Emails").parentElement;
    expect(heading?.textContent?.trim()).toBe("Emails");
    expect(heading?.textContent ?? "").not.toMatch(/\d/);
  });

  it("collapses an expanded section again when the query changes", async () => {
    // A section expanded for one search must not stay expanded for the next: the
    // user asked to see more of a DIFFERENT list.
    await search(resultsWithEmails(6, false));
    await waitFor(() =>
      expect(screen.getByTestId("linked-group-emails")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("show-more-emails"));
    expect(screen.getAllByTestId("email-result")).toHaveLength(6);

    mockSearchGlobal.mockResolvedValue({
      success: true,
      results: resultsWithEmails(6, false),
    });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "bramble" } });

    await waitFor(() =>
      expect(screen.getAllByTestId("email-result")).toHaveLength(COLLAPSED_ROWS),
    );
    expect(screen.getByTestId("show-more-emails")).toBeInTheDocument();
  });
});
