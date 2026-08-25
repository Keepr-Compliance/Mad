/**
 * BACKLOG-2862 follow-ups — the two founder refinements shipped on top of the
 * bubble redesign he tested and passed (int/ui-polish-e @ 4951bef3a).
 *
 *   ITEM 2. "View formatted email" was a blue text link. His words: "maybe make
 *           more obvious and turn it into a button in gray." It becomes a grey
 *           button using the treatment this repo already has in nine files —
 *           notably the modal-family variant in ConversationViewModal:701/:710
 *           and AttachMessagesModal:1035, and the footer button item 3 deletes.
 *
 *   ITEM 3. The preview footer strip goes. He pasted the element himself:
 *             <div class="flex-shrink-0 bg-white border-t px-5 py-3 flex justify-center">
 *               <button class="px-6 py-2 bg-gray-200 ... ">Close</button>
 *             </div>
 *           The whole strip, not just the button — the strip existed only to
 *           hold it.
 *
 * ITEM 1 OF THE BRIEF IS NOT IMPLEMENTED HERE, deliberately. Deleting "Tap for
 * details" and the expansion it drives would remove content that exists nowhere
 * else in this modal; see the PR body and the BACKLOG-2862 comment. No
 * assertion in this file pins that block either way.
 *
 * WHY THE TAG-NAME CHECK IS NOT THE ITEM-2 CONTROL. The element was ALREADY a
 * `<button type="button">` before this change — "text link" described how it
 * looked, not what it was. A tagName assertion therefore passes on the unchanged
 * component and can prove nothing. The discriminating assertion is the CLASS
 * SET: grey present AND blue absent. Both directions, because a partial edit
 * that adds grey while leaving the blue text colour behind would satisfy either
 * one alone.
 *
 * WHY THE DISMISS TEST FIRES A CLICK. Item 3 deletes a dismiss control from a
 * modal reached constantly. The founder confirmed the header X exists, so this
 * is not a check on his word — it is the guard against a future edit removing
 * the X and trapping the user in a modal whose other exit we deleted today.
 * Asserting an X is IN THE DOM would not catch an unwired one, so it fires the
 * interaction and asserts the handler ran.
 *
 * ONE BEHAVIOUR PER it-BLOCK. BACKLOG-2851's review established that the first
 * failing assertion in an it-block short-circuits the rest, so a single revert
 * would leave later assertions untested. Counts in the PR body were observed by
 * running each mutation, not predicted.
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { EmailThreadViewModal } from "../EmailThreadViewModal";
import type { EmailThread } from "../../EmailThreadCard";
import type { Communication } from "../../../types";

const EMAIL_ID = "email-2862-followups";

/**
 * The grey treatment, as LITERALS. Not imported from the component: importing
 * would make the control follow the source and stay green through any revert.
 */
const GREY_TREATMENT = ["bg-gray-200", "hover:bg-gray-300", "text-gray-700"];

/** The blue text-link treatment being replaced. Must be gone. */
const BLUE_LINK_TREATMENT = ["text-blue-600", "hover:text-blue-800"];

/**
 * The footer strip's own class signature, transcribed from the element the
 * founder pasted. `flex-shrink-0 bg-white border-t` together is unique to the
 * strip — the in-bubble dividers are `mt-2 pt-2 border-t border-gray-100` and
 * carry neither of the other two.
 */
const FOOTER_STRIP_SELECTOR = "div.flex-shrink-0.bg-white.border-t.justify-center";

const HTML_BODY = "<p>Thanks Sam - Thursday at 9am suits us.</p>";
const PLAIN_BODY = "Thanks Sam - Thursday at 9am suits us. NEWEST-SIGNOFF";

function makeEmail(overrides: Partial<Communication> = {}): Communication {
  return {
    id: EMAIL_ID,
    subject: "Inspection scheduling",
    sender: "dana@example.test",
    recipients: "sam@example.test",
    body_text: PLAIN_BODY,
    sent_at: "2026-06-01T00:00:00.000Z",
    communication_type: "email",
    ...overrides,
  } as unknown as Communication;
}

