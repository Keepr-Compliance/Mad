/**
 * BACKLOG-2851 — the conversation bubble shows the message, without a click.
 *
 * THE DEFECT. `getPlainTextPreview(email, maxLength = 300)` capped the bubble at
 * 300 characters and appended an ellipsis past that. BACKLOG-2844 had already
 * fixed the DATA — the review projection carries the whole body rather than a
 * 200-character snippet — so the text was present and only the display cut it.
 * The founder's example measured ~316 characters: it lost the sign-off and the
 * closing line, and "Open Full Email" was the only way to read them. His words:
 * "user shouldn't have to click Open Full Email to see it in the individual
 * email preview — it should be in the thread conversation style preview too."
 *
 * WHY A BOUNDED BUBBLE RATHER THAN AN UNBOUNDED ONE. Measured first, across the
 * repo's synthetic corpora (fake-mailbox/emails.json 35, extraction
 * accuracy-test-emails.json 60, qa/harness eml-export-tx1 5 = 100 bodies, after
 * running the component's own quote-stripping pipeline over them — measured on
 * each message's BODY, which for the .eml five is the text after the
 * header/body blank line rather than the whole file):
 *
 *     p50 187   p75 263   p90 323   p95 348   max 432
 *     >300: 14 (14%)      >600: 0      >1200: 0      >10000: 0
 *
 * The first half of that is decisive and the second half is not. 14% of ordinary
 * transactional mail exceeds 300 characters, so the cap was cutting the normal
 * case, not outliers — that kills the cap. But the corpora contain no newsletter
 * and no long forwarded chain BY CONSTRUCTION (they are hand-authored for
 * extraction-accuracy tests), so they cannot show that huge bodies are rare and
 * cannot license an unbounded bubble. A height bound is safe under both
 * readings: nothing is ever truncated, and a 10,000-character marketing email
 * cannot make the conversation unscrollable.
 *
 * WHAT IS ASSERTABLE HERE. jsdom does not perform layout, so no test can observe
 * that the bubble actually scrolls at 384px. The assertable contract is the pair
 * that produces it: the FULL text is in the DOM, and the bounding classes are on
 * the SAME element that holds the text. Bounding a wrapper while the text
 * overflows a different box is the failure mode, which is why every bound
 * assertion below reads the element it just read the text from.
 *
 * The bound's expected value is a hardcoded literal, deliberately not imported
 * from the component: importing it would make the control follow the source, and
 * emptying the bound would stay green.
 *
 * ---------------------------------------------------------------------------
 * REWRITTEN BY BACKLOG-2862 — THE HEIGHT BOUND IS GONE, AND SO THIS FILE'S
 * BOUND ASSERTIONS ARE INVERTED RATHER THAN DELETED.
 *
 * `max-h-96 overflow-y-auto` made the bubble a scroll region nested inside the
 * thread's own scroll region, so a single wheel gesture had two possible
 * targets. That was the founder's complaint on testing 2851, and BACKLOG-2862
 * removed the bound. The two tests per path that asserted the bound now assert
 * its ABSENCE, on the same element and for the same reason — the claim
 * "the bubble is not a nested scroller" needs a control exactly as much as
 * "the bubble is bounded" did, and deleting them would have left the removal
 * untested on both paths.
 *
 * What did NOT change, and is the reason this file survives 2862 intact: every
 * completeness assertion (the tails, the ellipsis absence, the two-path
 * equality test) still holds, because 2862 added no character cap. The founder
 * deferred the cap once quote stripping proved to be a reliable boundary. If a
 * cap is ever added, these tail assertions are the controls it must answer to.
 *
 * The corpus measurement below was RE-TAKEN independently on 2862 rather than
 * inherited, by rendering all 100 bodies through the component and reading
 * textContent: p50 186, p75 261, p90 318, p95 342, max 432, 14 over 300 — the
 * same distribution, which is why CORPUS_MAX_LENGTH is unchanged.
 *
 * The consequence 2862 knowingly accepts: with neither a cap nor a bound, a
 * long body containing NO quoted chain renders unbounded. See the 10,000-char
 * test below, which now measures that instead of asserting containment.
 * ---------------------------------------------------------------------------
 *
 * MEASURED CONTROLS (each mutation applied to source, both suites re-run, counts
 * observed rather than predicted):
 *   1. Restore the cap — `if (text.length > 300) return text.substring(0, 300)
 *      + "..."` in getPlainTextBody → RED, 12 of 20 across this file and
 *      reviewThreadRender-2831. Both paths fail together, which is the point:
 *      one component serves both surfaces.
 *   2. Strip `max-h-96 overflow-y-auto` from the text element's className →
 *      RED, 4 of 20 — the two bound tests on each path, and ONLY those. The
 *      tail tests stay green, so completeness and containment are two separate
 *      claims with a control each rather than one claim asserted twice.
 *   3. Revert BACKLOG-2844 in ReviewQueueSection (`body_text: d.snippet`) →
 *      RED, 5 of 14 in this file: every REVIEW-path tail test plus the
 *      two-path equality test, while every LINKED-path test stays green. That
 *      asymmetry is the BACKLOG-2831 divergence signature reproduced, and it is
 *      what makes the equality test discriminating rather than a restatement of
 *      "both are non-empty". It is also the empirical reason this branch is
 *      based on PR #2370 (d225b9828) and not on develop: without 2844 the
 *      review path cannot carry a body past 200 characters at all, so a
 *      review-path control on develop could only have been written by inventing
 *      a `snippet` the service cannot emit.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { EmailThreadViewModal } from "../EmailThreadViewModal";
import type { EmailThread } from "../../EmailThreadCard";
import type { Communication } from "../../../types";
import { reviewThreadToEmailThread } from "../../ReviewQueueSection";
import { groupReviewItemsByThread } from "../../../utils/reviewThreads";
import type { ReviewItemDto } from "../../../../../../electron/types/ipc/window-api-transactions";

/**
 * The bound BACKLOG-2862 removed, as literals. See the header for why these are
 * not imported: importing would make the control follow the source, so
 * reinstating the bound in the component would keep these tests green.
 */
