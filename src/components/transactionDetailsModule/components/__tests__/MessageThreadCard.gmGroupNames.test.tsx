/**
 * Group-sender names (bug): a Google Messages group's members who are not
 * Keepr contacts are named from what Google Messages showed (main process,
 * contactResolutionService Source 4). The names map arrives in the shape
 * resolvePhoneNames writes for those numbers (E.164 + last-10 keys; pinned in
 * electron/services/__tests__/rcsGroupSenderNames.test.ts); the card shows
 * the names, not the numbers. Mutation: the keys / names not used → red.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MessageThreadCard } from "../MessageThreadCard";
import type { Communication } from "../../types";

const NUM_A = "+15555550111";
const NUM_B = "+15555550112";

const gmGroupMessage = (): Communication =>
  ({
    id: "msg-gm-1",
    user_id: "user-gsn",
    channel: "sms",
    direction: "inbound",
    body_text: "hello",
    sent_at: "2026-09-20T10:00:00Z",
    has_attachments: false,
    is_false_positive: false,
    thread_id: "gmweb2-test",
    participants: JSON.stringify({ from: NUM_A, to: ["me", NUM_B], chat_members: [NUM_A, NUM_B] }),
  }) as Communication;

/** What Source 4 writes for an rcs-only number (keys: as given, last 10, E.164). */
const fromSource4 = (num: string, name: string) => ({ [num]: name, [num.replace(/\D/g, "").slice(-10)]: name });

it("a Google Messages group shows its members' names from Google Messages, not numbers", () => {
  render(
    <MessageThreadCard
      threadId="gmweb2-test"
      messages={[gmGroupMessage()]}
      phoneNumber={NUM_A}
      contactNames={{ ...fromSource4(NUM_A, "Test Person A"), ...fromSource4(NUM_B, "Test Person B") }}
    />,
  );
  const header = screen.getByTestId("thread-contact-name").textContent ?? "";
  expect(header).toContain("Test Person A");
  expect(header).toContain("Test Person B");
  expect(header).not.toContain("555");
});
