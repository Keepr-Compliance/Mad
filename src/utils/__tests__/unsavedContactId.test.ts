/**
 * SR: ONE rule for "this record has no contacts row yet" — the picker, the
 * wizard and the contact form all ask isUnsavedContact. Mutations: the flag
 * leg dropped; the email_ prefix dropped; a saved contact flagged → red.
 */
import * as fs from "fs";
import * as path from "path";
import { isUnsavedContact, isUnsavedContactId } from "../unsavedContactId";

describe("isUnsavedContact", () => {
  it("a made-up id or the read-time flag; never a saved contact", () => {
    expect(isUnsavedContact({ id: "msg_tel_+15555550111" })).toBe(true);
    expect(isUnsavedContact({ id: "msg_dana whitlock", is_message_derived: 1 })).toBe(true);
    expect(isUnsavedContact({ id: "email_avery@example.com" })).toBe(true);
    expect(isUnsavedContact({ id: "ext-1", is_message_derived: true })).toBe(true);
    expect(isUnsavedContact({ id: "ext-2", is_message_derived: 1 })).toBe(true);
    expect(isUnsavedContact({ id: "550e8400-e29b-41d4-a716-446655440222", is_message_derived: 0 })).toBe(false); // pii-allow-uuid: invented
    expect(isUnsavedContact({ id: "550e8400-e29b-41d4-a716-446655440223" })).toBe(false); // pii-allow-uuid: invented
    expect(isUnsavedContact(null)).toBe(false);
    expect(isUnsavedContactId("msg_x")).toBe(true);
    expect(isUnsavedContactId(undefined)).toBe(false);
  });

  it("the contact form, the picker and the wizard use it (no inline copies of the rule)", () => {
    const root = path.join(__dirname, "..", "..");
    for (const f of ["components/contact/components/ContactFormModal.tsx", "components/shared/ContactSearchList.tsx", "components/audit/ContactAssignmentStep.tsx"]) {
      const src = fs.readFileSync(path.join(root, f), "utf8");
      expect([f, src.includes("isUnsavedContact(")]).toEqual([f, true]);
    }
    const modal = fs.readFileSync(path.join(root, "components/contact/components/ContactFormModal.tsx"), "utf8");
    expect(modal).not.toMatch(/isExternalContact = contact\?\.id\?\.startsWith\("msg_"\)/);
  });
});
