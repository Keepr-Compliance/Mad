/**
 * RTL Tests — BACKLOG-1793 (behaviour 2: active-card remove icon)
 *
 * The Texts tab's ACTIVE conversation cards must use the TRASH icon for remove
 * (matching EmailThreadCard), NOT the old "do-not-enter" (circle-slash) sign.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TransactionMessagesTab } from "../TransactionMessagesTab";
import type { Communication } from "../../types";

// Signature fragments of the two SVG paths involved.
const TRASH_ICON_PREFIX = "M19 7l-.867 12.142"; // heroicons "trash" (EmailThreadCard)
const DO_NOT_ENTER_PREFIX = "M18.364 18.364A9 9 0"; // heroicons "ban" (old messages icon)

const activeMessages: Partial<Communication>[] = [
  {
    id: "msg-1",
    user_id: "user-1",
    channel: "sms",
    body_text: "Active conversation message",
    sent_at: "2024-01-16T11:00:00Z",
    direction: "inbound",
    thread_id: "thread-1",
    participants: JSON.stringify({ from: "+14155550100", to: ["+14155550101"] }),
    has_attachments: false,
    is_false_positive: false,
  },
];

describe("TransactionMessagesTab — BACKLOG-1793 active-card remove icon", () => {
  it("renders the trash icon (not the do-not-enter sign) on the active card's remove button", () => {
    render(
      <TransactionMessagesTab
        messages={activeMessages as Communication[]}
        loading={false}
        error={null}
        userId="user-1"
        transactionId="txn-123"
      />
    );

    const removeButton = screen.getByTestId("unlink-thread-button");
    const path = removeButton.querySelector("path");
    const d = path?.getAttribute("d") ?? "";

    // Trash icon present, do-not-enter icon gone
    expect(d.startsWith(TRASH_ICON_PREFIX)).toBe(true);
    expect(d.startsWith(DO_NOT_ENTER_PREFIX)).toBe(false);
  });
});
