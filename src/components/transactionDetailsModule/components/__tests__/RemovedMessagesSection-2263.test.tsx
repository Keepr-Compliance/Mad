/**
 * RemovedMessagesSection — BACKLOG-2263 (thread-grouping consistency)
 *
 * The removed ("Show removed") section previously rendered ONE card per
 * `ignored_communications` row. Unlinking a 1:1 conversation writes one row per
 * raw macOS thread (SMS/iMessage, +1/bare phone, phone/email handles), so a
 * single contact could fan out into several cards.
 *
 * These tests assert the fix: removed rows are contact-merged the SAME way the
 * attached list groups them, and restoring the merged card clears EVERY
 * constituent suppression row (exact ignored_id + message_id identity).
 */
import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window.api.transactions as any).getRemovedMessages = jest.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window.api.transactions as any).restoreRemovedMessage = jest.fn();
  jest.spyOn(window, "scrollTo").mockImplementation(() => {});
});

beforeEach(() => {
  jest.clearAllMocks();
});

const transactionId = "txn-2263";

// One contact whose conversation spans four raw threads: +1 SMS, +1 iMessage,
// bare-phone SMS, and an iCloud-email iMessage.
const FOUR_THREAD_ROWS = [
  makeRow({ ignored_id: "ig-1", message_id: "m-1", thread_id: "t-sms-plus1", from: "+14155550100" }),
  makeRow({ ignored_id: "ig-2", message_id: "m-2", thread_id: "t-imsg-plus1", from: "+14155550100" }),
  makeRow({ ignored_id: "ig-3", message_id: "m-3", thread_id: "t-sms-bare", from: "4155550100" }),
  makeRow({ ignored_id: "ig-4", message_id: "m-4", thread_id: "t-imsg-email", from: "romina@icloud.com" }),
];

// The contact record links the +1 phone and the iCloud email to one person; the
// bare phone resolves through normalized-phone equality.
const ROMINA_NAMES = {
  "+14155550100": "Romina",
  "romina@icloud.com": "Romina",
};

