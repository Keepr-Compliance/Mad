/**
 * BACKLOG-2294 — the Texts "Sync" / re-sync button must show the SAME active
 * affordance (spinner + "Syncing…", disabled) whenever a BACKGROUND messages
 * sync is in flight, not only when the user clicked it themselves.
 *
 * The button's active state is now driven by
 *   syncActive = syncingMessages || globalSyncRunning || messagesSyncInFlight
 * so a background audit-date-change import, the orchestrator's post-login sync,
 * or the 2293 re-sync expansion all read "working" rather than a dead disabled
 * gray. These tests must FAIL on the old `syncingMessages`-only gate.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TransactionMessagesTab } from "../TransactionMessagesTab";
import type { Communication } from "../../types";

const mockUnlinkMessages = jest.fn();
const mockGetMessageContacts = jest.fn();
const mockGetMessagesByContact = jest.fn();
const mockLinkMessages = jest.fn();
const mockGetNamesByPhones = jest.fn();

beforeAll(() => {
  Object.defineProperty(window, "api", {
    value: {
      transactions: {
        unlinkMessages: mockUnlinkMessages,
        getMessageContacts: mockGetMessageContacts,
        getMessagesByContact: mockGetMessagesByContact,
        linkMessages: mockLinkMessages,
      },
      contacts: {
        getNamesByPhones: mockGetNamesByPhones,
      },
    },
    writable: true,
  });
});

beforeEach(() => {
  jest.clearAllMocks();
  mockUnlinkMessages.mockResolvedValue({ success: true });
  mockGetMessageContacts.mockResolvedValue({ success: true, contacts: [] });
  mockGetMessagesByContact.mockResolvedValue({ success: true, messages: [] });
  mockLinkMessages.mockResolvedValue({ success: true });
  mockGetNamesByPhones.mockResolvedValue({ success: true, names: {} });
});

const threadMessages: Partial<Communication>[] = [
  {
    id: "msg-1",
    user_id: "user-456",
    channel: "sms",
    body_text: "Got your message about the property!",
    sent_at: "2024-01-16T11:00:00Z",
    direction: "inbound",
    thread_id: "thread-1",
    participants: JSON.stringify({ from: "+14155550100", to: ["+14155550101"] }),
    has_attachments: false,
    is_false_positive: false,
  },
];

/** Read the sync button and whether it currently shows a spinner. */
function readSyncButton(): { button: HTMLElement; spinning: boolean } {
  const button = screen.getByTestId("sync-messages-button");
  return { button, spinning: button.querySelector(".animate-spin") !== null };
}

describe("TransactionMessagesTab — background-sync affordance (BACKLOG-2294)", () => {
  describe("header sync button (messages present)", () => {
    it("shows the active spinner + 'Syncing…' + disabled when a BACKGROUND messages sync is in flight (no user click)", () => {
      render(
        <TransactionMessagesTab
          messages={threadMessages as Communication[]}
          loading={false}
          error={null}
          hasContacts
          onSyncMessages={jest.fn()}
          syncingMessages={false}
          messagesSyncInFlight
        />
      );

      const { button, spinning } = readSyncButton();
      expect(button).toBeDisabled();
      expect(button).toHaveTextContent("Syncing");
      expect(spinning).toBe(true);
    });

    it("shows the active affordance when the orchestrator's global sync is running (no user click)", () => {
      render(
        <TransactionMessagesTab
          messages={threadMessages as Communication[]}
          loading={false}
          error={null}
          hasContacts
          onSyncMessages={jest.fn()}
          syncingMessages={false}
          globalSyncRunning
        />
      );

      const { button, spinning } = readSyncButton();
      expect(button).toBeDisabled();
      expect(button).toHaveTextContent("Syncing");
      expect(spinning).toBe(true);
    });

    it("still shows the active affordance for a user-initiated sync (no regression)", () => {
      render(
        <TransactionMessagesTab
          messages={threadMessages as Communication[]}
          loading={false}
          error={null}
          hasContacts
          onSyncMessages={jest.fn()}
          syncingMessages
        />
      );

      const { button, spinning } = readSyncButton();
      expect(button).toBeDisabled();
      expect(button).toHaveTextContent("Syncing");
      expect(spinning).toBe(true);
    });

    it("is idle and enabled when nothing is syncing", () => {
      render(
        <TransactionMessagesTab
          messages={threadMessages as Communication[]}
          loading={false}
          error={null}
          hasContacts
          onSyncMessages={jest.fn()}
          syncingMessages={false}
          globalSyncRunning={false}
          messagesSyncInFlight={false}
        />
      );

      const { button, spinning } = readSyncButton();
      expect(button).not.toBeDisabled();
      expect(button).toHaveTextContent("Sync Messages");
      expect(button).not.toHaveTextContent("Syncing");
      expect(spinning).toBe(false);
    });
  });

  describe("empty-state sync button (no messages linked yet)", () => {
    it("shows the active spinner + 'Syncing…' + disabled when a BACKGROUND messages sync is in flight", () => {
      render(
        <TransactionMessagesTab
          messages={[]}
          loading={false}
          error={null}
          hasContacts
          onSyncMessages={jest.fn()}
          syncingMessages={false}
          messagesSyncInFlight
        />
      );

      const { button, spinning } = readSyncButton();
      expect(button).toBeDisabled();
      expect(button).toHaveTextContent("Syncing");
      expect(spinning).toBe(true);
    });

    it("is idle and enabled when nothing is syncing", () => {
      render(
        <TransactionMessagesTab
          messages={[]}
          loading={false}
          error={null}
          hasContacts
          onSyncMessages={jest.fn()}
          messagesSyncInFlight={false}
        />
      );

      const { button, spinning } = readSyncButton();
      expect(button).not.toBeDisabled();
      expect(button).not.toHaveTextContent("Syncing");
      expect(spinning).toBe(false);
    });
  });
});
