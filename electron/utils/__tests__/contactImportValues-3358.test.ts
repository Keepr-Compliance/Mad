/**
 * @jest-environment node
 *
 * BACKLOG-3358 — `shapeImportValues`, pure.
 *
 * The handler suite (`contact-handlers.importBadValues-3358.test.ts`) proves
 * the stored result on real address-book rows. This file pins the shaper's own
 * rules where a handler test cannot reach them cheaply: non-string and blank
 * entries in the arrays, the surrogate boundary, the scalar-only record, and
 * exactly which records count as adjusted.
 */

import {
  addImportAdjustments,
  adjustedFieldNames,
  emptyImportAdjustmentCounts,
  isUsableImportEmail,
  isUsableImportPhone,
  shapeImportValues,
} from "../contactImportValues";
import { CONTACT_FIELD_MAX_LENGTH, validateContactData } from "../validation";

describe("usable values", () => {
  it.each([
    ["avery@example.com", true],
    ["  avery@example.com ", true],
    ["avery@example.com.", true],
    ["name@localhost", false],
    ["avery@localhost.", false],
    ["", false],
    ["   ", false],
    ["a".repeat(243) + "@example.com", false], // 255
    ["a".repeat(242) + "@example.com", true], // 254
  ])("email %j -> %s", (value, expected) => {
    expect(isUsableImportEmail(value)).toBe(expected);
  });

  it.each([
    ["+14155550142", true],
    ["5".repeat(50), true],
    [" " + "5".repeat(50) + " ", true],
    ["5".repeat(51), false],
    ["", false],
  ])("phone %j -> %s", (value, expected) => {
    expect(isUsableImportPhone(value)).toBe(expected);
  });

  it("non-strings are never usable", () => {
    for (const v of [null, undefined, 42, {}, ["avery@example.com"]]) {
      expect(isUsableImportEmail(v)).toBe(false);
      expect(isUsableImportPhone(v)).toBe(false);
    }
  });
});

describe("ordering", () => {
  it("usable first, the rest in source order; non-strings and blanks kept, never removed", () => {
    const shaped = shapeImportValues({
      allEmails: ["name@localhost", 7, "", "avery@example.com", "b@localhost", "jordan@example.com"] as unknown as string[],
    });
    expect(shaped.allEmails).toEqual([
      "avery@example.com",
      "jordan@example.com",
      "name@localhost",
      7,
      "",
      "b@localhost",
    ]);
    expect(shaped.forValidation).toMatchObject({ email: "avery@example.com" });
  });

  it("the scalar given to the validator is the first usable value, trimmed", () => {
    const shaped = shapeImportValues({
      email: "name@localhost",
      allEmails: ["name@localhost", "  avery@example.com "],
    });
    expect((shaped.forValidation as { email: unknown }).email).toBe("avery@example.com");
    // The array value is left as the source holds it; the writer normalises it.
    expect(shaped.allEmails).toEqual(["  avery@example.com ", "name@localhost"]);
  });

  it("no usable value: scalar is null, every value kept in source order", () => {
    const shaped = shapeImportValues({
      email: "name@localhost",
      allEmails: ["name@localhost", "b@localhost"],
      phone: "5".repeat(51),
      allPhones: ["5".repeat(51)],
    });
    expect(shaped.forValidation).toMatchObject({ email: null, phone: null });
    expect(shaped.allEmails).toEqual(["name@localhost", "b@localhost"]);
    expect(shaped.allPhones).toEqual(["5".repeat(51)]);
    // ... and the validator now accepts the record.
    expect(() => validateContactData(shaped.forValidation, false)).not.toThrow();
  });

  it("an empty array with a scalar holds that one value, trimmed (message-derived rows)", () => {
    const shaped = shapeImportValues({ phone: "  +14155550142 ", allPhones: [] });
    expect(shaped.allPhones).toEqual(["+14155550142"]);
    expect(shaped.forValidation).toMatchObject({ phone: "+14155550142" });
  });

  it("nothing at all: empty arrays, null scalars, no adjustment", () => {
    const shaped = shapeImportValues({ name: "Pat Riverton" });
    expect(shaped.allEmails).toEqual([]);
    expect(shaped.allPhones).toEqual([]);
    expect(shaped.forValidation).toMatchObject({ email: null, phone: null });
    expect(Object.values(shaped.adjustments).some(Boolean)).toBe(false);
  });

  it("does not mutate the input record or its arrays", () => {
    const allEmails = ["name@localhost", "avery@example.com"];
    const record = { name: "N".repeat(201), email: "name@localhost", allEmails };
    shapeImportValues(record);
    expect(record).toEqual({ name: "N".repeat(201), email: "name@localhost", allEmails: ["name@localhost", "avery@example.com"] });
    expect(record.allEmails).toBe(allEmails);
  });
});

