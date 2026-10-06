/**
 * Founder (minimal copy): the Force re-import result is one short line; the
 * Android Companion is named only when it cleared something. Mutations: the
 * companion named with nothing cleared there; the long wording back → red.
 */
import { androidClearedText } from "../AndroidForceReimportWarning";

describe("androidClearedText", () => {
  it("nothing from the companion: 'Cleared 8,344 texts. Sync Android on the dashboard to get them back.'", () => {
    expect(androidClearedText({ gmwebMessages: 8344, companionMessages: 0, contacts: 0 })).toBe(
      `Cleared ${(8344).toLocaleString()} texts. Sync Android on the dashboard to get them back.`,
    );
    expect(androidClearedText({ gmwebMessages: 8344, companionMessages: 0, contacts: 0 })).not.toMatch(/Companion|companion|imported from/);
  });

  it("the companion cleared texts or contacts: named, with its Sync Now", () => {
    expect(androidClearedText({ gmwebMessages: 175, companionMessages: 12, contacts: 3 })).toBe(
      "Cleared 187 texts and 3 contacts. Sync Android on the dashboard, or Sync Now in the Android Companion, to get them back.",
    );
    expect(androidClearedText({ gmwebMessages: 0, companionMessages: 0, contacts: 1 })).toBe(
      "Cleared 0 texts and 1 contact. Sync Android on the dashboard, or Sync Now in the Android Companion, to get them back.",
    );
  });
});
