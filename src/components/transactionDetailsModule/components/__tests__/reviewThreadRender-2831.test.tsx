/**
 * BACKLOG-2831 — the two founder-visible symptoms, at the surface that showed
 * them: EmailThreadViewModal, fed by the review path's own projection.
 *
 * SYMPTOM 1 — "(2 emails)" and two identical bubbles, with React warning
 *   "Encountered two children with the same key". `reviewItemToCommunication`
 *   sets `id: item.email_id ?? item.id`, and the modal keys its bubbles on
 *   `email.id` (EmailThreadViewModal `key={email.id}`). Two review items with
 *   the SAME `email_id` therefore become two Communications with the SAME key.
 *   The service-side dedup is what prevents that pair from ever existing; this
 *   file pins the RENDERED consequence, and the first test documents exactly why
 *   a duplicate `email_id` is not survivable downstream — the projection cannot
 *   tell the two apart, so the fix has to be upstream of it.
 *
 * SYMPTOM 2 — the bubbles read "No content". The modal's `getPlainTextPreview`
 *   tries `body_text || body_plain`, then `body_html || body`. Review items
 *   carried only `snippet` (= firstLine(body_plain), and for Outlook that is
 *   Graph's `bodyPreview`), and no HTML at all — so an HTML message with an
 *   empty preview had nothing to render, while the SAME email rendered fine once
 *   linked, because the linked loader projects `body`.
 *
 * MEASURED CONTROLS (each mutation applied to source, suite re-run):
 *   1. `body_html: d.body, body: d.body` removed from reviewItemToCommunication
 *      → RED, 1 of 4 ("renders the html body ... rather than 'No content'"). The
 *      genuinely-body-less test stays GREEN, which is what makes it a real
 *      negative and not a restatement of the positive.
 *   1b. `body_text: d.bodyText ?? d.snippet` → `body_text: d.snippet` (i.e.
 *      BACKLOG-2844 reverted) → RED, 2 of 6, not the 1 predicted. The tail
 *      assertion fails as expected; the ELLIPSIS test fails too, and its failure
 *      is the more interesting one. Predicted reasoning was "a truncated string
 *      is still truncated, so the ... stays". Wrong: the modal appends "..."
 *      only past its own 300-character limit, so a 200-character snippet
 *      produces NO ellipsis at all. That failure is the founder's actual
 *      complaint reproduced — the cut was not just early, it was SILENT — and
 *      it is why the ellipsis test earns its place rather than restating the
 *      tail one.
 *
 *      SUPERSEDED BY BACKLOG-2851: the modal's own 300-character cap is gone,
 *      so there is no ellipsis to assert and that test now asserts the reverse
 *      (full render past 300, no ellipsis). The 1b mutation still reds — on the
 *      tail assertions — because reverting 2844 still starves the review path
 *      of everything past 200 characters. See
 *      EmailThreadViewModal.fullBody-2851.test.tsx for the display half.
 *   2. `id: item.email_id ?? item.id` → `id: item.id` in the projection
 *      → RED, 1 of 4 (the duplicate-key characterisation) — which is the point:
 *      that test states the constraint the service-side dedup exists to satisfy,
 *      so if someone ever makes the ids unique here instead, this tells them the
 *      dedup's justification moved.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { EmailThreadViewModal } from "../modals/EmailThreadViewModal";
import { reviewThreadToEmailThread } from "../ReviewQueueSection";
import { groupReviewItemsByThread } from "../../utils/reviewThreads";
import type { ReviewItemDto } from "../../../../../electron/types/ipc/window-api-transactions";

function reviewEmail(
  id: string,
  emailId: string,
  overrides: Partial<ReviewItemDto["display"]> = {},
): ReviewItemDto {
  return {
    id,
    rowId: id.split(":")[1],
    origin: id.startsWith("legacy") ? "legacy" : "pending",
    kind: "email",
    transaction_id: "tx-1",
    email_id: emailId,
    thread_id: null,
    found_at: "2026-08-01T00:00:00.000Z",
    display: {
      title: "Closing schedule",
      subtitle: "paul@example.com",
      snippet: "Closing moved to Friday.",
      occurredAt: "2026-06-01T00:00:00.000Z",
      itemCount: 1,
      threadId: "thr-1",
      recipients: "me@example.com",
      cc: null,
      sender: "paul@example.com",
      body: null,
      bodyText: null,
      hasAttachments: false,
      threadParticipants: [],
      threadMessages: [],
      ...overrides,
    },
  };
}

function renderThread(items: ReviewItemDto[]) {
  const [group] = groupReviewItemsByThread(items);
  const thread = reviewThreadToEmailThread(group);
  render(
    <EmailThreadViewModal
      thread={thread}
      onClose={() => undefined}
      userEmail="me@example.com"
    />,
  );
  return thread;
}

describe("BACKLOG-2831 — what the review path renders in the reading modal", () => {
  it("renders ONE bubble and '1 email' for one email, which is what the dedup delivers", () => {
    const thread = renderThread([reviewEmail("pending:p1", "email-5c317c1e")]);

    expect(thread.emailCount).toBe(1);
    expect(screen.getByText(/1 email in conversation/i)).toBeInTheDocument();
    expect(screen.getAllByText("Closing moved to Friday.")).toHaveLength(1);
  });

  it("CHARACTERISATION: two items sharing an email_id collide on the modal's key", () => {
    // Not a wish — a statement of why the dedup must live in getReviewState.
    // The projection collapses BOTH items onto `email_id`, so downstream there
    // is no id left to tell them apart, and the modal keys bubbles on it. This
    // is precisely the pair the founder saw: "(2 emails)", two identical
    // bubbles, and React's duplicate-key warning.
    const twinned = [
      reviewEmail("pending:p1", "email-5c317c1e"),
      reviewEmail("legacy:c1", "email-5c317c1e"),
    ];
    const [group] = groupReviewItemsByThread(twinned);
    const thread = reviewThreadToEmailThread(group);

    expect(thread.emails.map((e) => e.id)).toEqual(["email-5c317c1e", "email-5c317c1e"]);
    expect(new Set(thread.emails.map((e) => e.id)).size).toBe(1);
    expect(thread.emailCount).toBe(2);
  });

  it("renders the html body of a preview-less email rather than 'No content'", () => {
    // The Outlook shape: body_plain is Graph's bodyPreview and it is empty, so
    // `snippet` is empty; the content lives in body_html.
    renderThread([
      reviewEmail("pending:p1", "email-invite", {
        snippet: "",
        body: "<p>Closing moved to Friday.</p>",
      }),
    ]);

    expect(screen.getByText("Closing moved to Friday.")).toBeInTheDocument();
    expect(screen.queryByText("No content")).not.toBeInTheDocument();
  });


  it("renders a 260-character body IN FULL, tail included (BACKLOG-2844)", () => {
    // The founder's case, at the surface he saw it on. Before BACKLOG-2844 the
    // modal received `snippet` — 200 characters — and stopped mid-word with NO
    // "...", because the modal appends one only past ITS OWN 300-character
    // limit, which a 200-character string never reaches. Silent truncation.
    //
    // 260 characters is chosen deliberately: longer than the old 200 cap,
    // shorter than the modal's 300, so the WHOLE message must now render and the
    // assertion is unambiguous. Asserting the head would pass on the truncated
    // version — the first 200 characters are identical — so this asserts the
    // TAIL.
    const body = `${"Please review the attached addendum before Friday. ".repeat(5)}SIGNED-OFF`;
    expect(body.length).toBeGreaterThan(200);
    expect(body.length).toBeLessThan(300);

    renderThread([
      reviewEmail("pending:p1", "email-long", {
        snippet: body.slice(0, 200),
        bodyText: body,
      }),
    ]);

    expect(screen.getByText(/SIGNED-OFF/)).toBeInTheDocument();
  });

  it("renders a body PAST 300 characters in full too, with no ellipsis (BACKLOG-2851)", () => {
    // REWRITTEN BY BACKLOG-2851. This test used to assert the opposite: that
    // past 300 characters the modal truncated and appended "..." — "if it IS
    // cut, the UI has to say so". The founder's answer, on testing 2844, was
    // that it must not be cut at all: "user shouldn't have to click Open Full
    // Email to see it in the individual email preview". So the honest indicator
    // is gone because the thing it indicated is gone.
    //
    // UPDATED BY BACKLOG-2862: this used to add "the bubble is bounded by
    // height now, not by character count". The height bound has since been
    // removed — it made the bubble a scroll region inside the thread's own
    // scroller — and no cap replaced it. The assertion below is unaffected and
    // stayed green through that change; only the explanation was stale.
    //
    // Kept in this file rather than moved because it is the same review-path
    // projection under test, and because leaving the old assertion here would
    // have re-pinned the defect.
    const body = `${"The inspection report raises three items. ".repeat(12)}TAIL-MARKER`;
    expect(body.length).toBeGreaterThan(300);

    renderThread([
      reviewEmail("pending:p1", "email-huge", { snippet: body.slice(0, 200), bodyText: body }),
    ]);

    expect(screen.getByText(/TAIL-MARKER$/)).toBeInTheDocument();
    expect(screen.queryByText(/\.\.\.$/)).not.toBeInTheDocument();
  });

  it("still says 'No content' when the email genuinely has neither body", () => {
    // The honest negative: the fix must not invent text. An email with no plain
    // body AND no html has nothing to show, and that is DATA, not a projection
    // bug — this pins the difference so the two are never confused again.
    renderThread([reviewEmail("pending:p1", "email-empty", { snippet: "", body: null })]);

    expect(screen.getByText("No content")).toBeInTheDocument();
  });
});
