/**
 * BACKLOG-2814 — a group text thread shows the group's own name.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE PINS
 * ---------------------------------------------------------------------------
 * The founder's ask was "on group chats use the chat name". The card's group
 * branch used to render a hardcoded literal, "Group Chat", above the participant
 * list. It now renders the conversation's own name when Apple has one.
 *
 * THE RULE IS GATED ON GROUP-NESS, NOT ON THE NAME'S PRESENCE, and those two
 * rules are only distinguishable by one fixture: a NAMED 1:1. Apple lets a
 * one-to-one conversation carry a `display_name` — there are 10 of them in the
 * founder's own chat.db — so a card that showed "the name when there is one"
 * would replace a person's name with a label on those threads. The named-1:1
 * test below is the one that separates the two rules; an unnamed 1:1 would let
 * the wrong rule pass.
 *
 * The name arrives on the message rows (`thread_display_name`), joined in by the
 * loaders from `message_thread_names`. The card stays a pure function of its
 * props — it fetches nothing — which is also why every surface that mounts it
 * gets this behaviour without its own wiring.
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MessageThreadCard, getThreadDisplayName } from "../MessageThreadCard";
import type { Communication } from "../../types";

/** Synthetic. Nothing here is transcribed from a real conversation. */
const GROUP_NAME = "Closing Team";

/**
 * A GROUP message: `chat_members` with more than one entry is what the card's
 * `isGroupChat` derives group-ness from, exactly as the importer writes it.
 */
const groupMessage = (overrides: Partial<Communication> = {}): Communication =>
  ({
    id: "msg-1",
    user_id: "user-123",
    channel: "sms",
    direction: "inbound",
    body_text: "Group message content",
    sent_at: "2024-01-16T14:30:00Z",
    has_attachments: false,
    is_false_positive: false,
    thread_id: "macos-chat-1",
    participants: JSON.stringify({
      from: "+14155550100",
      to: ["+14155550101", "+14155550102"],
      chat_members: ["+14155550100", "+14155550101", "+14155550102"],
    }),
    ...overrides,
  }) as Communication;

/** A 1:1 message: a single counterpart, so `isGroupChat` is false. */
const oneToOneMessage = (overrides: Partial<Communication> = {}): Communication =>
  ({
    id: "msg-1",
    user_id: "user-123",
    channel: "sms",
    direction: "inbound",
    body_text: "Direct message content",
    sent_at: "2024-01-16T14:30:00Z",
    has_attachments: false,
    is_false_positive: false,
    thread_id: "macos-chat-4",
    participants: JSON.stringify({
      from: "+14155550103",
      to: ["me"],
    }),
    ...overrides,
  }) as Communication;

function headerText(): string {
  return screen.getByTestId("thread-contact-name").textContent ?? "";
}

describe("BACKLOG-2814 — a NAMED group renders its name", () => {
  it("shows the chat name in place of the generic label", () => {
    render(
      <MessageThreadCard
        threadId="macos-chat-1"
        messages={[groupMessage({ thread_display_name: GROUP_NAME })]}
        phoneNumber="+14155550100"
      />,
    );

    expect(headerText()).toContain(GROUP_NAME);
    // The literal it replaced must be GONE, not merely joined by the name —
    // "Group Chat / Closing Team" would satisfy a `toContain` on the name alone.
    expect(headerText()).not.toContain("Group Chat");
  });

  it("keeps the participant list beneath the name", () => {
    // The name identifies the thread; the participants are still who is in it.
    render(
      <MessageThreadCard
        threadId="macos-chat-1"
        messages={[groupMessage({ thread_display_name: GROUP_NAME })]}
        phoneNumber="+14155550100"
        contactNames={{
          "+14155550101": "Pat Riverton",
          "+14155550102": "Robin Marsh",
        }}
      />,
    );

    expect(headerText()).toContain(GROUP_NAME);
    expect(headerText()).toContain("Pat Riverton");
    expect(headerText()).toContain("Robin Marsh");
  });

  it("reads the name off a later message when the first row lacks it", () => {
    // The loaders join the name onto every row of a thread, but a thread can mix
    // rows from sources that carry no name. Any row carrying it is enough.
    render(
      <MessageThreadCard
        threadId="macos-chat-1"
        messages={[
          groupMessage({ id: "msg-1" }),
          groupMessage({ id: "msg-2", thread_display_name: GROUP_NAME }),
        ]}
        phoneNumber="+14155550100"
      />,
    );

    expect(headerText()).toContain(GROUP_NAME);
  });

  it("shows the name on a REMOVED group card too", () => {
    // "Show removed" mounts the same card. A group the user removed must stay
    // recognisable, or they cannot tell which conversation they are restoring.
    render(
      <MessageThreadCard
        threadId="macos-chat-1"
        messages={[groupMessage({ thread_display_name: GROUP_NAME })]}
        phoneNumber="+14155550100"
        isRemoved
      />,
    );

    expect(headerText()).toContain(GROUP_NAME);
  });
});

