/**
 * BACKLOG-3620 — reactions imported from Messages for Web keep their own emoji.
 *
 * A reaction that is not one of Apple's six tapbacks is stored as kind 2006
 * ("other") with the emoji itself in body_text. Each distinct emoji renders as
 * its own pill (founder ruling); a macOS custom tapback, whose body is a
 * sentence, keeps the generic glyph. This also pins the glyphs, which no test
 * pinned before (checkpoint measurement: replacing the "other" glyph left every
 * reaction suite green).
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

// Shapes as rcsImportStore writes them (mapChatToRows / mapChatToReactionRows).
const PARENT: MessageLike = {
  id: "P1",
  user_id: "u1",
  channel: "sms",
  external_id: "gmweb:ccccccccccccccccccc:201",
  body_text: "look at this",
  sent_at: "2026-09-21T10:00:00Z",
  direction: "inbound",
  has_attachments: false,
  participants: JSON.stringify({ from: "Test Contact C", to: ["me"] }),
} as MessageLike;

function reaction(id: string, emoji: string, type: number, from: string): MessageLike {
  const mine = from === "me";
  return {
    id,
    user_id: "u1",
    channel: "sms",
    external_id: `gmweb:ccccccccccccccccccc:201:r:${from}:${emoji}`,
    body_text: emoji,
    direction: mine ? "outbound" : "inbound",
    has_attachments: false,
    sent_at: "2026-09-21T10:00:00Z",
    participants: JSON.stringify({ from, to: mine ? ["Test Contact C"] : ["me"] }),
    associated_message_type: type,
    associated_message_guid: "gmweb:ccccccccccccccccccc:201",
  } as MessageLike;
}

const baseProps = {
  contactName: "Test Contact C",
  phoneNumber: "",
  contactNames: {},
  onClose: jest.fn(),
};

describe("ConversationViewModal own-emoji reaction pills (BACKLOG-3620)", () => {
  it("renders 😡 and 😢 as two separate pills showing those emojis, not one merged star", () => {
    render(
      <ConversationViewModal
        {...baseProps}
        messages={[
          PARENT,
          reaction("R1", "😡", 2006, "Test Contact C"),
          reaction("R2", "😢", 2006, "me"),
        ]}
      />,
    );
    const angry = screen.getByTestId("reaction-pill-other:😡");
    const sad = screen.getByTestId("reaction-pill-other:😢");
    expect(angry).toHaveTextContent("😡");
    expect(sad).toHaveTextContent("😢");
    expect(angry).not.toHaveTextContent("2");
    expect(screen.queryByTestId("reaction-pill-other")).toBeNull();
    expect(screen.queryByText("⭐")).toBeNull();
  });

  it("two people with the same emoji share one pill with a count", () => {
    render(
      <ConversationViewModal
        {...baseProps}
        messages={[
          PARENT,
          reaction("R1", "😡", 2006, "Test Contact C"),
          reaction("R2", "😡", 2006, "me"),
        ]}
      />,
    );
    expect(screen.getByTestId("reaction-pill-other:😡")).toHaveTextContent("😡2");
  });

  it("the six standard kinds keep their existing rendering", () => {
    render(<ConversationViewModal {...baseProps} messages={[PARENT, reaction("R1", "\u2764", 2000, "me")]} />);
    expect(screen.getByTestId("reaction-pill-heart")).toHaveTextContent("\u2764\uFE0F");
  });

  it("a macOS custom tapback whose body is a sentence keeps the generic star", () => {
    const mac = {
      ...reaction("R1", "x", 2006, "me"),
      channel: "imessage",
      body_text: "Reacted 😡 to \u201clook at this\u201d",
    } as MessageLike;
    render(<ConversationViewModal {...baseProps} messages={[PARENT, mac]} />);
    expect(screen.getByTestId("reaction-pill-other")).toHaveTextContent("⭐");
  });
});
