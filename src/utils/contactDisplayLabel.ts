/**
 * What a contact is CALLED on screen — RENDERER MIRROR.
 *
 * ===========================================================================
 * THIS IS A MIRROR. CANONICAL COPY: `electron/utils/contactDisplayLabel.ts`
 * ===========================================================================
 *
 * BACKLOG-2461. Read the canonical file for the reasoning behind every tier of
 * the chain, why the placeholder is "No name" rather than "Unknown", and why
 * the legacy sentinels are treated as empty.
 *
 * The rule cannot simply be imported: `tsconfig.electron.json` sets
 * `rootDir: "./electron"`, so nothing under `electron/` may import from `src/`,
 * and importing the other way pulls main-process modules into the renderer
 * bundle. The same constraint produced `contactNameCompat.ts`.
 *
 * What keeps the two copies honest is not this comment.
 * `src/utils/__tests__/contactDisplayLabel.parity.test.ts` loads BOTH and asserts an
 * identical string for every case in a shared table.
 */

import { formatPhoneNumber } from "./phoneNormalization";

/** Shown only when there is no name, no organisation, no phone and no email. */
export const NO_NAME_PLACEHOLDER = "No name";

/**
 * Shown when there is no contact RECORD at all — a suggestion whose contact
 * could not be loaded, for instance.
 *
 * This is a genuinely different condition from `NO_NAME_PLACEHOLDER`, and the
 * distinction is the point. "No name" says: we have this person, one field is
 * empty. "Unknown Contact" says: we could not load this person, so we cannot
 * tell you anything about them — including whether they have a name.
 *
 * BACKLOG-2461 was about the first condition being described with the second
 * condition's words.
 */
export const UNRESOLVED_CONTACT_LABEL = "Unknown Contact";

/**
 * See the canonical copy. Matched EXACTLY (trimmed, case-insensitive).
 *
 * "LEGACY" is a misnomer kept for symmetry with the canonical file: five live
 * write paths still produce this literal, so these are permanent, not a shim.
 */
const LEGACY_NO_NAME_SENTINELS = new Set(["unknown", "unknown contact"]);

export interface ContactLabelParts {
  /** `display_name`, or the legacy `name` — may hold a legacy sentinel. */
  name?: string | null;
  /** `company` / organisation. */
  organization?: string | null;
  /** Primary phone. E.164 (`+14155550134`) or raw; formatted for display here. */
  phone?: string | null;
  /** Primary email. */
  email?: string | null;
}

/** The contact's actual name, or "" when there isn't one. */
export function realContactName(name?: string | null): string {
  const trimmed = (name || "").trim();
  if (!trimmed) return "";
  if (LEGACY_NO_NAME_SENTINELS.has(trimmed.toLowerCase())) return "";
  return trimmed;
}

/**
 * The label to show for a contact.
 *
 * Order: name -> organisation -> formatted phone -> email -> "No name".
 *
 * DISPLAY ONLY. Never write this to `contacts.display_name` — see the canonical
 * copy for what a persisted fallback breaks.
 */
export function contactDisplayLabel(parts: ContactLabelParts): string {
  const name = realContactName(parts.name);
  if (name) return name;

  const organization = (parts.organization || "").trim();
  if (organization) return organization;

  const phone = formatPhoneNumber(parts.phone).trim();
  if (phone) return phone;

  const email = (parts.email || "").trim();
  if (email) return email;

  return NO_NAME_PLACEHOLDER;
}

/**
 * The label for a transaction-contact row, mapped from its `contact_*` columns.
 *
 * See the canonical copy: every field of `ContactLabelParts` is optional, so an
 * unmapped row is structurally assignable to it and silently yields "No name".
 * This mapping is the thing callers cannot get wrong.
 */
export function labelForTransactionContact(row: {
  contact_name?: string | null;
  contact_company?: string | null;
  contact_phone?: string | null;
  contact_email?: string | null;
}): string {
  return contactDisplayLabel({
    name: row.contact_name,
    organization: row.contact_company,
    phone: row.contact_phone,
    email: row.contact_email,
  });
}

/**
 * Convenience wrapper for the renderer's contact shape.
 *
 * The primary phone/email are the deprecated flat fields when present, else the
 * first of the array fields — the same precedence the export query uses
 * (`transactionContactDbService`: `is_primary = 1` first, then any).
 */
export function labelForContact(contact: {
  display_name?: string | null;
  name?: string | null;
  company?: string | null;
  phone?: string | null;
  email?: string | null;
  allPhones?: string[];
  allEmails?: string[];
}): string {
  return contactDisplayLabel({
    name: contact.display_name || contact.name,
    organization: contact.company,
    phone: contact.phone || contact.allPhones?.[0],
    email: contact.email || contact.allEmails?.[0],
  });
}
