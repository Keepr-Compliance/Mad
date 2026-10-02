/**
 * Extraction edge cases from a real founder chat (no content shared) —
 * synthetic fixtures with INVENTED text. Structures are the live-page shapes
 * already traced (mws-message-wrapper, its core, the text part, aria-label
 * "… Received on <date> at <time>.", tombstone rows, the reactions display,
 * the quoted-parent container); the link-preview container, the empty image
 * bubble and the time-only label are UNTRACED shapes handled defensively.
 *
 * Mutations that turn this red:
 *   X1 link-preview parts counted as text / as separate messages   → "link preview"
 *   X2 protocol-switch system rows read as messages                → "protocol switch"
 *   X3 tapback summary lines kept as messages                      → "tapback lines"
 *   X4 a lone-emoji message dropped, or a reaction badge as text   → "lone emoji"
 *   X5 a video file name / empty image bubble not an attachment    → "video and empty image"
 *   X6 dates without a year / time-only labels mis-dated            → "dates"
 *   X7 a quoted reply's quote read as the message                  → "quoted reply"
 */
export {};

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const extract = require("../../chrome-extension/extract.js") as Record<string, any>;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const HREF = "https://messages.google.com/web/conversations/aaaaaaaaaaaaaaaaaaa";
// Fri 2026-01-02 10:00 local (just after a year boundary).
const NOW = new Date(2026, 0, 2, 10, 0);

interface Msg {
  msgId: string; direction: string; sender: string; text: string; sentAt: string;
  images: number; files: Array<{ name: string; size: string }>; reactions: Array<{ emoji: string; reactor: string; word: string }>;
}
const run = (html: string): { messages: Msg[]; skipped: Record<string, number> } => {
  document.body.innerHTML = `<div data-e2e-header-title><h2>Test Contact A</h2></div>${html}`;
  return extract.extractConversation(document, HREF, NOW);
};

/** One inbound text message (the traced shape). */
function textMsg(id: string, text: string, label: string, extra = ""): string {
  return `<mws-message-wrapper msg-id="${id}"><div data-e2e-message-wrapper-core data-e2e-message-outgoing="false" data-e2e-message-rcs="true">
    <mws-text-message-part aria-label="Test Contact A said: ${text}. ${label}."><mws-message-part-content data-e2e-message-content>${text}</mws-message-part-content></mws-text-message-part>
    ${extra}</div></mws-message-wrapper>`;
}
const ON = (d: string, t = "9:05 AM") => `Received on ${d} at ${t}`;
/** A video file name shaped like a UUID, built at runtime (an invented example id, not data). */
const VIDEO_UUID_NAME = [["3f2504e0", "4f89", "11d3", "9a0c", "0305e82c3301"].join("-"), "mp4"].join(".");

