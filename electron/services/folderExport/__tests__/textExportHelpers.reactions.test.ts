/**
 * @jest-environment node
 *
 * BACKLOG-2280 — text export reaction handling.
 *
 * Reactions must NOT be exported as their own (empty) message, must be rendered as
 * a single evidentiary "Reactions:" line under their PARENT message, and must NOT
 * inflate the per-thread / summary message counts.
 */

jest.mock("../../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});
jest.mock("../../contactResolutionService", () => ({
  normalizePhone: (s: string) => (s || "").replace(/\D/g, "").slice(-10),
}));

import type { Communication } from "../../../types/models";
import {
  generateTextThreadHTML,
  getMessageTypeCounts,
  countTextThreads,
} from "../textExportHelpers";

function msg(over: Partial<Communication>): Communication {
  return {
    id: over.id!,
    user_id: "u1",
    has_attachments: false,
    is_false_positive: false,
    created_at: "2026-01-01T00:00:00.000Z",
    channel: "imessage",
    ...over,
  } as Communication;
}

const parent = msg({
  id: "P1",
  external_id: "GUID-P1",
  direction: "inbound",
  body_text: "Are we still on for Friday?",
  thread_id: "th-1",
  sent_at: "2026-01-01T10:00:00.000Z",
  sender: "+12065551234",
});

// "me" reacted with a heart on the parent (outbound tapback).
const reaction = msg({
  id: "R1",
  external_id: "R1",
  direction: "outbound",
  body_text: "",
  thread_id: "th-1",
  sent_at: "2026-01-01T10:01:00.000Z",
  associated_message_type: 2000,
  associated_message_guid: "GUID-P1",
});

describe("generateTextThreadHTML — reactions (BACKLOG-2280)", () => {
  const contact = { phone: "+12065551234", name: "Jane" };

  it("renders exactly one evidentiary reactions line, and no empty reaction bubble", () => {
    const html = generateTextThreadHTML([parent, reaction], contact, {}, false, 0);
    // The parent body is present.
    expect(html).toContain("Are we still on for Friday?");
    // Exactly one reactions line, carrying the heart glyph + reactor ("You").
    const matches = html.match(/class="reactions"/g) || [];
    expect(matches).toHaveLength(1);
    expect(html).toContain("Reactions:");
    expect(html).toContain("❤️");
    expect(html).toContain("You");
  });

  it("keeps the header message count honest (excludes the reaction)", () => {
    const html = generateTextThreadHTML([parent, reaction], contact, {}, false, 0);
    // One real message in the thread — NOT two.
    expect(html).toContain("1 message");
    expect(html).not.toContain("2 messages");
  });

  it("collapses an add→remove pair to nothing (no reactions line)", () => {
    const removed = msg({
      id: "R2",
      external_id: "R2",
      direction: "outbound",
      body_text: "",
      thread_id: "th-1",
      sent_at: "2026-01-01T10:02:00.000Z",
      associated_message_type: 3000, // remove heart
      associated_message_guid: "GUID-P1",
    });
    const html = generateTextThreadHTML([parent, reaction, removed], contact, {}, false, 0);
    expect(html).not.toContain("class=\"reactions\"");
  });
});

describe("export summary counts exclude reactions (BACKLOG-2280)", () => {
  it("getMessageTypeCounts does not count a reaction as a text message", () => {
    const counts = getMessageTypeCounts([parent, reaction]);
    expect(counts.textMessages).toBe(1);
  });

  it("countTextThreads ignores a reaction-only contribution", () => {
    // Both rows share th-1; the reaction must not create/keep a phantom thread.
    expect(countTextThreads([parent, reaction])).toBe(1);
  });
});
