/**
 * Live FK bug (2026-10-04): a person built at READ time — found in texts
 * (`msg_…`, incl. Google Messages `msg_tel_…`) or in email (`email_…`,
 * BACKLOG-1717) — has no `contacts` row. Wherever such a record shows up, the
 * picker must treat it as an address-book row: picking it imports it first
 * (contacts:import) and selects the SAVED id. Selecting the made-up id put it
 * in transaction_contacts and the create failed with "FOREIGN KEY constraint
 * failed".
 */
export function isUnsavedContactId(id: string | null | undefined): boolean {
  return typeof id === "string" && (id.startsWith("msg_") || id.startsWith("email_"));
}

/**
 * SR: THE one rule for "this record has no contacts row yet" — a made-up id
 * (msg_ / email_) OR the read-time is_message_derived flag. The picker, the
 * wizard and the contact form all ask this.
 */
export function isUnsavedContact(
  contact: { id?: string | null; is_message_derived?: number | boolean | null } | null | undefined,
): boolean {
  if (!contact) return false;
  return isUnsavedContactId(contact.id) || contact.is_message_derived === 1 || contact.is_message_derived === true;
}
