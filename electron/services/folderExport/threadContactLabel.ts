/**
 * What a TEXT THREAD is called — on the page and in the exported file NAME.
 *
 * BACKLOG-2463, deferred from BACKLOG-2461 as an SR condition of merge.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * BACKLOG-2461 decided, once, what a contact is called: name -> organisation ->
 * formatted phone -> email -> "No name". It applied that to the contact surfaces
 * and to the audit summary PDF, and left the text-thread export alone to keep
 * the diff reviewable. So the text export kept the old answer, and for a while
 * one product had two answers to one question.
 *
 * This file does NOT contain a second copy of that decision. It calls
 * `contactDisplayLabel`. A thread contact is a `{ phone, name }` pair harvested
 * from message participants — it has no organisation column and no separate
 * email column — so the chain collapses to name -> formatted handle -> "No
 * name", which is the same chain, not a variant of it. Re-deriving the order
 * here is exactly how the two paths diverged the first time.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FILENAME IS THE PART THAT MATTERED
 * ---------------------------------------------------------------------------
 * `folderExportService` wrote `Unknown_Contact` into the NAME of a PDF inside the
 * audit package. A wrong label on a screen is a UI bug and dies when the screen
 * re-renders. A wrong label in a filename is handed to the broker, sits in their
 * folder, and survives every later fix. The export already HOLDS the number —
 * the phone is the thread key — so the file could always have been named after
 * the number instead of after the word "Unknown".
 */

import { contactDisplayLabel, NO_NAME_PLACEHOLDER } from "../../utils/contactDisplayLabel";
import { sanitizeFileName } from "./attachmentHelpers";

/**
 * A thread's other party, as `getThreadContact` and the group-chat participant
 * resolver produce it.
 *
 * `phone` is a raw handle: an E.164 number, a bare digit run, or an iMessage
 * email address. `""` means the thread carried no resolvable handle at all — not
 * that the handle is unknown to us, but that the messages never contained one.
 */
export interface ThreadContact {
  phone?: string | null;
  name?: string | null;
}

/** A thread with three or more parties is named for the chat, not for a person. */
export const GROUP_CHAT_LABEL = "Group Chat";

/**
 * The label for a text thread's other party.
 *
 * Delegates to the BACKLOG-2461 chain. `contactDisplayLabel` formats the handle
 * for display (`+12065551234` -> `+1 (206) 555-1234`) and returns iMessage email
 * handles untouched, and it reads the legacy `"Unknown"` / `"Unknown Contact"`
 * sentinels as "no name" — which matters here, because the phone->name map is
 * built from `contacts.display_name` and five live import paths still write that
 * literal into the column.
 */
export function threadContactLabel(contact: ThreadContact): string {
  return contactDisplayLabel({ name: contact.name, phone: contact.phone });
}

/** True when the thread yielded neither a name nor any handle to fall back to. */
export function threadContactIsUnresolved(contact: ThreadContact): boolean {
  return !(contact.name || "").trim() && !(contact.phone || "").trim();
}

/**
 * Windows refuses these as a filename BASE, with or without an extension, and
 * case-insensitively: `CON.pdf` is as illegal as `con`. Nothing in a contact's
 * name or number produces one today — the export prefixes `text_001_` — but this
 * function is a filename-component sanitiser and is only worth trusting if it is
 * correct standing alone.
 */
const WINDOWS_RESERVED_BASENAMES = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/**
 * How much of the filename the contact may claim.
 *
 * The full name is `text_<NNN>_<contact>_<YYYY-MM-DD>.pdf` — 9 + contact + 15
 * characters. At 60 that is 84, which leaves room under Windows' 260-character
 * MAX_PATH for a deep export destination. `sanitizeFileName`'s own 100-character
 * cap is the general limit; this is the tighter one for the part we choose.
 */
const MAX_CONTACT_SEGMENT = 60;

/**
 * Make a display label safe to put in a filename, WITHOUT reaching for "Unknown".
 *
 * A formatted phone is not a safe filename: `+1 (206) 555-1234` carries `+`,
 * spaces and parentheses. The old code dodged that by naming the file after a
 * word instead of after the person. The number survives sanitisation perfectly
 * well — `1_206_555-1234` is still recognisably that line — so there was never a
 * reason to discard it.
 *
 * Layered on `sanitizeFileName` (the sanitiser every other exported file already
 * goes through) so the export has ONE character policy, plus:
 *
 * - edges trimmed of `_ - . space`. Windows silently strips trailing dots and
 *   spaces, so a name ending in one is written to disk under a name that is not
 *   the name we asked for — and a leading `_` is just the `(` of `(206)` left
 *   behind as litter.
 * - the reserved device names above, defused by an `_` inserted before any
 *   extension, so `CON.pdf` becomes `CON_.pdf` and stays readable.
 * - the empty result — every character was punctuation — replaced by the
 *   sanitised terminal placeholder from the shared chain, so a contact we hold
 *   nothing about is filed under "No_name" and not under a word that claims we
 *   could not identify them at all.
 */
export function fileSafeContactLabel(label: string): string {
  // Truncate before trimming the edges: slicing afterwards can re-expose a
  // trailing separator at the cut point.
  const trimmed = trimSeparators(
    sanitizeFileName(label || "").substring(0, MAX_CONTACT_SEGMENT),
  );

  if (!trimmed) {
    return trimSeparators(sanitizeFileName(NO_NAME_PLACEHOLDER));
  }

  const dot = trimmed.lastIndexOf(".");
  const base = dot > 0 ? trimmed.substring(0, dot) : trimmed;
  const extension = dot > 0 ? trimmed.substring(dot) : "";
  if (WINDOWS_RESERVED_BASENAMES.has(base.toLowerCase())) {
    // Defuse before the extension, not after it: `CON.pdf` is as illegal as
    // `CON`, and `CON_.pdf` stays a name a person would recognise.
    return `${base}_${extension}`;
  }

  return trimmed;
}

/** Drop the separator characters `sanitizeFileName` may leave at either end. */
function trimSeparators(value: string): string {
  return value.replace(/^[_\-. ]+/, "").replace(/[_\-. ]+$/, "");
}