describe("free text", () => {
  const cut = (field: "name" | "company" | "title", value: unknown) =>
    (shapeImportValues({ [field]: value }).forValidation as Record<string, unknown>)[field];

  it.each(["name", "company", "title"] as const)("%s: at the limit kept, one over cut to the limit", (field) => {
    const max = CONTACT_FIELD_MAX_LENGTH[field];
    expect(cut(field, "X".repeat(max))).toBe("X".repeat(max));
    expect(cut(field, "X".repeat(max + 1))).toBe("X".repeat(max));
  });

  it("an emoji straddling the limit is dropped whole, not split", () => {
    const value = "N".repeat(199) + "\u{1F600}"; // 201 UTF-16 units
    expect(cut("name", value)).toBe("N".repeat(199));
  });

  it("an emoji ending exactly at the limit is kept", () => {
    const value = "N".repeat(198) + "\u{1F600}" + "Z"; // 201 units, pair at 198-199
    expect(cut("name", value)).toBe("N".repeat(198) + "\u{1F600}");
  });

  it("surrounding whitespace does not count toward the limit, and a cut leaves no trailing space", () => {
    expect(cut("title", "  " + "T".repeat(100) + "  ")).toBe("  " + "T".repeat(100) + "  ");
    expect(cut("title", "T".repeat(99) + " " + "U".repeat(5))).toBe("T".repeat(99));
  });

  it("non-strings and absent fields pass through untouched, so the validator still refuses a wrong type", () => {
    const shaped = shapeImportValues({ name: 42 as unknown as string });
    expect((shaped.forValidation as Record<string, unknown>).name).toBe(42);
    expect("company" in (shaped.forValidation as object)).toBe(false);
    expect(() => validateContactData(shaped.forValidation, false)).toThrow(/name must be a string/);
  });
});

describe("what counts as adjusted", () => {
  const adj = (record: Record<string, unknown>) => shapeImportValues(record).adjustments;

  it("unusable FIRST value with a usable later one: reordered", () => {
    expect(adj({ allEmails: ["name@localhost", "avery@example.com"] })).toMatchObject({ emailReordered: true, noUsableEmail: false });
    expect(adj({ allPhones: ["5".repeat(51), "+14155550142"] })).toMatchObject({ phoneReordered: true, noUsablePhone: false });
  });

  it("no usable value: noUsable, not reordered", () => {
    expect(adj({ allEmails: ["name@localhost"] })).toMatchObject({ emailReordered: false, noUsableEmail: true });
  });

  it("an unusable value in a LATER position only: not adjusted (it imported before this change)", () => {
    expect(Object.values(adj({ allEmails: ["avery@example.com", "name@localhost"] })).some(Boolean)).toBe(false);
  });

  it("a leading blank is skipped when deciding what came first", () => {
    expect(Object.values(adj({ allEmails: ["", "avery@example.com", "name@localhost"] })).some(Boolean)).toBe(false);
  });

  it("a padded usable first value is not adjusted", () => {
    expect(Object.values(adj({ allEmails: ["  avery@example.com ", "name@localhost"] })).some(Boolean)).toBe(false);
  });

  it("counts add up per record and the field list is names only, in a fixed order", () => {
    const counts = emptyImportAdjustmentCounts();
    addImportAdjustments(counts, adj({ name: "N".repeat(201), allPhones: ["5".repeat(51)] }));
    addImportAdjustments(counts, adj({ title: "T".repeat(101), allEmails: ["name@localhost", "avery@example.com"] }));
    addImportAdjustments(counts, adj({ name: "Pat Riverton", allEmails: ["avery@example.com"] }));
    expect(counts).toEqual({
      recordsAdjusted: 2,
      namesCut: 1,
      companiesCut: 0,
      titlesCut: 1,
      emailsReordered: 1,
      phonesReordered: 0,
      noUsableEmail: 0,
      noUsablePhone: 1,
    });
    expect(adjustedFieldNames(counts)).toEqual(["name", "title", "email", "phone"]);
    expect(adjustedFieldNames(emptyImportAdjustmentCounts())).toEqual([]);
  });
});
