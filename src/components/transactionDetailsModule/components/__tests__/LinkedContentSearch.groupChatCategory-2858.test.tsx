/**
 * BACKLOG-2858 — the Group chats SECTION: when it appears, and when it must not.
 *
 * `LinkedContentSearch.groupNameRow-2816.test.tsx` covers what a group-chat ROW
 * renders. This file covers the section around it, and the two ways a split
 * bucket can go wrong that a row-level test cannot see:
 *
 *   1. **An empty Group chats section rendering a heading.** With one bucket the
 *      texts section always had rows when it had a total. Two buckets means
 *      either can be empty, and a heading over nothing is a control that opens an
 *      empty screen — the founder's standing ruling at BACKLOG-2791.
 *
 *   2. **The whole panel disappearing on the founder's own case.** Searching a
 *      group chat's NAME now leaves `texts.total` at 0, because that count went
 *      to the Group chats badge along with the rows. A `hasAnyMatch` that still
 *      sums only the old five groups renders "No matches" over a result that
 *      exists — the exact search he filed this for, answered with nothing.
 *
 * Both scopes are exercised: the hook normalizes the scoped and global IPC
 * responses down two DIFFERENT code paths, and the scoped one has to map
 * `groupChats` itself.
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
const BODY_TEXT = "the lockbox code is on the counter";
const emptyGroup = { items: [], hasMore: false };

const groupRow = {
  id: "m-newest",
  sender: null,
  snippet: null,
  sentAt: "2026-06-25T00:00:00.000Z",
  attribution: null,
  threadDisplayName: GROUP_NAME,
  memberNames: ["Dana Whitfield"],
};

const messageRow = {
  id: "m-body",
  sender: "+14155550190",
  snippet: BODY_TEXT,
  sentAt: "2026-05-01T00:00:00.000Z",
  attribution: null,
};

function globalResults(groupChats: unknown[], texts: unknown[]) {
  return {
    transactions: emptyGroup,
    contacts: emptyGroup,
    emails: emptyGroup,
    texts: { items: texts, hasMore: false },
    groupChats: { items: groupChats, hasMore: false },
    unattached: emptyGroup,
  };
}

/** The scoped IPC response has no `transactions`/`unattached` at all. */
function scopedResults(groupChats: unknown[], texts: unknown[]) {
  return {
    contacts: emptyGroup,
    emails: emptyGroup,
    texts: { items: texts, hasMore: false },
    groupChats: { items: groupChats, hasMore: false },
  };
}

async function search(
  scope: "global" | "transaction",
  groupChats: unknown[],
  texts: unknown[],
): Promise<void> {
  if (scope === "global") {
    mockSearchGlobal.mockResolvedValue({
      success: true,
      results: globalResults(groupChats, texts),
    });
  } else {
    mockSearchLinked.mockResolvedValue({
      success: true,
      results: scopedResults(groupChats, texts),
    });
  }
  render(
    <LinkedContentSearch
      scope={scope === "global" ? { type: "global", userId: "u-1" } : { type: "transaction", id: "t-1" }}
      onNavigateContact={jest.fn()}
      onNavigateEmail={jest.fn()}
      onNavigateText={jest.fn()}
      onNavigateTransaction={jest.fn()}
    />,
  );
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "kingfisher" } });
  // Wait for the panel itself, not for a row — some of these cases legitimately
  // render no rows at all, and waiting on a row would hide the failure.
  await waitFor(() =>
    expect(screen.getByTestId("linked-search-panel")).toBeInTheDocument(),
  );
}

describe("BACKLOG-2858 — the Group chats section", () => {
  beforeEach(() => jest.clearAllMocks());

  describe("a name-only hit — the founder's own search", () => {
    it("renders the panel and the Group chats section (global scope)", async () => {
      await search("global", [groupRow], []);
      await waitFor(() =>
        expect(screen.getByTestId("linked-group-groupchats")).toBeInTheDocument(),
      );
      expect(screen.getByTestId("linked-group-groupchats")).toHaveTextContent("Group chats");
      expect(screen.getByTestId("group-chat-result")).toHaveTextContent(/Lane Closing/);
    });

    it("does NOT fall through to “No matches” when Texts is the empty one", async () => {
      // The regression this guards: `texts.total` is 0 on this case now, so a
      // `hasAnyMatch` that forgot `groupChats` would answer the founder's own
      // query with "No matches for kingfisher".
      await search("global", [groupRow], []);
      await waitFor(() =>
        expect(screen.getByTestId("linked-group-groupchats")).toBeInTheDocument(),
      );
      expect(screen.queryByTestId("linked-search-empty")).not.toBeInTheDocument();
      expect(screen.getByTestId("linked-search-results")).toBeInTheDocument();
    });

    it("renders NO Texts heading beside it", async () => {
      await search("global", [groupRow], []);
      await waitFor(() =>
        expect(screen.getByTestId("linked-group-groupchats")).toBeInTheDocument(),
      );
      // The symmetric half of the empty-state rule.
      expect(screen.queryByTestId("linked-group-texts")).not.toBeInTheDocument();
    });

    it("works the same in TRANSACTION scope, which normalizes separately", async () => {
      await search("transaction", [groupRow], []);
      await waitFor(() =>
        expect(screen.getByTestId("linked-group-groupchats")).toBeInTheDocument(),
      );
      expect(screen.getByTestId("group-chat-result")).toHaveTextContent(/Lane Closing/);
      expect(screen.queryByTestId("linked-search-empty")).not.toBeInTheDocument();
      // Scoped rows carry no attribution badge, like every other scoped group.
      expect(screen.queryByTestId("attribution-badge")).not.toBeInTheDocument();
      expect(screen.queryByTestId("attribution-none")).not.toBeInTheDocument();
    });
  });

  describe("an empty Group chats bucket", () => {
    it("renders NO heading when only Texts matched", async () => {
      await search("global", [], [messageRow]);
      await waitFor(() =>
        expect(screen.getByTestId("linked-group-texts")).toBeInTheDocument(),
      );
      expect(screen.queryByTestId("linked-group-groupchats")).not.toBeInTheDocument();
      // Asserted as an absence of the LABEL too, so a heading rendered without
      // the test id cannot slip through.
      expect(screen.queryByText("Group chats")).not.toBeInTheDocument();
    });

    it("renders no heading and no rows when nothing matched at all", async () => {
      await search("global", [], []);
      await waitFor(() =>
        expect(screen.getByTestId("linked-search-empty")).toBeInTheDocument(),
      );
      expect(screen.queryByTestId("linked-group-groupchats")).not.toBeInTheDocument();
      expect(screen.queryByTestId("linked-group-texts")).not.toBeInTheDocument();
      expect(screen.queryByTestId("group-chat-result")).not.toBeInTheDocument();
    });
  });

  it("shows both sections when a query genuinely hits both", async () => {
    await search("global", [groupRow], [messageRow]);
    await waitFor(() =>
      expect(screen.getByTestId("linked-group-groupchats")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("linked-group-texts")).toBeInTheDocument();
    // Group chats leads, keeping the precedence thread rows had inside the old
    // combined list: a named conversation is the more specific answer.
    const sections = screen.getAllByTestId(/^linked-group-/).map((el) => el.dataset.testid);
    expect(sections.indexOf("linked-group-groupchats")).toBeLessThan(
      sections.indexOf("linked-group-texts"),
    );
    // And the group name is not duplicated into the Texts section.
    expect(screen.getByTestId("text-result").textContent ?? "").not.toContain(GROUP_NAME);
  });
});
