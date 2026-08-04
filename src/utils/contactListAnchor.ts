/**
 * Contact list anchoring — keeping the user's place across an action that
 * changes the list underneath them (BACKLOG-2459).
 *
 * ===========================================================================
 * WHY AN OFFSET IS THE WRONG THING TO SAVE
 * ===========================================================================
 * The obvious fix for "closing a contact loses my place" is to save the scroll
 * offset and put it back. That assumes the list is the same on the way out as it
 * was on the way in — and on THIS list the assumption is broken by design. The
 * actions a user takes on an open contact are precisely the ones that change the
 * list: linking two records collapses two rows into one, importing adds one,
 * unlinking splits one into two. So the common path is: scroll down, act on a
 * person, and the list under you is now different.
 *
 * Restoring offset 8400 after two rows merged puts the user in front of a
 * DIFFERENT person, in a position that looks deliberate. That is worse than
 * returning to the top, which at least reads as a reset.
 *
 * An offset is a row number. A contact id is an identity. This module anchors on
 * the identity and treats position as the last resort, in four steps:
 *
 *   1. EXACT     the contact is still there -> go to it.
 *   2. SURVIVOR  it was consolidated away -> go to the row it was folded into.
 *                The user's attention was on that person; they still exist,
 *                under one row now. Landing there is part of SHOWING the merge —
 *                it connects the action to its result.
 *   3. NEIGHBOUR it is gone entirely (deleted, or unlinked and released) -> go to
 *                the nearest surviving row from the position it held. Not the top.
 *   4. NONE      nothing resolves -> the top.
 *
 * Every function here is pure: no DOM, no refs, no React. The component supplies
 * the current list and the measurements; this decides where to land.
 */

import type { ExtendedContact } from "../types/components";
import { contactEmailKeys, contactPhoneKeys } from "./contactPickerList";
import { namesAreCompatible } from "./contactNameCompat";

/** Which of the four rules produced the landing row. */
export type ContactAnchorMatch = "exact" | "survivor" | "neighbour" | "none";

export interface ContactAnchorResolution {
  /** Index into the list that was passed in, or -1 when nothing resolved. */
  index: number;
  /** The contact to land on, or null for `none`. */
  contact: ExtendedContact | null;
  match: ContactAnchorMatch;
}

/**
 * Everything captured at the moment the user opened a contact.
 *
 * Captured SYNCHRONOUSLY in the row's click handler rather than in an effect: on
 * narrow viewports the Contacts screen swaps the entire list subtree out for the
 * detail card in the same commit, so a layout effect would never run and there
 * would be nothing left to measure.
 */
export interface ContactListAnchor {
  /**
   * The contact object as it was when opened — not just its id. The survivor
   * rule needs its email/phone/name tokens, and after a merge the record itself
   * is gone from every list we could look it up in.
   */
  contact: ExtendedContact;
  /**
   * Ids of the rows that were visible, in render order. Only the NEIGHBOUR rule
   * reads this, and only when the contact has vanished without a survivor.
   */
  orderIds: string[];
  /**
   * Where the row sat inside the scroll container's viewport, in px
   * (`rowRect.top - containerRect.top`). Restoring this — rather than a raw
   * `scrollTop` — is what makes the row come back to the same place ON SCREEN,
   * which is what "stay put" means to the person looking at it.
   */
  viewportOffset: number;
}

/** Normalized display name, matching `contactPickerList`'s dedup key. */
function normalizeName(contact: ExtendedContact): string {
  return (contact.display_name || contact.name || "").trim().toLowerCase();
}

/**
 * An address-book row rather than a saved contact.
 *
 * The same predicate the Contacts screen uses to decide whether a row offers an
 * Import button, kept identical on purpose: the survivor rule below must agree
 * with the picker about which rows can be merged, and the picker's line is drawn
 * exactly here.
 */
function isExternalRow(contact: ExtendedContact): boolean {
  return contact.is_message_derived === 1 || contact.is_message_derived === true;
}

/**
 * Do these two records refer to the same person, by the SAME rules the picker
 * used to fold them together?
 *
 * This has to agree with `contactPickerList.assembleDedupedContactsWithEvidence`
 * or the survivor rule would look for the merged row using a different
 * definition of sameness than the one that merged it — and would find nothing
 * exactly when it matters most.
 */
