/**
 * Contact Types (Android Companion)
 * Type definitions for contacts synced from the Android device to the desktop.
 *
 * BACKLOG-1449: Sync Android contacts to desktop via companion app
 */

// ============================================
// CONTACT TYPES
// ============================================

/**
 * A phone number entry from the Android contacts provider.
 */
export interface ContactPhone {
  /** Phone number as stored on the device */
  number: string;
  /** Android label (e.g., "mobile", "home", "work") */
  label?: string;
}

/**
 * An email address entry from the Android contacts provider.
 */
export interface ContactEmail {
  /** Email address */
  address: string;
  /** Android label (e.g., "home", "work") */
  label?: string;
}

/**
 * A single contact to sync from Android to the desktop.
 * Contains the core fields needed for contact matching and display.
 */
export interface SyncContact {
  /**
   * `ContactsContract.Contacts._ID` from the Android contacts provider.
   *
   * BACKLOG-2407 — STABLE ON ONE DEVICE, NOT ACROSS DEVICES. This was previously
   * documented as "Stable contact ID from the Android contacts provider", which
   * is wrong as written and would mislead anyone who built on it: Android's own
   * platform documentation designates `LOOKUP_KEY` as the sync-stable identifier
   * and `_ID` as explicitly not one. `_ID` is a row id — it survives edits on
   * THIS phone and nothing else. It remains the value the desktop keys on
   * (`android-{deviceId}-{id}`); nothing in this task changes that.
   */
  id: string;
  /**
   * `ContactsContract.Contacts.LOOKUP_KEY` — the identifier Android designates
   * as sync/device-stable (BACKLOG-2407). CAPTURED, MATCHED ON BY NOTHING.
   *
   * OPTIONAL, and structurally so rather than as an OEM quirk: expo-contacts'
   * native reader emits the field unconditionally (`Contact.kt:335`) but only
   * ASSIGNS it inside the `StructuredName.CONTENT_ITEM_TYPE` branch
   * (`Contact.kt:89`) — so a contact with no structured-name row, meaning an
   * organization-only or phone-only record, has no lookup key by construction.
   * It is also absent from the `expo-contacts@55.0.9` declarations
   * (`Contacts.d.ts:377-382` declares only `id`), so it is read through a narrow
   * runtime accessor rather than asserted with a cast.
   *
   * ⚠️ CAPTURING THIS ALONE DOES NOT SURVIVE A DEVICE SWAP. The desktop key is
   * `android-{deviceId}-{id}`, and `deviceId` is a DESKTOP-minted per-pairing
   * UUID re-minted on a fresh pairing. See the decision block in
   * localSyncService.ts where that key is built.
   */
  lookupKey?: string;
  /** Display name (first + last or organization fallback) */
  displayName: string;
  /** Phone numbers associated with the contact */
  phones: ContactPhone[];
  /** Email addresses associated with the contact */
  emails: ContactEmail[];
  /** Company / organization name */
  company?: string;
  /** Job title */
  title?: string;
}