describe("BACKLOG-2814 — an UNNAMED group falls back to participants", () => {
  it("falls back when the field is absent entirely", () => {
    render(
      <MessageThreadCard
        threadId="macos-chat-3"
        messages={[groupMessage()]}
        phoneNumber="+14155550100"
        contactNames={{ "+14155550101": "Pat Riverton" }}
      />,
    );

    expect(headerText()).toContain("Group Chat");
    expect(headerText()).toContain("Pat Riverton");
  });

  it("falls back when the field is null — Apple's NULL flavour of unnamed", () => {
    render(
      <MessageThreadCard
        threadId="macos-chat-3"
        messages={[
          groupMessage({
            thread_display_name: null as unknown as string,
          }),
        ]}
        phoneNumber="+14155550100"
      />,
    );

    expect(headerText()).toContain("Group Chat");
  });

  it("falls back when the field is the EMPTY STRING — Apple's common flavour", () => {
    // Not a duplicate of the NULL case. Against a real chat.db the empty string
    // outnumbers NULL more than ten to one, so this is the ordinary path. A card
    // that only guarded against null would render a BLANK title here.
    render(
      <MessageThreadCard
        threadId="macos-chat-2"
        messages={[groupMessage({ thread_display_name: "" })]}
        phoneNumber="+14155550100"
      />,
    );

    expect(headerText()).toContain("Group Chat");
  });

  it("falls back when the field is whitespace only", () => {
    render(
      <MessageThreadCard
        threadId="macos-chat-2"
        messages={[groupMessage({ thread_display_name: "   " })]}
        phoneNumber="+14155550100"
      />,
    );

    expect(headerText()).toContain("Group Chat");
  });
});

describe("BACKLOG-2814 — a 1:1 thread is unchanged", () => {
  it("shows the contact, NOT the chat name, on a NAMED 1:1", () => {
    // THE DISCRIMINATING TEST. Apple stores a display_name on 1:1 chats too
    // (10 in the founder's own chat.db). If the card gated on "is there a name"
    // instead of "is this a group", this thread would be titled "Mum" instead of
    // the contact's name — and every named 1:1 would lose its person.
    render(
      <MessageThreadCard
        threadId="macos-chat-4"
        messages={[oneToOneMessage({ thread_display_name: "Mum" })]}
        phoneNumber="+14155550103"
        contactName="Pat Riverton"
      />,
    );

    expect(headerText()).toContain("Pat Riverton");
    expect(headerText()).not.toContain("Mum");
    expect(headerText()).not.toContain("Group Chat");
  });

  it("falls back to the phone number on a named 1:1 with no contact", () => {
    render(
      <MessageThreadCard
        threadId="macos-chat-4"
        messages={[oneToOneMessage({ thread_display_name: "Mum" })]}
        phoneNumber="+14155550103"
      />,
    );

    expect(headerText()).toContain("+14155550103");
    expect(headerText()).not.toContain("Mum");
  });
});

describe("BACKLOG-2814 — getThreadDisplayName", () => {
  it("returns null for every representation of absent", () => {
    expect(getThreadDisplayName([])).toBeNull();
    expect(getThreadDisplayName([groupMessage()])).toBeNull();
    expect(getThreadDisplayName([groupMessage({ thread_display_name: "" })])).toBeNull();
    expect(getThreadDisplayName([groupMessage({ thread_display_name: "  " })])).toBeNull();
    expect(
      getThreadDisplayName([
        groupMessage({ thread_display_name: null as unknown as string }),
      ]),
    ).toBeNull();
  });

  it("trims a name rather than returning it raw", () => {
    expect(
      getThreadDisplayName([groupMessage({ thread_display_name: `  ${GROUP_NAME}  ` })]),
    ).toBe(GROUP_NAME);
  });
});