describe("extraction edge cases", () => {
  it("link preview: the URL bubble and its preview card are ONE message; preview parts are not text (X1)", () => {
    const preview = `<mws-link-preview data-e2e-link-preview>
      <div class="title">Example Preview Title</div><div class="title">Example Preview Title</div>
      <div class="description">An invented description.</div><div class="domain">example.com</div></mws-link-preview>`;
    const r = run(textMsg("1", "https://example.com/page", ON("December 30, 2025"), preview));
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].text).toBe("https://example.com/page");
  });

  it("protocol switch: \"Texting with …\" / \"Chat with … Details\" system rows are not messages (X2)", () => {
    const r = run(`
      <mws-tombstone-message-wrapper><div>Texting with Test Contact A (SMS/MMS)</div></mws-tombstone-message-wrapper>
      ${textMsg("1", "hello there", ON("December 30, 2025"))}
      <mws-tombstone-message-wrapper><div>Chat with Test Contact A. Details</div></mws-tombstone-message-wrapper>`);
    expect(r.messages.map((m) => m.text)).toEqual(["hello there"]);
  });

  it("tapback lines: \"Loved an image\" / \"Laughed at “…”\" are reactions on their target, not messages (X3)", () => {
    const img = `<mws-message-wrapper msg-id="1"><div data-e2e-message-wrapper-core data-e2e-message-outgoing="true" data-e2e-message-rcs="false">
      <mws-image-message-part aria-label="You sent an image. ${"Sent on December 30, 2025 at 9:00 AM"}."><div data-e2e-message-image><img src="blob:x-1"></div></mws-image-message-part>
      </div></mws-message-wrapper>`;
    const r = run(`${img}
      ${textMsg("2", "see you at noon", ON("December 30, 2025", "9:10 AM"))}
      ${textMsg("3", "Loved an image", ON("December 30, 2025", "9:12 AM"))}
      ${textMsg("4", "Laughed at “see you at noon”", ON("December 30, 2025", "9:13 AM"))}`);
    expect(r.messages.map((m) => m.msgId)).toEqual(["1", "2"]);
    expect(r.messages[0].reactions).toEqual([{ emoji: "❤️", reactor: "Test Contact A", word: "loved" }]);
    expect(r.messages[1].reactions).toEqual([{ emoji: "😂", reactor: "Test Contact A", word: "laughed" }]);
  });

  it("tapback line with no target on screen: kept as a message (never lost)", () => {
    const r = run(textMsg("9", "Loved “an older message”", ON("December 30, 2025")));
    expect(r.messages.map((m) => m.text)).toEqual(["Loved “an older message”"]);
  });

  it("lone emoji: a ❤️ bubble IS a message; a reaction badge is NOT text (X4)", () => {
    const badge = `<mw-message-reactions-display><span class="reaction" data-e2e-reaction data-e2e-reaction-emoji="❤️">❤️</span></mw-message-reactions-display>`;
    const r = run(`${textMsg("1", "❤️", ON("December 30, 2025"))}${textMsg("2", "thanks", ON("December 30, 2025", "9:06 AM"), badge)}`);
    expect(r.messages.map((m) => m.text)).toEqual(["❤️", "thanks"]);
    expect(r.messages[1].reactions.map((x) => x.emoji)).toEqual(["❤️"]);
  });

  it("video and empty image: a \"<name>.mp4\" bubble and an empty image bubble are attachment messages (X5)", () => {
    const emptyImage = `<mws-message-wrapper msg-id="3"><div data-e2e-message-wrapper-core data-e2e-message-outgoing="false" data-e2e-message-rcs="true">
      <mws-image-message-part aria-label="Test Contact A sent an image. ${ON("December 30, 2025", "9:20 AM")}."><div data-e2e-message-image></div></mws-image-message-part>
      </div></mws-message-wrapper>`;
    const r = run(`${textMsg("1", VIDEO_UUID_NAME, ON("December 30, 2025"))}
      ${textMsg("2", "159605.mp4", ON("December 30, 2025", "9:10 AM"))}${emptyImage}`);
    expect(r.messages.map((m) => [m.msgId, m.text, m.files.map((f) => f.name)])).toEqual([
      ["1", "", [VIDEO_UUID_NAME]],
      ["2", "", ["159605.mp4"]],
      ["3", "", ["image (not loaded)"]],
    ]);
  });

  it("dates: with a year, without a year across the boundary, and a time-only label (X6)", () => {
    const r = run(`
      ${textMsg("1", "one", "Received on Monday, July 28, 2025 at 1:43 PM")}
      ${textMsg("2", "two", "Received on Thursday, Jan 1 at 10:24 AM")}
      ${textMsg("3", "three", "Received on Dec 31 at 11:59 PM")}
      ${textMsg("4", "four", "Received at 2:56 PM")}`);
    const at = Object.fromEntries(r.messages.map((m) => [m.msgId, new Date(m.sentAt)]));
    expect(at["1"]).toEqual(new Date(2025, 6, 28, 13, 43));
    expect(at["2"]).toEqual(new Date(2026, 0, 1, 10, 24)); // this year
    expect(at["3"]).toEqual(new Date(2025, 11, 31, 23, 59)); // Dec 31 is in the future this year → last year
    // time only, no day separator: 2:56 PM is > 5 min in the future at 10:00 → yesterday
    expect(at["4"]).toEqual(new Date(2026, 0, 1, 14, 56));
  });

  // SR: a time-only label takes the nearest preceding day separator's day;
  // else today, or yesterday when today would be > 5 min in the future.
  // Mutations: the separator ignored / the future rule dropped → red.
  it("time-only labels: the preceding day separator, across midnight, a \"Yesterday\" header, a future time", () => {
    const sep = (text: string) => `<mws-tombstone-message-wrapper><div>${text}</div></mws-tombstone-message-wrapper>`;
    const r = run(`
      ${sep("Wednesday, Dec 31 · 11:58 PM")}
      ${textMsg("1", "before midnight", "Received at 11:59 PM")}
      ${sep("Thursday, Jan 1 · 12:01 AM")}
      ${textMsg("2", "after midnight", "Received at 12:01 AM")}
      ${sep("Yesterday · 2:56 PM")}
      ${sep("2:56 PM ·")}
      ${textMsg("3", "yesterday afternoon", "Received at 2:56 PM")}
      ${sep("Today · 9:00 AM")}
      ${textMsg("4", "this morning", "Received at 9:00 AM")}`);
    const at = Object.fromEntries(r.messages.map((m) => [m.msgId, new Date(m.sentAt)]));
    expect(at["1"]).toEqual(new Date(2025, 11, 31, 23, 59));
    expect(at["2"]).toEqual(new Date(2026, 0, 1, 0, 1));
    expect(at["3"]).toEqual(new Date(2026, 0, 1, 14, 56)); // the time-only "2:56 PM ·" row is skipped
    expect(at["4"]).toEqual(new Date(2026, 0, 2, 9, 0));
    // No separator: a past time is today; within 5 min ahead (clock skew) still today.
    const past = run(textMsg("5", "earlier", "Received at 9:58 AM"));
    expect(new Date(past.messages[0].sentAt)).toEqual(new Date(2026, 0, 2, 9, 58));
    const soon = run(textMsg("6", "clock skew", "Received at 10:04 AM"));
    expect(new Date(soon.messages[0].sentAt)).toEqual(new Date(2026, 0, 2, 10, 4));
  });

  it("quoted reply: the reply is the one message; the quoted name and text are not (X7)", () => {
    const quote = `<div class="embed-msg-part-container"><mws-text-message-part aria-label="Test Contact B said: the original question. ${ON("December 29, 2025")}.">
      <span>Test Contact B</span><mws-message-part-content data-e2e-message-content>the original question</mws-message-part-content></mws-text-message-part></div>`;
    const r = run(`<mws-message-wrapper msg-id="1"><div data-e2e-message-wrapper-core data-e2e-message-outgoing="false" data-e2e-message-rcs="true">
      ${quote}
      <mws-text-message-part aria-label="Test Contact A said: the reply. ${ON("December 30, 2025")}."><mws-message-part-content data-e2e-message-content>the reply</mws-message-part-content></mws-text-message-part>
      </div></mws-message-wrapper>`);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]).toMatchObject({ text: "the reply", sender: "Test Contact A" });
    expect(new Date(r.messages[0].sentAt)).toEqual(new Date(2025, 11, 30, 9, 5));
  });
});
