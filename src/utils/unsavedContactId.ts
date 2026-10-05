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