describe("RemovedMessagesSection — BACKLOG-2263 contact-merged cards", () => {
  it("collapses a contact's four removed threads into ONE card", async () => {
    (window.api.transactions.getRemovedMessages as jest.Mock).mockResolvedValue({
      success: true,
      removedMessages: FOUR_THREAD_ROWS,
    });

    render(
      <RemovedMessagesSection
        transactionId={transactionId}
        contactNames={ROMINA_NAMES}
        onShowSuccess={jest.fn()}
        onShowError={jest.fn()}
        isOpen={true}
        onOpenChange={jest.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("removed-thread-card")).toBeInTheDocument();
    });

    // Exactly one merged card, and the count label reflects one conversation.
    expect(screen.getAllByTestId("removed-thread-card")).toHaveLength(1);
    expect(screen.getByTestId("show-removed-messages-toggle")).toHaveTextContent(
      "Show removed (1)"
    );
  });

  it("restoring the merged card restores ALL four ignored rows (exact id sets)", async () => {
    (window.api.transactions.getRemovedMessages as jest.Mock).mockResolvedValue({
      success: true,
      removedMessages: FOUR_THREAD_ROWS,
    });
    const restoreMock = window.api.transactions.restoreRemovedMessage as jest.Mock;
    restoreMock.mockResolvedValue({ success: true });

    render(
      <RemovedMessagesSection
        transactionId={transactionId}
        contactNames={ROMINA_NAMES}
        onRestoreComplete={jest.fn().mockResolvedValue(undefined)}
        onShowSuccess={jest.fn()}
        onShowError={jest.fn()}
        isOpen={true}
        onOpenChange={jest.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("removed-thread-card")).toBeInTheDocument();
    });

    await act(async () => {
      await userEvent.click(screen.getByTestId("restore-removed-message"));
    });

    await waitFor(() => {
      expect(restoreMock).toHaveBeenCalledTimes(4);
    });

    // Exact-identity assertions: every constituent ignored_id + message_id hit
    // the IPC (one call each, txn id passed through).
    const ignoredIdsHit = restoreMock.mock.calls.map((c) => c[0]).sort();
    const messageIdsHit = restoreMock.mock.calls.flatMap((c) => c[1]).sort();
    const txnIdsHit = new Set(restoreMock.mock.calls.map((c) => c[2]));

    expect(ignoredIdsHit).toEqual(["ig-1", "ig-2", "ig-3", "ig-4"]);
    expect(messageIdsHit).toEqual(["m-1", "m-2", "m-3", "m-4"]);
    expect(txnIdsHit).toEqual(new Set([transactionId]));

    // The merged card is removed from the list after restore.
    await waitFor(() => {
      expect(screen.queryByTestId("removed-thread-card")).not.toBeInTheDocument();
    });
  });

  // SR #3: partial-failure correctness. If any constituent restore fails, the
  // whole card must fail (stay visible for retry) — never silently drop rows
  // while leaving a failed suppression record behind.
  it("fails the whole merged card and keeps it visible when one constituent restore fails", async () => {
    (window.api.transactions.getRemovedMessages as jest.Mock).mockResolvedValue({
      success: true,
      // Three threads, ONE contact → one merged card with three ignored_ids.
      removedMessages: [
        makeRow({ ignored_id: "ig-1", message_id: "m-1", thread_id: "t-1", from: "+14155550100" }),
        makeRow({ ignored_id: "ig-2", message_id: "m-2", thread_id: "t-2", from: "+14155550100" }),
        makeRow({ ignored_id: "ig-3", message_id: "m-3", thread_id: "t-3", from: "+14155550100" }),
      ],
    });
    const restoreMock = window.api.transactions.restoreRemovedMessage as jest.Mock;
    // The 2nd constituent restore rejects; the 1st and 3rd succeed.
    restoreMock
      .mockResolvedValueOnce({ success: true })
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ success: true });

    const onShowError = jest.fn();
    const onShowSuccess = jest.fn();
    const onRestoreComplete = jest.fn().mockResolvedValue(undefined);

    render(
      <RemovedMessagesSection
        transactionId={transactionId}
        onRestoreComplete={onRestoreComplete}
        onShowSuccess={onShowSuccess}
        onShowError={onShowError}
        isOpen={true}
        onOpenChange={jest.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("removed-thread-card")).toBeInTheDocument();
    });
    expect(screen.getAllByTestId("removed-thread-card")).toHaveLength(1);

    await act(async () => {
      await userEvent.click(screen.getByTestId("restore-removed-message"));
    });

    // Every constituent was attempted...
    await waitFor(() => {
      expect(restoreMock).toHaveBeenCalledTimes(3);
    });
    // ...but the one failure fails the whole card: error shown, NO silent refresh,
    // NO success toast, and the card stays visible so the user can retry.
    await waitFor(() => {
      expect(onShowError).toHaveBeenCalled();
    });
    expect(onRestoreComplete).not.toHaveBeenCalled();
    expect(onShowSuccess).not.toHaveBeenCalled();
    expect(screen.getByTestId("removed-thread-card")).toBeInTheDocument();
  });

  it("keeps a real group chat as its own separate card", async () => {
    (window.api.transactions.getRemovedMessages as jest.Mock).mockResolvedValue({
      success: true,
      removedMessages: [
        // Romina's two 1:1 threads → merge into one card.
        makeRow({ ignored_id: "ig-1", message_id: "m-1", thread_id: "t-a", from: "+14155550100" }),
        makeRow({ ignored_id: "ig-2", message_id: "m-2", thread_id: "t-b", from: "4155550100" }),
        // A genuine group chat with two DISTINCT people → stays separate.
        makeRow({
          ignored_id: "ig-grp",
          message_id: "m-grp",
          thread_id: "t-grp",
          from: "+14155550100",
          chat_members: ["+14155550100", "+14155550200"],
        }),
      ],
    });

    render(
      <RemovedMessagesSection
        transactionId={transactionId}
        contactNames={{ ...ROMINA_NAMES, "+14155550200": "Alex Broker" }}
        onShowSuccess={jest.fn()}
        onShowError={jest.fn()}
        isOpen={true}
        onOpenChange={jest.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getAllByTestId("removed-thread-card").length).toBeGreaterThan(0);
    });

    // Two cards total: one merged 1:1 (Romina) + one group chat.
    expect(screen.getAllByTestId("removed-thread-card")).toHaveLength(2);
    expect(screen.getByTestId("show-removed-messages-toggle")).toHaveTextContent(
      "Show removed (2)"
    );
  });
});
