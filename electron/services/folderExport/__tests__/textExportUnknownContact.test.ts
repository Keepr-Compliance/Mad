/**
 * @jest-environment node
 *
 * BACKLOG-2463 — the text-thread export must stop calling people "Unknown".
 *
 * BACKLOG-2461 settled the display chain (name -> organisation -> formatted
 * phone -> email -> "No name") and applied it to the contact surfaces and the
 * audit summary PDF. The text export was left out to keep that PR reviewable, so
 * it kept the old answer at five sites — including one that writes the label into
 * an exported FILE NAME. That last one is the reason this is a bug rather than a
 * cosmetic complaint: a wrong label on a screen dies at the next render, while a
 * wrong label in a filename is handed to the broker and outlives the fix.
 *
 * These tests assert exact strings and exact file names. "Does not contain
 * Unknown" is necessary but nowhere near sufficient — the point is that the file
 * is named after the NUMBER we were holding the whole time.
 */

jest.mock("../../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});
jest.mock("../../contactResolutionService", () => ({
  __esModule: true,
  normalizePhone: (s: string) => (s || "").replace(/\D/g, "").slice(-10),
}));

import type { Communication } from "../../../types/models";
import {
  getThreadContact,
  generateTextIndex,
  generateTextThreadHTML,
  generateTextMessageHTML,
} from "../textExportHelpers";

function msg(over: Partial<Communication>): Communication {
  return {
    id: over.id!,
    user_id: "u1",
    has_attachments: false,
    is_false_positive: false,
    created_at: "2026-01-01T00:00:00.000Z",
    channel: "imessage",
    communication_type: "imessage",
    ...over,
  } as Communication;
}

/** A 1:1 thread from a number we hold but have no contact record for. */
const namelessWithPhone = [
  msg({
    id: "N1",
    direction: "inbound",
    thread_id: "th-nameless",
    sender: "+12065550103",
    body_text: "Closing docs are attached.",
    sent_at: "2026-01-15T10:00:00.000Z",
  }),
];

/** A thread whose messages never carried a handle at all. */
const noHandleAtAll = [
  msg({
    id: "U1",
    direction: "inbound",
    thread_id: "th-nohandle",
    body_text: "…",
    sent_at: "2026-01-16T10:00:00.000Z",
  }),
];

describe("getThreadContact — the sentinel handle is gone (BACKLOG-2463)", () => {
  it("returns an EMPTY handle, not the word 'Unknown', when no handle exists", () => {
    // `phone` means "the handle this thread is keyed on". Writing "Unknown" into
    // it invented a handle no message ever carried, and then three call sites
    // had to test for that literal to undo it — one of them into a filename.
    expect(getThreadContact(noHandleAtAll, {})).toEqual({ phone: "", name: null });
  });

  it("still returns the real handle when there is one", () => {
    expect(getThreadContact(namelessWithPhone, {})).toEqual({
      phone: "+12065550103",
      name: null,
    });
  });

  it("resolves the name through the phone→name map when we have one", () => {
    expect(getThreadContact(namelessWithPhone, { "2065550103": "Jane Rivera" })).toEqual({
      phone: "+12065550103",
      name: "Jane Rivera",
    });
  });
});

describe("generateTextIndex — the summary's thread list (BACKLOG-2463)", () => {
  it("indexes a nameless thread by its FORMATTED number", () => {
    const html = generateTextIndex(namelessWithPhone, {});
    expect(html).toContain(
      '<span class="contact">+1 (206) 555-0103 (1 msg)</span>',
    );
    expect(html.toLowerCase()).not.toContain("unknown");
  });

  it("indexes an organisation-only party under the organisation", () => {
    // A contact with no personal name arrives here as a resolved name string —
    // which for an organisation-only record IS the organisation.
    const html = generateTextIndex(namelessWithPhone, { "2065550103": "Acme Title Co." });
    expect(html).toContain('<span class="contact">Acme Title Co. (1 msg)</span>');
  });

  it("uses the chain's terminal fallback when the thread has no handle at all", () => {
    const html = generateTextIndex(noHandleAtAll, {});
    expect(html).toContain('<span class="contact">No name (1 msg)</span>');
    expect(html.toLowerCase()).not.toContain("unknown");
  });

  it("reads a legacy 'Unknown' display_name as no name and falls to the number", () => {
    const html = generateTextIndex(namelessWithPhone, { "2065550103": "Unknown" });
    expect(html).toContain('<span class="contact">+1 (206) 555-0103 (1 msg)</span>');
    expect(html.toLowerCase()).not.toContain("unknown");
  });

  it("still names an unresolvable GROUP thread for the chat", () => {
    const group = [
      msg({
        id: "G1",
        direction: "inbound",
        thread_id: "th-group",
        body_text: "hi all",
        sent_at: "2026-01-17T10:00:00.000Z",
        participants: JSON.stringify({ chat_members: ["+12065550103", "+12065550113"] }),
      }),
    ];
    const html = generateTextIndex(group, {});
    expect(html).toContain('<span class="contact">Group Chat (1 msg)</span>');
  });
});

describe("generateTextThreadHTML — the thread page header (BACKLOG-2463)", () => {
  it("titles a nameless thread with the formatted number", () => {
    const html = generateTextThreadHTML(
      namelessWithPhone,
      getThreadContact(namelessWithPhone, {}),
      {},
      false,
      0,
    );
    expect(html).toContain(
      '<h1>Conversation with +1 (206) 555-0103 <span class="badge">#001</span></h1>',
    );
    expect(html.toLowerCase()).not.toContain("unknown");
  });

  it("titles a handle-less thread with the terminal fallback, standing alone", () => {
    const html = generateTextThreadHTML(
      noHandleAtAll,
      getThreadContact(noHandleAtAll, {}),
      {},
      false,
      0,
    );
    expect(html).toContain('<h1>No name <span class="badge">#001</span></h1>');
    expect(html.toLowerCase()).not.toContain("unknown");
  });

  it("attributes an inbound message in a handle-less 1:1 to the fallback, not to nobody", () => {
    // The empty handle replaced the sentinel, so `name || phone` would render the
    // EMPTY STRING here — a message from no one at all.
    const html = generateTextMessageHTML(
      noHandleAtAll[0],
      getThreadContact(noHandleAtAll, {}),
      {},
      false,
    );
    expect(html).toContain('<span class="sender">No name</span>');
    expect(html).not.toContain('<span class="sender"></span>');
  });

  it("attributes an inbound message in a nameless 1:1 to the formatted number", () => {
    const html = generateTextMessageHTML(
      namelessWithPhone[0],
      getThreadContact(namelessWithPhone, {}),
      {},
      false,
    );
    expect(html).toContain('<span class="sender">+1 (206) 555-0103</span>');
  });

  it("names group participants through the same chain", () => {
    const group = [
      msg({
        id: "G1",
        direction: "inbound",
        thread_id: "th-group",
        sender: "+12065550103",
        body_text: "hi all",
        sent_at: "2026-01-17T10:00:00.000Z",
        participants: JSON.stringify({ chat_members: ["+12065550103", "+12065550113"] }),
      }),
    ];
    const html = generateTextThreadHTML(group, { phone: "", name: null }, {}, true, 0, [
      { phone: "+12065550103", name: "Jane Rivera" },
      { phone: "+12065550113", name: null },
      { phone: "", name: null },
    ]);
    expect(html).toContain('<span style="color: #2d3748;">Jane Rivera</span>');
    expect(html).toContain('<span style="color: #2d3748;">+1 (206) 555-0113</span>');
    expect(html).toContain('<span style="color: #2d3748;">No name</span>');
    expect(html.toLowerCase()).not.toContain("unknown");
  });
});
