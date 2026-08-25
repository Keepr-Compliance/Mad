/**
 * Handle identity tokens — the main-process answer to "are these two handles
 * the same person?".
 *
 * ===========================================================================
 * WHY THIS IS NOT `toLookupKey`
 * ===========================================================================
 * `electron/utils/phoneNormalization.ts` exports `toLookupKey`, and it is the
 * right function for PHONE numbers. It is the wrong function for a HANDLE,
 * because a handle can also be an email or an Apple ID, and `toLookupKey` sends
 * anything it cannot parse as a phone number to `legacyDigitKey` — which keeps
 * the value's DIGIT FRAGMENT. Measured (BACKLOG-2854, libphonenumber-js
 * 1.13.11):
 *
 *   toLookupKey("alice1@example.test")  ->  "1"
 *   toLookupKey("bob1@example.test")    ->  "1"
 *
 * Two unrelated iMessage email handles collapse onto the same key. Using that
 * to compare group rosters would merge two genuinely different conversations —
 * in an audit product, that is a group chat disappearing from search.
 *
 * ===========================================================================
 * WHY IT LIVES HERE
 * ===========================================================================
 * Extracted verbatim from `autoLinkService` (BACKLOG-2287), which is where the
 * main process first needed it, so there is ONE canonical handle normalization
 * rather than a second one invented per caller. `autoLinkService` imports it
 * back from here; nothing about its behaviour changed in the move.
 *
 * It remains the self-contained electron mirror of the renderer's
 * `getHandleMergeKey` (`src/utils/threadMergeUtils.ts`) — deliberately NOT
 * imported across the main/renderer boundary, because that util pulls in a
 * renderer component type. The logic is intentionally identical so the main
 * process buckets a conversation by contact the SAME way the UI does.
 */

/** Does this handle look like a phone number? (mirrors threadMergeUtils.isPhoneNumber) */
export function isPhoneLikeHandle(s: string): boolean {
  return s.startsWith("+") || /^\d[\d\s\-()]{6,}$/.test(s);
}

/**
 * Reduce a single handle (phone / email / Apple ID) to a stable identity token,
 * or null for the user placeholder / unknown. Phone numbers collapse to their
 * last 10 digits; everything else is lower-cased. Namespaced so a numeric handle
 * and an identically-spelled email can never collide.
 *
 * The returned token is ONLY ever compared for EQUALITY against another token, so
 * a short (<10-digit) handle keeps all its digits and CANNOT substring-match a
 * longer number the way a bare `participants_flat LIKE '%digits%'` would
 * (BACKLOG-2287 short-token risk).
 */
export function handleToIdentityToken(handle: string): string | null {
  const h = (handle ?? "").trim();
  if (!h || h === "me" || h === "unknown") return null;
  if (h.includes("@")) return `handle:${h.toLowerCase()}`;
  if (isPhoneLikeHandle(h)) {
    const digits = h.replace(/\D/g, "");
    if (!digits) return `handle:${h.toLowerCase()}`;
    const norm = digits.length >= 10 ? digits.slice(-10) : digits;
    return `phone:${norm}`;
  }
  return `handle:${h.toLowerCase()}`;
}
