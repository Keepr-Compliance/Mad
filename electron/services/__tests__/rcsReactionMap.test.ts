/**
 * @jest-environment node
 */
/**
 * BACKLOG-3620 — Messages for Web reaction emoji -> Keepr tapback code.
 */

import { bareEmoji, rcsReactionExternalId, reactionTypeForEmoji } from "../rcsReactionMap";

describe("reactionTypeForEmoji", () => {
  it.each([
    ["❤️", 2000],
    ["❤", 2000],
    ["\u{1F44D}", 2001],
    ["\u{1F44E}", 2002],
    ["\u{1F602}", 2003],
    ["‼️", 2004],
    ["❗", 2004],
    ["❓", 2005],
    ["\u{1F621}", 2006],
    ["\u{1F622}", 2006],
    ["\u{1F389}", 2006],
  ])("%s -> %s", (emoji, code) => {
    expect(reactionTypeForEmoji(emoji)).toBe(code);
  });
});

describe("rcsReactionExternalId", () => {
  it("is stable per (parent, reactor, emoji) and ignores the variation selector", () => {
    expect(rcsReactionExternalId("gmweb:c:1", "me", "❤️")).toBe(
      rcsReactionExternalId("gmweb:c:1", "me", "❤"),
    );
    expect(rcsReactionExternalId("gmweb:c:1", "me", "❤")).not.toBe(
      rcsReactionExternalId("gmweb:c:1", "Test Contact A", "❤"),
    );
    expect(bareEmoji(" ❤️ ")).toBe("❤");
  });
});
