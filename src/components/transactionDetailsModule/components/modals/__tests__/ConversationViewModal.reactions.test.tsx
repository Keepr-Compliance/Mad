/**
 * BACKLOG-2280 — ConversationViewModal reaction pills.
 *
 * Reactions ride in the `messages` prop (getCommunicationsWithMessages returns
 * them). The modal must: partition them out of the bubble list (so the header
 * count is honest and no empty bubble renders), attach a grouped pill under the
 * PARENT bubble, collapse add→remove to nothing, and render nothing for an
 * orphan reaction whose parent is not present.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { ConversationViewModal } from "../ConversationViewModal";
import type { MessageLike } from "../../MessageThreadCard";

const mockGetMessageAttachmentsBatch = jest.fn();

beforeAll(() => {
  Object.defineProperty(window, "api", {
    value: { messages: { getMessageAttachmentsBatch: mockGetMessageAttachmentsBatch } },
    writable: true,
  });
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetMessageAttachmentsBatch.mockResolvedValue({});
});

const PARENT: MessageLike = {
  id: "P1",
  user_id: "u1",
  channel: "imessage",
  external_id: "GUID-P1",
  body_text: "Dinner at 7?",
  sent_at: "2026-01-01T10:00:00Z",
  direction: "inbound",
  has_attachments: false,
  participants: JSON.stringify({ from: "+14155550100", to: ["me"] }),
} as MessageLike;

function reaction(over: Partial<MessageLike>): MessageLike {
  return {
    id: "R?",
    user_id: "u1",
    channel: "imessage",
    body_text: "",
    direction: "outbound",
    has_attachments: false,
    sent_at: "2026-01-01T10:01:00Z",
    participants: JSON.stringify({ from: "me", to: ["+14155550100"] }),
    associated_message_type: 2000,
    associated_message_guid: "GUID-P1",
    ...over,
  } as MessageLike;
}

const baseProps = {
  contactName: "John Doe",
  phoneNumber: "+14155550100",
  contactNames: {},
  onClose: jest.fn(),
};

describe("ConversationViewModal reaction pills (BACKLOG-2280)", () => {
  it("renders a grouped pill under the parent and excludes reactions from the header count", () => {
    render(
      <ConversationViewModal
        {...baseProps}
        messages={[PARENT, reaction({ id: "R1" })]}
      />,
    );
    // The reaction is not counted as a message.
    expect(screen.getByText("1 message")).toBeInTheDocument();
    // A heart pill is attached.
    expect(screen.getByTestId("reaction-pill-heart")).toBeInTheDocument();
    expect(screen.getByTestId("reaction-pill-heart")).toHaveTextContent("❤️");
    // The parent bubble still renders (no empty reaction bubble replaced it).
    expect(screen.getByText("Dinner at 7?")).toBeInTheDocument();
  });

  it("collapses an add followed by a later removal to no pill", () => {
    render(
      <ConversationViewModal
        {...baseProps}
        messages={[
          PARENT,
          reaction({ id: "R1", associated_message_type: 2000, sent_at: "2026-01-01T10:01:00Z" }),
          reaction({ id: "R2", associated_message_type: 3000, sent_at: "2026-01-01T10:02:00Z" }),
        ]}
      />,
    );
    expect(screen.queryByTestId("reaction-pills")).not.toBeInTheDocument();
    expect(screen.getByText("1 message")).toBeInTheDocument();
  });

  it("renders nothing for an orphan reaction whose parent is absent", () => {
    render(
      <ConversationViewModal
        {...baseProps}
        messages={[PARENT, reaction({ id: "R1", associated_message_guid: "GUID-MISSING" })]}
      />,
    );
    // Orphan is neither a bubble nor a pill.
    expect(screen.queryByTestId("reaction-pills")).not.toBeInTheDocument();
    expect(screen.getByText("1 message")).toBeInTheDocument();
    expect(screen.getByText("Dinner at 7?")).toBeInTheDocument();
  });

  it("shows a count when multiple actors react with the same kind", () => {
    render(
      <ConversationViewModal
        {...baseProps}
        messages={[
          PARENT,
          reaction({ id: "R1", direction: "outbound" }), // me
          reaction({
            id: "R2",
            direction: "inbound",
            participants: JSON.stringify({ from: "+14155550100", to: ["me"] }),
          }), // the contact
        ]}
      />,
    );
    const pill = screen.getByTestId("reaction-pill-heart");
    expect(pill).toHaveTextContent("2");
  });
});
