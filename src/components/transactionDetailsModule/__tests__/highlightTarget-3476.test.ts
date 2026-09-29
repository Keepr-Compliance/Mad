/**
 * BACKLOG-3476 (B-5) — the Attachments tab no longer receives a highlight.
 *
 * A checklist chip's View opens the attachment where the user is, so the
 * "attachment" highlight that jumped to the Attachments tab was removed. The
 * union is pinned to exactly "email" | "text" (search results still use both).
 * The pin is enforced by `npm run type-check:tests`: if "attachment" comes
 * back, the `@ts-expect-error` below has nothing to expect and tsc fails.
 */
import type { HighlightTarget } from "../types";

type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe("HighlightTarget (BACKLOG-3476)", () => {
  it('is exactly "email" | "text"', () => {
    const exact: Exactly<HighlightTarget["type"], "email" | "text"> = true;
    // @ts-expect-error — "attachment" is not a highlight target any more.
    const removed: HighlightTarget = { type: "attachment" };
    expect([exact, removed.type]).toEqual([true, "attachment"]);
  });
});
