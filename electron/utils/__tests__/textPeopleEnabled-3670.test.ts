/**
 * @jest-environment node
 */
/**
 * BACKLOG-3670 C1 (founder decision b): the Messages / SMS auto-discover
 * switch gates the people found in Google Messages texts; with no stored
 * value it is ON for an Android: Google Messages user, off otherwise; an
 * explicit off stays off. Mutations: default on for everyone / off for
 * everyone / an explicit off overridden → red.
 */
jest.mock("../../services/supabaseService", () => ({ __esModule: true, default: { getPreferences: jest.fn() } }));
jest.mock("../../services/logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resolveTextPeopleEnabled } = require("../preferenceHelper") as typeof import("../preferenceHelper");

describe("people found in texts: the Messages / SMS switch (C1)", () => {
  it("no stored value: on for Android: Google Messages, off for every other source", () => {
    expect(resolveTextPeopleEnabled({ messages: { source: "android-messages-web" } })).toBe(true);
    for (const source of ["macos-native", "iphone-sync", "android-companion", undefined]) {
      expect(resolveTextPeopleEnabled({ messages: { source } })).toBe(false);
    }
    expect(resolveTextPeopleEnabled(null)).toBe(false);
  });

  it("an explicit value wins: off stays off, on stays on", () => {
    expect(resolveTextPeopleEnabled({ messages: { source: "android-messages-web" }, contactSources: { inferred: { messages: false } } })).toBe(false);
    expect(resolveTextPeopleEnabled({ messages: { source: "iphone-sync" }, contactSources: { inferred: { messages: true } } })).toBe(true);
  });
});