function makeThread(email: Communication): EmailThread {
  return {
    id: "thr-2862-followups",
    subject: "Inspection scheduling",
    participants: ["dana@example.test", "sam@example.test"],
    emailCount: 1,
    startDate: new Date("2026-06-01T00:00:00.000Z"),
    endDate: new Date("2026-06-01T00:00:00.000Z"),
    emails: [email],
  } as unknown as EmailThread;
}

/** The DEFAULT, UNEXPANDED render — the state the user first sees. */
function renderModal(
  overrides: Partial<Communication> = {},
  onClose: () => void = () => undefined,
) {
  return render(
    <EmailThreadViewModal
      thread={makeThread(makeEmail(overrides))}
      onClose={onClose}
      onViewEmail={() => undefined}
      userEmail="me@example.test"
    />,
  );
}

/* ------------------------------- ITEM 2: the grey button -------------------- */

describe("BACKLOG-2862 follow-up — 'View formatted email' is a grey button", () => {
  it("carries the repo's grey treatment and none of the blue text-link treatment", () => {
    renderModal({ body_html: HTML_BODY } as Partial<Communication>);

    const control = screen.getByTestId(`thread-bubble-formatted-${EMAIL_ID}`);
    const classes = control.className.split(/\s+/);

    // Direction 1 — the grey arrived.
    for (const cls of GREY_TREATMENT) {
      expect(classes).toContain(cls);
    }
    // Direction 2 — the blue left. A partial edit satisfies only one of these.
    for (const cls of BLUE_LINK_TREATMENT) {
      expect(classes).not.toContain(cls);
    }
  });

  it("is a real <button> carrying the founder's exact label", () => {
    // NOT the control for this item (see the file header — it was already a
    // button). It pins the label and the element type so a later restyle cannot
    // quietly turn the control into a div or reword it.
    renderModal({ body_html: HTML_BODY } as Partial<Communication>);

    const control = screen.getByTestId(`thread-bubble-formatted-${EMAIL_ID}`);
    expect(control.tagName).toBe("BUTTON");
    expect(control.textContent).toBe("View formatted email");
  });
});

describe("BACKLOG-2862 follow-up — the grey button's gating is unchanged", () => {
  it("is PRESENT when an HTML version exists", () => {
    renderModal({ body_html: HTML_BODY } as Partial<Communication>);

    expect(screen.getByText("View formatted email")).toBeInTheDocument();
  });

  it("is ABSENT when there is no HTML version", () => {
    // `body_html` and the deprecated `body` are both `?: string`, so ABSENT is
    // undefined — null would be a shape the type cannot hold.
    renderModal({ body_html: undefined, body: undefined });

    expect(screen.queryByText("View formatted email")).not.toBeInTheDocument();
  });
});

/* ------------------------------ ITEM 3: the footer strip -------------------- */

describe("BACKLOG-2862 follow-up — the preview footer strip is gone", () => {
  it("mounts no footer strip container", () => {
    // Asserted on the CONTAINER, not on the button text: deleting the button
    // while leaving an empty bordered strip behind would still show a stray
    // rule across the bottom of the modal, and a text-only check would pass.
    const { container } = renderModal({ body_html: HTML_BODY } as Partial<Communication>);

    expect(container.querySelector(FOOTER_STRIP_SELECTOR)).toBeNull();
  });

  it("renders no 'Close' button text anywhere in the default view", () => {
    // The header controls carry aria-label="Close" but no text node, so this
    // targets the deleted footer button specifically. Separate it-block: the
    // container assertion above must not short-circuit this one.
    renderModal({ body_html: HTML_BODY } as Partial<Communication>);

    expect(screen.queryByText("Close")).not.toBeInTheDocument();
  });
});

describe("BACKLOG-2862 follow-up — a dismiss route still works", () => {
  it("fires onClose when the header close control is clicked", () => {
    // FUNCTIONAL, not structural. jsdom mounts both the mobile 'Back' and the
    // desktop 'X' (Tailwind hides one by CSS, which jsdom does not apply), so
    // both match aria-label="Close" and getAllByLabelText is required. Clicking
    // the LAST is the desktop X — the one the founder confirmed he can see.
    const onClose = jest.fn();
    renderModal({ body_html: HTML_BODY } as Partial<Communication>, onClose);

    const closeControls = screen.getAllByLabelText("Close");
    expect(closeControls.length).toBeGreaterThan(0);

    fireEvent.click(closeControls[closeControls.length - 1]);

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