export function contactsShareIdentity(a: ExtendedContact, b: ExtendedContact): boolean {
  const aEmails = contactEmailKeys(a);
  const bEmails = new Set(contactEmailKeys(b));
  if (aEmails.some((e) => bEmails.has(e))) return true;

  const aPhones = contactPhoneKeys(a);
  const bPhones = new Set(contactPhoneKeys(b));
  const sharesPhone = aPhones.some((p) => bPhones.has(p));
  if (sharesPhone && namesAreCompatible(normalizeName(a), normalizeName(b))) return true;

  // Name is a last-resort identity ONLY when neither side has a stronger token,
  // so two distinct people who happen to share a name are never conflated.
  if (aEmails.length === 0 && aPhones.length === 0 && bEmails.size === 0 && bPhones.size === 0) {
    const name = normalizeName(a);
    return !!name && name === normalizeName(b);
  }
  return false;
}

/**
 * Where to land in `visible` for the contact the user had open.
 *
 * `visible` must be the list AS RENDERED (post dedup, filter, search and the
 * frozen order), because the index this returns is used to find a row on screen.
 */
export function resolveContactAnchor(
  visible: ExtendedContact[],
  anchor: ContactListAnchor,
): ContactAnchorResolution {
  if (visible.length === 0) return { index: -1, contact: null, match: "none" };

  // 1. EXACT — the contact is still in the list under the same id.
  const exact = visible.findIndex((c) => c.id === anchor.contact.id);
  if (exact >= 0) return { index: exact, contact: visible[exact], match: "exact" };

  // 2. SURVIVOR — consolidated into another row. Importing an external contact
  //    also lands here: the DB row that replaces it has a new id but the same
  //    email/phone, which is the whole reason identity beats id here.
  //
  //    The SAVED-vs-SAVED case is excluded. The picker deliberately never merges
  //    two saved DB rows even when they share an email — that is pinned by
  //    `assembleDedupedContactsWithEvidence`'s own test — so if the user deletes
  //    saved contact A and saved contact B merely shares an address, no merge
  //    happened, and landing on B would assert one that the list never made.
  //    That case falls through to the neighbour rule, which claims nothing about
  //    identity at all.
  const anchorIsSaved = !isExternalRow(anchor.contact);
  const survivor = visible.findIndex(
    (c) => contactsShareIdentity(anchor.contact, c) && !(anchorIsSaved && !isExternalRow(c)),
  );
  if (survivor >= 0) return { index: survivor, contact: visible[survivor], match: "survivor" };

  // 3. NEIGHBOUR — gone entirely. Walk out from the slot it held: forward first
  //    (the row that closed the gap is the one now occupying that position),
  //    then backward.
  const previousIndex = anchor.orderIds.indexOf(anchor.contact.id);
  if (previousIndex >= 0) {
    const stillVisible = new Map<string, number>();
    visible.forEach((c, i) => {
      if (!stillVisible.has(c.id)) stillVisible.set(c.id, i);
    });
    for (let i = previousIndex + 1; i < anchor.orderIds.length; i++) {
      const at = stillVisible.get(anchor.orderIds[i]);
      if (at !== undefined) return { index: at, contact: visible[at], match: "neighbour" };
    }
    for (let i = previousIndex - 1; i >= 0; i--) {
      const at = stillVisible.get(anchor.orderIds[i]);
      if (at !== undefined) return { index: at, contact: visible[at], match: "neighbour" };
    }
  }

  // 4. NONE.
  return { index: -1, contact: null, match: "none" };
}

/**
 * The scroll position that puts `rowTop` back at `viewportOffset` inside the
 * container, given the container's current `scrollTop`.
 *
 * Deliberately NOT `Element.scrollIntoView()`. BACKLOG-2322 established what
 * that costs here: `scrollIntoView` scrolls EVERY scrollable ancestor to reveal
 * the target, and this list is nested inside the Contacts modal's own scroll
 * containers — so restoring a row's place would also yank the surrounding
 * screen. Writing this container's own `scrollTop` cannot reach outside it.
 *
 * Clamped at 0; the browser clamps the upper bound against the real scroll
 * height, which is not knowable here (and jsdom has none at all).
 */
export function scrollTopForAnchor(params: {
  currentScrollTop: number;
  containerTop: number;
  rowTop: number;
  viewportOffset: number;
}): number {
  const currentOffset = params.rowTop - params.containerTop;
  const delta = currentOffset - params.viewportOffset;
  return Math.max(0, params.currentScrollTop + delta);
}
