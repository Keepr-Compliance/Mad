/**
 * BACKLOG-3619 — Control 1: extraction of a Messages for Web conversation.
 *
 * Runs chrome-extension/extract.js (the same file the content script loads)
 * against a fixture with SYNTHETIC values. Its header states which parts of the
 * structure were observed on the live page and which are unverified.
 */

import * as fs from "fs";
import * as path from "path";

interface ExtractedMessage {
  msgId: string;
  direction: "inbound" | "outbound";
  sender: string;
  text: string;
  sentAt: string;
  transport: "rcs" | "sms" | null;
  images: number;
  imageSrcs: string[];
  files: Array<{ name: string; size: string }>;
  reactions: Array<{ emoji: string; reactor: string; word: string }>;
}

interface ExtractResult {
  conversationId: string | null;
  title: string;
  messages: ExtractedMessage[];
  skipped: { noDate: number; noText: number; duplicate: number };
}

interface ExtractModule {
  extractConversation: (doc: Document, href: string, now: Date) => ExtractResult;
  parseAriaDate: (
    label: string,
    now: Date,
  ) => { direction: "inbound" | "outbound"; date: Date } | null;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const extract = require("../../chrome-extension/extract.js") as ExtractModule;

const FIXTURE = fs.readFileSync(
  path.join(__dirname, "fixtures", "conversation.synthetic.html"),
  "utf8",
);
const HREF = "https://messages.google.com/web/conversations/aaaaaaaaaaaaaaaaaaa";
// Tuesday 29 September 2026, 13:00 local.
const NOW = new Date(2026, 8, 29, 13, 0);

function local(y: number, mo: number, d: number, h: number, mi: number): string {
  return new Date(y, mo, d, h, mi).toISOString();
}

describe("extractConversation (synthetic fixture)", () => {
  let result: ExtractResult;

  beforeEach(() => {
    document.body.innerHTML = FIXTURE;
    result = extract.extractConversation(document, HREF, NOW);
  });

  it("reads the conversation id from the URL and the title from the header", () => {
    expect(result.conversationId).toBe("aaaaaaaaaaaaaaaaaaa");
    expect(result.title).toBe("Test Contact A");
  });

  it("reads each message's transport from its RCS flag", () => {
    expect(result.messages.map((m) => m.transport)).toEqual(["sms", "rcs", "sms", "sms", "sms", "sms", "sms"]);
  });

  it("returns exactly the dated messages, in page order, keyed by msg-id", () => {
    expect(result.messages.map((m) => m.msgId)).toEqual(["101", "102", "103", "104", "105", "107", "108"]);
    expect(result.skipped).toEqual({ noDate: 1, noText: 0, duplicate: 1 });
  });

  it("reads direction from the outgoing marker and the sender from the label", () => {
    expect(result.messages.map((m) => m.direction)).toEqual([
      "inbound",
      "outbound",
      "inbound",
      "outbound",
      "inbound",
      "inbound",
      "outbound",
    ]);
    expect(result.messages.map((m) => m.sender)).toEqual([
      "Test Contact A",
      "me",
      "Test Contact A",
      "me",
      "Test Contact B",
      "Test Contact B",
      "me",
    ]);
  });

  it("takes a message's own text and never the quoted parent's", () => {
    expect(result.messages.map((m) => m.text)).toEqual([
      "It was sent on Monday at 3:00 PM. Thanks.",
      "Reply number two",
      "Answer three",
      "Fourth line",
      "",
      "Group reply seven",
      "",
    ]);
  });

  it("resolves the LAST date phrase in each label to local minutes", () => {
    expect(result.messages.map((m) => m.sentAt)).toEqual([
      local(2026, 8, 20, 9, 5),
      local(2026, 8, 28, 16, 30),
      local(2026, 8, 29, 8, 15),
      local(2026, 8, 29, 12, 1),
      local(2026, 8, 28, 12, 30),
      local(2026, 8, 27, 10, 0),
      local(2026, 8, 29, 12, 30),
    ]);
  });

  // BACKLOG-3620 -----------------------------------------------------------

  it("control 9: keeps an image-only message, with its blob URL and the sender from 'sent an image'", () => {
    const img = result.messages.find((m) => m.msgId === "105");
    expect(img).toBeDefined();
    expect(img).toMatchObject({
      direction: "inbound",
      sender: "Test Contact B",
      text: "",
      images: 1,
      imageSrcs: ["blob:https://messages.google.com/synthetic-image-0105"],
    });
  });

  it("records a file by name and size only", () => {
    const file = result.messages.find((m) => m.msgId === "108");
    expect(file).toMatchObject({ images: 0, files: [{ name: "test-document.pdf", size: "1.3 MB" }] });
  });

  it("reads each reaction's emoji and reactor ('You' is me)", () => {
    const first = result.messages.find((m) => m.msgId === "101");
    expect(first?.reactions).toEqual([
      { emoji: "😡", reactor: "Test Contact A", word: "angry" },
      { emoji: "😢", reactor: "me", word: "sad" },
    ]);
    expect(result.messages.filter((m) => m.msgId !== "101").every((m) => m.reactions.length === 0)).toBe(true);
  });

  it("a reaction tail after the date does not change the message's time or sender", () => {
    const first = result.messages.find((m) => m.msgId === "101");
    expect(first?.sentAt).toBe(local(2026, 8, 20, 9, 5));
    expect(first?.sender).toBe("Test Contact A");
  });
});

describe("parseAriaDate", () => {
  it.each([
    ["Received on Today at 12:00 AM", local(2026, 8, 29, 0, 0), "inbound"],
    ["Sent on Today at 12:59 PM", local(2026, 8, 29, 12, 59), "outbound"],
    ["Sent on Monday at 7:00 AM", local(2026, 8, 28, 7, 0), "outbound"],
    ["Sent on Tuesday at 7:00 AM", local(2026, 8, 22, 7, 0), "outbound"],
    ["Received on Sep 3 at 10:10 PM", local(2026, 8, 3, 22, 10), "inbound"],
    ["Received on December 31 at 11:59 PM", local(2025, 11, 31, 23, 59), "inbound"],
    ["Received on 1/2/25 at 1:02 PM", local(2025, 0, 2, 13, 2), "inbound"],
    ["Received on Today at 9:05\u202fAM.", local(2026, 8, 29, 9, 5), "inbound"],
    ["Received on Yesterday at 11:40 AM.", local(2026, 8, 28, 11, 40), "inbound"],
    ["You said: a. Sent on August 9, 2026 at 10:07 PM. SMS.", local(2026, 7, 9, 22, 7), "outbound"],
    [
      "B said: sent on Monday at 1:00 PM. Received on August 9, 2026 at 10:07 PM.",
      local(2026, 7, 9, 22, 7),
      "inbound",
    ],
  ])("%s", (label, iso, direction) => {
    const parsed = extract.parseAriaDate(label, NOW);
    expect(parsed).not.toBeNull();
    expect(parsed?.date.toISOString()).toBe(iso);
    expect(parsed?.direction).toBe(direction);
  });

  it("returns null when there is no date phrase", () => {
    expect(extract.parseAriaDate("Test Contact A said: hi", NOW)).toBeNull();
    expect(extract.parseAriaDate("Sent on Someday at 1:00 PM", NOW)).toBeNull();
  });
});

describe("reaction pill with a count (SR note)", () => {
  function pill(attr: string | null, text: string): string {
    const a = attr === null ? "" : ` data-e2e-reaction-emoji="${attr}"`;
    return `<mws-message-wrapper msg-id="7"><div data-e2e-message-wrapper-core data-e2e-message-outgoing="false" data-e2e-message-rcs="true">
      <mws-text-message-part aria-label="Test Contact A said: hi. Received on September 20, 2026 at 9:05 AM. Test Contact B reacted with angry."><mws-message-part-content data-e2e-message-content>hi</mws-message-part-content></mws-text-message-part>
      <mw-message-reactions-display><span class="reaction" data-e2e-reaction${a}>${text}</span></mw-message-reactions-display>
    </div></mws-message-wrapper>`;
  }

  it.each([
    ["attribute present, text '😡 2'", "😡", "😡 2"],
    ["no attribute, text '😡 2'", null, "😡 2"],
    ["no attribute, text '😡2'", null, "😡2"],
  ])("%s -> 😡", (_label, attr, text) => {
    document.body.innerHTML = pill(attr, text);
    const r = extract.extractConversation(document, "https://messages.google.com/web/conversations/zzzzzzzzzzzzzzzzzzz", NOW) as {
      messages: Array<{ reactions: Array<{ emoji: string }> }>;
    };
    expect(r.messages[0].reactions.map((x) => x.emoji)).toEqual(["😡"]);
  });
});