const REMOVED_BOUND_CLASSES = ["max-h-96", "overflow-y-auto"];

const EMAIL_ID = "email-2851";

/**
 * The founder's case: an ordinary message that runs just past 300 characters,
 * whose last two lines are the sign-off and the closing line — exactly what he
 * lost. Synthetic throughout; no real correspondence.
 *
 * Written to survive the stripping pipeline unchanged: no line begins with ">",
 * there is no "From:/Sent:" header block, no run of 10+ underscores, no "On ...
 * wrote:" quote header, and no doubled spaces (the pipeline collapses runs of
 * spaces and tabs to one, so a doubled space in the fixture would not appear in
 * the DOM and the assertion would fail for a reason that is not the change).
 */
const ORDINARY_BODY = [
  "Hi there,",
  "",
  "The inspection is booked for Thursday at 9am and the report should reach us by Friday afternoon. The seller has agreed to leave the shed and the two patio heaters, and their agent will send the amended inventory today.",
  "",
  "Let me know if Thursday no longer works and I will move it.",
  "",
  "Best regards,",
  "Sam Fielding, Closing Coordinator",
].join("\n");

/** The pathological case the bound exists for: a long newsletter-shaped body. */
const HUGE_BODY = `${"Market activity across the county rose again this quarter and listings continue to move faster than the five year average. ".repeat(90)}END-OF-NEWSLETTER`;

/** The longest body measured anywhere in the repo's corpora. */
const CORPUS_MAX_LENGTH = 432;

function linkedThread(bodyText: string): EmailThread {
  // The LINKED loader's shape: it projects
  // `COALESCE(m.body_text, e.body_plain) AS body_text` — the whole column.
  const email = {
    id: EMAIL_ID,
    subject: "Inspection Thursday",
    sender: "sam@example.com",
    recipients: "me@example.com",
    body_text: bodyText,
    sent_at: "2026-06-01T00:00:00.000Z",
    communication_type: "email",
  } as unknown as Communication;

  return {
    id: "thr-2851",
    subject: "Inspection Thursday",
    participants: ["sam@example.com", "me@example.com"],
    emailCount: 1,
    startDate: new Date("2026-06-01T00:00:00.000Z"),
    endDate: new Date("2026-06-01T00:00:00.000Z"),
    emails: [email],
  };
}

/**
 * The REVIEW path's shape, built through the real projection rather than by
 * hand: a ReviewItemDto goes through `groupReviewItemsByThread` and
 * `reviewThreadToEmailThread`, the same two functions ReviewQueueSection uses.
 *
 * `snippet` is the 200-character first line the service actually emits
 * (`firstLine(row.body_plain)`), and `bodyText` is the full body BACKLOG-2844
 * added. Setting snippet to the whole body instead would be inventing a value
 * the service cannot produce.
 */
function reviewThread(bodyText: string): EmailThread {
  const item: ReviewItemDto = {
    id: "pending:p1",
    rowId: "p1",
    origin: "pending",
    kind: "email",
    transaction_id: "tx-1",
    email_id: EMAIL_ID,
    thread_id: null,
    found_at: "2026-08-01T00:00:00.000Z",
    display: {
      title: "Inspection Thursday",
      subtitle: "sam@example.com",
      // Simplifies real firstLine (flattens ALL whitespace); inert for these bodies.
      snippet: bodyText.split("\n")[0].slice(0, 200),
      occurredAt: "2026-06-01T00:00:00.000Z",
      itemCount: 1,
      threadId: "thr-2851",
      recipients: "me@example.com",
      cc: null,
      sender: "sam@example.com",
      body: null,
      bodyText,
      hasAttachments: false,
      threadParticipants: [],
      threadMessages: [],
    },
  };
  const [group] = groupReviewItemsByThread([item]);
  return reviewThreadToEmailThread(group);
}

function renderBubble(thread: EmailThread) {
  const view = render(
    <EmailThreadViewModal
      thread={thread}
      onClose={() => undefined}
      onViewEmail={() => undefined}
      userEmail="me@example.com"
    />,
  );
  const element = screen.getByTestId(`thread-bubble-body-${EMAIL_ID}`);
  return { view, element, text: element.textContent ?? "" };
}

