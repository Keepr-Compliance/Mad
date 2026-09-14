/**
 * @jest-environment node
 */
/**
 * BACKLOG-3193 — the write boundary for `contacts.source`, answered exactly.
 *
 * `toStorableContactSource` is the one function both doors ask what to store.
 * This table is its whole contract, written out BY VALUE rather than read from
 * the module's own constants: an expectation imported from the code under test
 * cannot fail.
 *
 * The rows that changed in BACKLOG-3193 are `email`, `sms` and `inferred`. The
 * `contacts.source` CHECK admits them, but a saved contact carrying one matches
 * no filter leaf, so the boundary now answers `null` for them — and each door
 * answers `null` the way it already did: `contacts:import` refuses,
 * `contacts:create` folds to `manual`.
 *
 * Wrong implementations this table goes red on, each run before it was written:
 * a refusal covering only `email`; mapping the three to `manual` instead of
 * refusing; and a fix that folds every persisted value to `manual`. A refusal
 * written into the import handler instead of here also goes red, because the
 * boundary would still return the three verbatim.
 */

import {
  MESSAGE_DERIVED_ONLY_SOURCES,
  PERSISTED_CONTACT_SOURCES,
  UNFILTERABLE_WHEN_SAVED_CONTACT_SOURCES,
  toStorableContactSource,
} from "../contactSourceVocabulary";

describe("toStorableContactSource (BACKLOG-3193)", () => {
  it("answers every input exactly, under both doors' fallbacks", () => {
    const inputs = [
      ...PERSISTED_CONTACT_SOURCES,
      "messages",
      "",
      "not_a_source",
      "SMS",
      "Outlook",
    ];
    const answers = Object.fromEntries(
      inputs.map((value) => [
        value,
        {
          importDoor: toStorableContactSource(value, "contacts_app"),
          createDoor: toStorableContactSource(value, "manual"),
        },
      ]),
    );

    expect(answers).toEqual({
      manual: { importDoor: "manual", createDoor: "manual" },
      contacts_app: { importDoor: "contacts_app", createDoor: "contacts_app" },
      android_sync: { importDoor: "android_sync", createDoor: "android_sync" },
      iphone: { importDoor: "iphone", createDoor: "iphone" },
      outlook: { importDoor: "outlook", createDoor: "outlook" },
      google_contacts: { importDoor: "google_contacts", createDoor: "google_contacts" },
      // BACKLOG-3193: admitted by the CHECK, found by no leaf once saved.
      email: { importDoor: null, createDoor: null },
      sms: { importDoor: null, createDoor: null },
      inferred: { importDoor: null, createDoor: null },
      // BACKLOG-2481: the synthetic text-thread value has a destination.
      messages: { importDoor: "manual", createDoor: "manual" },
      // Absent: each door's own fallback, deliberately different.
      "": { importDoor: "contacts_app", createDoor: "manual" },
      // Unrecognised, including a known value in the wrong case.
      not_a_source: { importDoor: null, createDoor: null },
      SMS: { importDoor: null, createDoor: null },
      Outlook: { importDoor: null, createDoor: null },
    });
  });

  it("treats null and undefined as absent", () => {
    expect(toStorableContactSource(undefined, "contacts_app")).toBe("contacts_app");
    expect(toStorableContactSource(null, "manual")).toBe("manual");
  });
});

describe("UNFILTERABLE_WHEN_SAVED_CONTACT_SOURCES (BACKLOG-3193)", () => {
  it("is exactly email, sms and inferred", () => {
    expect([...UNFILTERABLE_WHEN_SAVED_CONTACT_SOURCES].sort()).toEqual(["email", "inferred", "sms"]);
  });

  /**
   * DERIVED from the list the filter-coverage test pins, so the two cannot
   * drift — and it does not SHRINK the persisted vocabulary, which mirrors the
   * CHECK in `schema.sql` and is compared against it value for value.
   */
  it("is the persisted part of MESSAGE_DERIVED_ONLY_SOURCES, and leaves the persisted list whole", () => {
    expect([...UNFILTERABLE_WHEN_SAVED_CONTACT_SOURCES].sort()).toEqual(
      PERSISTED_CONTACT_SOURCES.filter((v) => MESSAGE_DERIVED_ONLY_SOURCES.includes(v)).sort(),
    );
    expect(PERSISTED_CONTACT_SOURCES).toHaveLength(9);
    for (const value of ["email", "sms", "inferred"]) {
      expect(PERSISTED_CONTACT_SOURCES).toContain(value);
    }
  });
});
