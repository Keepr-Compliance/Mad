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
 *   ITEM 1. "Tap for details" and the whole expanded panel are DELETED. First
 *           reported as blocked — the panel was the only place the sender's
 *           email address appeared, and for plain-text-only mail its
 *           "Open Full Email →" was the only route to the full view. The
 *           founder was shown both and ruled anyway: "we don't need the info
 *           the tap for details provides, can we remove the tap for details?"
 *
 *   ITEM 4. The button is LEFT-ALIGNED, explicitly. It already was — no
 *           ancestor carries a centering class — but nothing pinned it, so the
 *           assertion exists to keep it that way.
 *
 *   ITEM 5. The "line break" before the button is gone. There was never a
 *           literal <br>: the wrapper's `mt-2 pt-2 border-t border-gray-100`
 *           was ~one text-xs line-height of space plus a rule.
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

/* --------------------- ITEM 1: the expansion is gone ---------------------- */

/**
 * The deleted panel's own class signature, transcribed from the markup that was
 * removed: `<div className="mt-3 pt-3 border-t border-gray-100">`. Asserted on
 * the CONTAINER as well as the labels, so a partial edit that strips the text
 * but leaves an empty bordered wrapper still fails.
 */
const EXPANDED_PANEL_SELECTOR = "div.mt-3.pt-3.border-t";

describe("BACKLOG-2862 follow-up — 'Tap for details' and its panel are deleted", () => {
  it("mounts no expanded-details panel container", () => {
    const { container } = renderModal({ body_html: HTML_BODY } as Partial<Communication>);

    expect(container.querySelector(EXPANDED_PANEL_SELECTOR)).toBeNull();
  });

  it("renders neither the 'Tap for details' affordance nor its 'Open Full Email' button", () => {
    // Separate it-block from the container check above: the first failing
    // assertion in an it-block short-circuits the rest, so a single revert
    // would otherwise leave one of these two untested.
    renderModal({ body_html: HTML_BODY } as Partial<Communication>);

    expect(screen.queryByText(/tap for details/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/open full email/i)).not.toBeInTheDocument();
  });

  it("does not expand when the bubble is clicked", () => {
    // The behaviour, not just the markup. Clicking the bubble used to toggle
    // the panel; `onToggle` and the parent's `expandedIds` are gone, so a click
    // must now be inert. Without this, reinstating the panel behind a restored
    // toggle would leave the two assertions above green on first render.
    const { container } = renderModal({ body_html: HTML_BODY } as Partial<Communication>);

    fireEvent.click(screen.getByTestId(`thread-bubble-body-${EMAIL_ID}`));

    expect(container.querySelector(EXPANDED_PANEL_SELECTOR)).toBeNull();
    expect(screen.queryByText(/open full email/i)).not.toBeInTheDocument();
  });

  it("loses nothing else: the recipients line and the body still render", () => {
    // The deletion's blast radius, asserted directly. These three surfaces sit
    // in the same bubble as the panel that was removed.
    renderModal({ body_html: HTML_BODY } as Partial<Communication>);

    const recipients = screen.getByTestId(`thread-bubble-recipients-${EMAIL_ID}`);
    expect(recipients.textContent).toContain("sam@example.test");
    expect(screen.getByTestId(`thread-bubble-body-${EMAIL_ID}`).textContent).toContain("NEWEST-SIGNOFF");
  });

  it("loses nothing else: the attachment pill still renders", () => {
    // Its own it-block because it needs a different fixture: the pill is gated
    // on has_attachments, and it is ALSO the element whose presence used to
    // suppress the "Tap for details" indicator (`!isExpanded && !hasAttachments`).
    renderModal({ has_attachments: true } as unknown as Partial<Communication>);

    expect(screen.getByTestId(`attachment-pill-${EMAIL_ID}`)).toBeInTheDocument();
  });
});

/* ------------------ ITEMS 4 + 5: alignment and the gap -------------------- */

describe("BACKLOG-2862 follow-up — the button is left-aligned with no gap above", () => {
  /** The wrapper is the button's parent element. */
  function wrapperOf(): HTMLElement {
    const btn = screen.getByTestId(`thread-bubble-formatted-${EMAIL_ID}`);
    const wrapper = btn.parentElement;
    if (!wrapper) throw new Error("button has no wrapper element");
    return wrapper;
  }

  it("is left-aligned, and carries no centring", () => {
    renderModal({ body_html: HTML_BODY } as Partial<Communication>);

    const classes = wrapperOf().className.split(/\s+/);
    expect(classes).toContain("justify-start");
    // Both directions: justify-start present is not enough if a centring class
    // survives alongside it and wins by CSS source order.
    expect(classes).not.toContain("justify-center");
    expect(classes).not.toContain("justify-end");
    expect(classes).not.toContain("text-center");
  });

  it("carries none of the spacing or divider that read as a line break", () => {
    // Separate it-block from alignment: items 4 and 5 are different changes and
    // must be revertible independently without one masking the other.
    renderModal({ body_html: HTML_BODY } as Partial<Communication>);

    const classes = wrapperOf().className.split(/\s+/);
    for (const cls of ["mt-2", "pt-2", "border-t", "border-gray-100"]) {
      expect(classes).not.toContain(cls);
    }
  });
});

/* ------------- the three dismiss routes, each asserted functionally -------- */

describe("BACKLOG-2862 follow-up — all three dismiss routes still fire onClose", () => {
  it("desktop header X", () => {
    const onClose = jest.fn();
    renderModal({ body_html: HTML_BODY } as Partial<Communication>, onClose);

    // jsdom mounts BOTH header variants (Tailwind hides one by CSS, which jsdom
    // does not apply). The desktop X is the second.
    const controls = screen.getAllByLabelText("Close");
    expect(controls.length).toBe(2);
    fireEvent.click(controls[1]);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("mobile header Back", () => {
    const onClose = jest.fn();
    renderModal({ body_html: HTML_BODY } as Partial<Communication>, onClose);

    const controls = screen.getAllByLabelText("Close");
    fireEvent.click(controls[0]);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("backdrop click", () => {
    // ResponsiveModal closes only when the click LANDS ON the overlay itself
    // (`e.target === e.currentTarget`), so this dispatches on the overlay
    // element rather than bubbling one up from a child — a click inside the
    // panel must NOT close, and firing on a child would test the opposite.
    const onClose = jest.fn();
    renderModal({ body_html: HTML_BODY } as Partial<Communication>, onClose);

    fireEvent.click(screen.getByTestId("thread-modal-backdrop"));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a click INSIDE the panel does not close the modal", () => {
    // The other direction of the backdrop rule. Without this, an overlay that
    // closed on every click would pass the backdrop test above while making the
    // modal impossible to interact with.
    const onClose = jest.fn();
    renderModal({ body_html: HTML_BODY } as Partial<Communication>, onClose);

    fireEvent.click(screen.getByTestId(`thread-bubble-body-${EMAIL_ID}`));

    expect(onClose).not.toHaveBeenCalled();
  });
});
