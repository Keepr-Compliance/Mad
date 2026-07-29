/**
 * Contact Reader Service (Android Companion)
 * Reads contacts from the Android device using expo-contacts.
 *
 * BACKLOG-1449: Sync Android contacts to desktop via companion app
 *
 * Uses expo-contacts to query the Android Contacts content provider.
 * Reads: name, phone numbers, email addresses, company, title.
 * Returns contacts formatted as SyncContact for transmission to the desktop.
 */

import * as Contacts from "expo-contacts";
import type { SyncContact, ContactPhone, ContactEmail } from "../types/contacts";

/**
 * Read all contacts from the Android device.
 *
 * Requests the minimal fields needed for sync (name, phone, email,
 * company, title) to avoid reading unnecessary data like photos.
 *
 * @returns Array of SyncContact objects ready for syncing
 */
export async function readContacts(): Promise<SyncContact[]> {
  let { status } = await Contacts.getPermissionsAsync();

  if (status !== "granted") {
    // Try requesting permission through expo-contacts (may differ from system permission)
    const request = await Contacts.requestPermissionsAsync();
    status = request.status;
  }

  if (status !== "granted") {
    console.log("[ContactReader] Contacts permission not granted");
    return [];
  }

  console.log("[ContactReader] Reading contacts from device...");

  const { data } = await Contacts.getContactsAsync({
    fields: [
      Contacts.Fields.FirstName,
      Contacts.Fields.LastName,
      Contacts.Fields.PhoneNumbers,
      Contacts.Fields.Emails,
      Contacts.Fields.Company,
      Contacts.Fields.JobTitle,
    ],
  });

  if (!data || data.length === 0) {
    console.log("[ContactReader] No contacts found on device");
    return [];
  }

  const mapped = data.map((c) => mapToSyncContact(c));

  // BACKLOG-2208: guard genuinely id-less contacts. Although getContactsAsync is
  // typed to return `ExistingContact` (guaranteed `id`), runtime data from some
  // OEM providers can still carry a missing/blank id. The desktop dedups on
  // `android-{deviceId}-{contact.id}`, so an id-less contact would collapse to
  // `android-{deviceId}-undefined` — colliding every id-less contact into ONE
  // record and, worse, sharing a single fingerprint key on the diff map (churn).
  // Skipping them is the behavior consistent with the desktop's keying.
  const contacts = mapped.filter(
    (c) => typeof c.id === "string" && c.id.trim().length > 0
  );
  const skipped = mapped.length - contacts.length;
  if (skipped > 0) {
    console.warn(
      `[ContactReader] Skipped ${skipped} contact(s) with a missing/blank id`
    );
  }

  console.log(
    `[ContactReader] Read ${data.length} raw contacts -> ${contacts.length} mapped (${skipped} skipped: no id)`
  );

  return contacts;
}

/**
 * Build a display name from available contact fields.
 *
 * Fallback chain:
 *   1. Composite name (from the contacts provider)
 *   2. firstName + lastName (requested explicitly)
 *   3. Company / organization name
 *   4. First phone number on the contact
 *   5. "Unknown Contact" as last resort
 */
function buildDisplayName(contact: Contacts.Contact): string {
  if (contact.name && contact.name.trim().length > 0) {
    return contact.name.trim();
  }

  const first = contact.firstName?.trim() ?? "";
  const last = contact.lastName?.trim() ?? "";
  const fullName = `${first} ${last}`.trim();
  if (fullName.length > 0) {
    return fullName;
  }

  if (contact.company && contact.company.trim().length > 0) {
    return contact.company.trim();
  }

  const firstPhone = (contact.phoneNumbers ?? []).find(
    (p) => p.number != null && p.number.trim().length > 0
  );
  if (firstPhone?.number) {
    return firstPhone.number.trim();
  }

  return "Unknown Contact";
}

/**
 * Map an expo-contacts contact to our SyncContact format.
 *
 * The parameter is `ExistingContact` (not the base `Contact`) because
 * `getContactsAsync` returns `ExistingContact[]` — contacts read back from the
 * OS carry a guaranteed, immutable `id: string`. That id is the stable key the
 * desktop dedups on (`android-{deviceId}-{id}`), so it comes straight from the
 * provider rather than a synthesized fallback.
 */
function mapToSyncContact(contact: Contacts.ExistingContact): SyncContact {
  const phones: ContactPhone[] = (contact.phoneNumbers ?? [])
    .filter((p) => p.number != null && p.number.trim().length > 0)
    .map((p) => ({
      number: p.number!,
      label: p.label ?? undefined,
    }));

  const emails: ContactEmail[] = (contact.emails ?? [])
    .filter((e) => e.email != null && e.email.trim().length > 0)
    .map((e) => ({
      address: e.email!,
      label: e.label ?? undefined,
    }));

  return {
    id: contact.id,
    displayName: buildDisplayName(contact),
    phones,
    emails,
    company: contact.company ?? undefined,
    title: contact.jobTitle ?? undefined,
  };
}