describe("BACKLOG-2851 — the thread bubble renders the whole message", () => {
  it("the founder's case runs past 300 characters, which is what made it his case", () => {
    // Pins the fixture to the defect. If someone shortens ORDINARY_BODY below
    // the old cap, every tail assertion in this file would pass on the
    // unfixed component and the suite would quietly stop testing anything.
    expect(ORDINARY_BODY.length).toBeGreaterThan(300);
    expect(ORDINARY_BODY.length).toBeLessThan(500);
  });

  describe.each([
    ["linked", linkedThread],
    ["review", reviewThread],
  ])("%s path", (_name, buildThread) => {
    it("renders an ordinary message to its last line, sign-off included", () => {
      // The TAIL, not the head: the first 300 characters are identical whether
      // or not the cap is there, so asserting the opening proves nothing. These
      // two lines are the ones the founder lost.
      const { text } = renderBubble(buildThread(ORDINARY_BODY));

      expect(text).toContain("Best regards,");
      expect(text).toContain("Sam Fielding, Closing Coordinator");
      expect(text.endsWith("Sam Fielding, Closing Coordinator")).toBe(true);
    });

    it("appends no ellipsis, because nothing was cut", () => {
      const { text } = renderBubble(buildThread(ORDINARY_BODY));

      expect(text).not.toMatch(/\.\.\.$/);
      expect(text).not.toContain("…");
    });

    it("does NOT make the bubble a nested scroll region (BACKLOG-2862)", () => {
      // INVERTED BY BACKLOG-2862. This asserted the presence of the bound.
      // Same element, same reason: the claim is about the box that holds the
      // text, so reading the className off any other element proves nothing.
      // Asserted on BOTH paths because the removal has to hold on both
      // surfaces, which the 2862 suite (linked path only) does not cover.
      const { element, text } = renderBubble(buildThread(ORDINARY_BODY));

      expect(text).toContain("Sam Fielding, Closing Coordinator");
      for (const cls of REMOVED_BOUND_CLASSES) {
        expect(element.className.split(/\s+/)).not.toContain(cls);
      }
    });

    it("keeps a 10,000-character newsletter whole, and now UNBOUNDED (BACKLOG-2862)", () => {
      // REWRITTEN BY BACKLOG-2862, and this is the test that records the
      // accepted cost of the change rather than hiding it.
      //
      // A newsletter carries no quoted chain, so quote stripping — the whole
      // mechanism now — does not shorten it, and no cap replaces the bound the
      // founder had removed. The body therefore renders whole AND unbounded:
      // ~152 lines at 66 chars per line, ~3,460px, against a thread viewport of
      // ~765px on a 900px window. That is the case to point at if the deferred
      // character cap stops being "later".
      expect(HUGE_BODY.length).toBeGreaterThan(10000);

      const { element, text } = renderBubble(buildThread(HUGE_BODY));

      expect(text.endsWith("END-OF-NEWSLETTER")).toBe(true);
      expect(text.length).toBeGreaterThan(10000);
      for (const cls of REMOVED_BOUND_CLASSES) {
        expect(element.className.split(/\s+/)).not.toContain(cls);
      }
    });

    it("renders the longest body in the repo's corpora with room to spare", () => {
      // 432 characters is the measured maximum across all 100 corpus bodies,
      // re-measured independently on BACKLOG-2862 and unchanged. At this width
      // that is roughly 8 lines (~190px) against a ~765px thread viewport, so
      // the realistic worst case shows in full with no scrollbar and no click —
      // which is also why the corpora CANNOT justify a bound or a cap: they
      // contain no case that would have hit either.
      const body = `${"Escrow opened this morning and the wire instructions follow under separate cover. ".repeat(6)}CORPUS-MAX-TAIL`;
      expect(body.length).toBeGreaterThanOrEqual(CORPUS_MAX_LENGTH);

      const { text } = renderBubble(buildThread(body));

      expect(text.endsWith("CORPUS-MAX-TAIL")).toBe(true);
    });

    it("still shows 'No content' when there is genuinely no body", () => {
      // The honest negative: removing the cap must not invent text.
      const { view } = renderBubble(buildThread(""));

      expect(view.getByText("No content")).toBeInTheDocument();
    });
  });

  it("the review path and the linked path render the SAME text for the same body", () => {
    // They diverged once before (BACKLOG-2831: the review projection fed the
    // modal `snippet` while the linked loader fed it the whole column, so the
    // same email read differently depending on which surface opened it).
    // Asserting both are merely non-empty would not have caught that. This
    // asserts EQUALITY.
    const linked = renderBubble(linkedThread(ORDINARY_BODY));
    const linkedText = linked.text;
    const linkedClass = linked.element.className;
    linked.view.unmount();

    const review = renderBubble(reviewThread(ORDINARY_BODY));

    expect(review.text).toBe(linkedText);
    expect(review.element.className).toBe(linkedClass);
    expect(review.text).toContain("Sam Fielding, Closing Coordinator");
  });
});
