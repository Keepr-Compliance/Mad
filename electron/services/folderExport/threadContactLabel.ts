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
 * for display (`+12065550103` -> `+1 (206) 555-0103`) and returns iMessage email
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
 * A formatted phone is not a safe filename: `+1 (206) 555-0103` carries `+`,
 * spaces and parentheses. The old code dodged that by naming the file after a
 * word instead of after the person. The number survives sanitisation perfectly
 * well — `1_206_555-0103` is still recognisably that line — so there was never a
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

/**
 * ===========================================================================
 * BACKLOG-2757 — WHAT A THREAD IS CALLED WHEN THE HANDLE IS NOT ONE PERSON
 * ===========================================================================
 *
 * Two saved contacts sharing one phone number is ordinary: a household line, an
 * office line, a couple. BACKLOG-2619/2556 exist because two people share an
 * office line, and the product's rule is that **a shared identifier is not
 * evidence of one person**. The export used to assume the opposite — it resolved
 * the handle to whichever contact SQLite happened to return last, put that name
 * on the PDF, and wrote it into a FILE NAME inside the audit package. The wrong
 * person's name, durable on a filesystem, in an audit artifact.
 *
 * Founder decision (2026-08-20, settled):
 *
 *   - one contact matches -> unchanged, name in the label and the filename;
 *   - more than one matches -> the LABEL says so with an "or", and the FILENAME
 *     carries NO name at all, only the index and the number.
 *
 * The thread is never split (that would duplicate one real conversation into two
 * pretend-attributed ones — the grouping is faithful to Messages and correct)
 * and never blocks the export (a shared office line is routine and often
 * unresolvable).
 *
 * WHY THE FILENAME DROPS THE NAME RATHER THAN CARRYING BOTH: the filename is the
 * part that survives. Putting "Chris_or_Dana" on disk still asserts a person, in
 * the one place we cannot correct later. The number is the thing we actually
 * know, so the file is named after it.
 *
 * ---------------------------------------------------------------------------
 * WHERE BACKLOG-2816 PLUGS IN
 * ---------------------------------------------------------------------------
 * 2816 (group chat names in the export, the submission, and the file name)
 * hard-depends on 2814 importing `chat.display_name` and is NOT implemented
 * here. When it is: it becomes ONE new branch at the top of `threadNaming`'s
 * precedence, above the ambiguity branch, setting both `label` and
 * `fileSegment` from the chat name in the same step —
 *
 *     if (chatName) return { label: chatName,
 *                            fileSegment: fileSafeContactLabel(chatName) };
 *
 * — plus one field on `ThreadNamingInput`. It must land here and nowhere else:
 * every surface that names a thread already routes through this function, so
 * one branch reaches the PDF header, the summary index, the combined one-PDF
 * section and the filename together. The sanitisation 2816 asks for ("the name
 * is user-typed text") is already what `fileSafeContactLabel` does.
 */

/** What a thread is called, in both places it is called something. */
export interface ThreadNaming {
  /** The human label: PDF header, summary index row, combined-PDF section. */
  label: string;
  /** The filename component, already filesystem-safe. */
  fileSegment: string;
  /** True when the handle matched more than one contact. */
  ambiguous: boolean;
}

export interface ThreadNamingInput {
  contact: ThreadContact;
  isGroupChat: boolean;
  /**
   * Every distinct contact name this thread's handle resolves to, in the
   * resolver's declared order, AFTER scoping. Length <= 1 is the ordinary case
   * and behaves exactly as it did before BACKLOG-2757.
   */
  matchedNames?: readonly string[];
}

/**
 * Join names the way a person would read them: "A or B", "A, B or C".
 *
 * Not "A/B" and not "A & B" — both read as one compound party. "or" is the only
 * join that says *we do not know which of these it is*, which is the true state.
 */
export function joinAmbiguousNames(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

/**
 * THE naming decision for a text thread. Precedence, top to bottom:
 *
 *   1. (BACKLOG-2816 seam — group chat name, not implemented, see above)
 *   2. AMBIGUOUS: >1 contact on this handle -> label `<handle> — A or B`,
 *      filename = the handle, no name.
 *   3. GROUP CHAT with no resolvable party -> "Group Chat".
 *   4. Exactly one name -> that name. Unchanged from BACKLOG-2463.
 *   5. No name -> the formatted handle. Unchanged from BACKLOG-2463.
 *
 * Rules 3-5 are byte-for-byte what shipped before; only rule 2 is new, and it
 * fires only when the resolver found more than one contact.
 */
export function threadNaming({
  contact,
  isGroupChat,
  matchedNames,
}: ThreadNamingInput): ThreadNaming {
  const names = matchedNames ?? [];

  if (names.length > 1) {
    // The handle, formatted for a human, with no name attached — the same chain
    // an unresolved thread already uses, called rather than restated.
    const handleLabel = contactDisplayLabel({ name: null, phone: contact.phone });
    return {
      label: `${handleLabel} — ${joinAmbiguousNames(names)}`,
      fileSegment: fileSafeContactLabel(handleLabel),
      ambiguous: true,
    };
  }

  const label =
    isGroupChat && threadContactIsUnresolved(contact)
      ? GROUP_CHAT_LABEL
      : threadContactLabel(contact);

  return { label, fileSegment: fileSafeContactLabel(label), ambiguous: false };
}

/** Drop the separator characters `sanitizeFileName` may leave at either end. */
function trimSeparators(value: string): string {
  return value.replace(/^[_\-. ]+/, "").replace(/[_\-. ]+$/, "");
}
