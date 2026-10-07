/**
 * BACKLOG-3418 — `chosenImportSource`, the one rule every reader of "the source"
 * uses (SR ruling 3433cf56, C-1/C-6). Swept over every input combination so a
 * wrong rule fails here as well as at the provider.
 */
import { chosenImportSource, chosenImportSourceNeedsPhoneType } from "../importSourcePolicy";

type Phone = "iphone" | "android" | null;
const STORED = [undefined, "iphone-sync", "macos-native", "android-companion", "android-messages-web", "some-future-source"] as const;
const PHONES: Phone[] = [null, "iphone", "android"];

/** The rule, written out independently of the implementation. */
function expected(stored: string | undefined, local: Phone, cloud: Phone, isMacOS: boolean) {
  const known = ["iphone-sync", "macos-native", "android-companion", "android-messages-web"];
  const phone = local ?? cloud;
  if (isMacOS) {
    if (stored) return known.includes(stored) ? stored : "macos-native";
    return phone === "android" ? "android-companion" : "macos-native";
  }
  if (stored && known.includes(stored)) return stored;
  if (phone === "android") return "android-companion";
  if (phone === "iphone") return "iphone-sync";
  return null;
}

describe("chosenImportSource (BACKLOG-3418)", () => {
  const cases: [string | undefined, Phone, Phone, boolean][] = [];
  for (const stored of STORED)
    for (const local of PHONES)
      for (const cloud of PHONES)
        for (const isMacOS of [false, true]) cases.push([stored, local, cloud, isMacOS]);

  it.each(cases)("stored=%s local=%s cloud=%s mac=%s", (stored, local, cloud, isMacOS) => {
    expect(
      chosenImportSource({ stored, localPhone: local, cloudPhone: cloud, isMacOS }),
    ).toBe(expected(stored, local, cloud, isMacOS));
  });

  it("Windows: nothing chosen is null, not a platform default", () => {
    expect(chosenImportSource({ stored: undefined, localPhone: null, cloudPhone: undefined, isMacOS: false })).toBeNull();
  });

  it("the Store reviewer shape (iPhone phone type, Google Messages stored) is not an iPhone choice", () => {
    expect(
      chosenImportSource({ stored: "android-messages-web", localPhone: "iphone", cloudPhone: "iphone", isMacOS: false }),
    ).toBe("android-messages-web");
  });

  it("reads the phone type only when the stored value does not settle it", () => {
    expect(chosenImportSourceNeedsPhoneType("iphone-sync", false)).toBe(false);
    expect(chosenImportSourceNeedsPhoneType("some-future-source", false)).toBe(true);
    expect(chosenImportSourceNeedsPhoneType(undefined, false)).toBe(true);
    expect(chosenImportSourceNeedsPhoneType("some-future-source", true)).toBe(false);
    expect(chosenImportSourceNeedsPhoneType(undefined, true)).toBe(true);
  });
});
