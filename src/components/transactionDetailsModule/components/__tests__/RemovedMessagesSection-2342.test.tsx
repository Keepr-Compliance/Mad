/**
 * RemovedMessagesSection — BACKLOG-2342 (removed section re-splits a 1:1)
 *
 * Support ticket #85 re-report: a 1:1 text conversation that groups into ONE
 * card in the attached list (TransactionMessagesTab) re-split into multiple
 * cards in the "Show removed" section, and restore was inconsistent.
 *
 * Root cause: the removed section resolved its OWN removed-thread handles via
 * `contacts.resolveHandles(handles)` WITHOUT the signed-in userId. resolveHandles
 * gates its external-contacts source (iPhone/macOS-sync/Outlook/Google) on
 * userId, so an externally-synced contact — and, crucially, that contact's
 * iCloud-email iMessage handle — never resolved to a name. The phone variants
 * still collapsed via last-10-digit normalization, but the email variant kept a
 * `handle:<email>` key and stranded as its own card. The attached list passes
 * userId (TransactionMessagesTab.tsx) and therefore grouped correctly.
 *
 * Fix: thread the signed-in userId into RemovedMessagesSection and pass it to
 * resolveHandles, so this section resolves with the SAME source set as the
 * attached list. These tests exercise the real async round-trip (the section
 * resolves handles, bubbles them up, the parent feeds them back as contactNames)
 * rather than pre-seeding contactNames.
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { RemovedMessagesSection } from "../RemovedMessagesSection";

interface RowOverrides {
  ignored_id: string;
  message_id: string;
  thread_id: string;
  from: string;
  chat_members?: string[];
}

function makeRow(o: RowOverrides) {
  return {
    ignored_id: o.ignored_id,
    ic_thread_id: null,
    reason: "Manually unlinked by user",
    ignored_at: "2024-02-01T10:00:00Z",
    message_id: o.message_id,
    body: "Message body content",
    subject: null,
    channel: o.from.includes("@") ? "imessage" : "sms",
    thread_id: o.thread_id,
    sent_at: "2024-01-15T10:00:00Z",
    received_at: null,
    participants: JSON.stringify({
      from: o.from,
      to: ["me"],
      chat_members: o.chat_members ?? [o.from],
    }),
    participants_flat: null,
    direction: "inbound",
  };
}

const transactionId = "txn-2342";
const USER_ID = "user-2342";

// Romina's 1:1 fans out into four raw macOS threads: +1 SMS, +1 iMessage,
// bare-phone SMS, and an iCloud-email iMessage.
const FOUR_THREAD_ROWS = [
  makeRow({ ignored_id: "ig-1", message_id: "m-1", thread_id: "t-sms-plus1", from: "+14155550100" }),
  makeRow({ ignored_id: "ig-2", message_id: "m-2", thread_id: "t-imsg-plus1", from: "+14155550100" }),
  makeRow({ ignored_id: "ig-3", message_id: "m-3", thread_id: "t-sms-bare", from: "4155550100" }),
  makeRow({ ignored_id: "ig-4", message_id: "m-4", thread_id: "t-imsg-email", from: "romina@icloud.com" }),
];

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window.api.transactions as any).getRemovedMessages = jest.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window.api.transactions as any).restoreRemovedMessage = jest.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window.api.contacts as any).resolveHandles = jest.fn();
  jest.spyOn(window, "scrollTo").mockImplementation(() => {});
});

beforeEach(() => {
  jest.clearAllMocks();
  (window.api.transactions.getRemovedMessages as jest.Mock).mockResolvedValue({
    success: true,
    removedMessages: FOUR_THREAD_ROWS,
  });
});

/**
 * Simulates resolveHandles' userId gating: the phone/email → Romina mapping
 * lives ONLY in the external-contacts source, which is consulted solely when a
 * userId is supplied. Without a userId it returns nothing (imported/AddressBook
 * sources have no record of this externally-synced contact).
 */
function mockResolveHandlesExternalOnly(): void {
  (window.api.contacts.resolveHandles as jest.Mock).mockImplementation(
    async (handles: string[], userId?: string) => {
      if (!userId) return { success: true, names: {} };
      const names: Record<string, string> = {};
      for (const h of handles) {
        const digits = h.replace(/\D/g, "");
        if (digits.endsWith("4155550100")) names[h] = "Romina";
        if (h.toLowerCase() === "romina@icloud.com") names[h] = "Romina";
      }
      return { success: true, names };
    }
  );
}

/**
 * Mirrors TransactionMessagesTab's contactNames round-trip: the section resolves
 * removed-thread handles, bubbles them up via onContactNamesResolved, and the
 * parent feeds them back as the contactNames prop that drives grouping.
 */
function Harness({ userId }: { userId?: string }): React.ReactElement {
  const [names, setNames] = React.useState<Record<string, string>>({});
  return (
    <RemovedMessagesSection
      transactionId={transactionId}
      userId={userId}
      contactNames={names}
      onContactNamesResolved={(resolved) =>
        setNames((prev) => ({ ...prev, ...resolved }))
      }
      onShowSuccess={jest.fn()}
      onShowError={jest.fn()}
      isOpen={true}
      onOpenChange={jest.fn()}
    />
  );
}

describe("RemovedMessagesSection — BACKLOG-2342 userId-consistent resolution", () => {
  it("passes the signed-in userId to resolveHandles (same source set as the attached list)", async () => {
    mockResolveHandlesExternalOnly();

    render(<Harness userId={USER_ID} />);

    await waitFor(() => {
      expect(window.api.contacts.resolveHandles as jest.Mock).toHaveBeenCalled();
    });

    // Every call carries the userId as the second argument — never undefined.
    for (const call of (window.api.contacts.resolveHandles as jest.Mock).mock.calls) {
      expect(call[1]).toBe(USER_ID);
    }
  });

  it("collapses the four removed threads into ONE card once userId enables external-contact resolution", async () => {
    mockResolveHandlesExternalOnly();

    render(<Harness userId={USER_ID} />);

    // Resolution is async; the card list starts fragmented and collapses to one
    // as the external-contact names arrive and grouping re-runs.
    await waitFor(() => {
      expect(screen.getAllByTestId("removed-thread-card")).toHaveLength(1);
    });
    expect(screen.getByTestId("show-removed-messages-toggle")).toHaveTextContent(
      "Show removed (1)"
    );
  });

  it("REGRESSION: without a userId the iCloud-email thread strands as its own card", async () => {
    mockResolveHandlesExternalOnly();

    render(<Harness userId={undefined} />);

    await waitFor(() => {
      expect(screen.getAllByTestId("removed-thread-card").length).toBeGreaterThan(0);
    });

    // The three phone threads still merge via last-10 normalization, but with no
    // name for the email handle it keeps a `handle:<email>` key and stays split:
    // two cards, reproducing the reported "re-splits in Removed" bug the fix cures.
    expect(screen.getAllByTestId("removed-thread-card")).toHaveLength(2);
    expect(window.api.contacts.resolveHandles as jest.Mock).toHaveBeenCalledWith(
      expect.any(Array),
      undefined
    );
  });
});
