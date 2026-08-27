/**
 * BACKLOG-2862 — the thread bubble shows what the person wrote, not the chain.
 *
 * THE ROOT DEFECT. `getPlainTextBody` left the entire quoted reply chain in
 * every bubble. One rule had two faults that compounded:
 *
 *     /\nFrom:.*?\nSent:.*?(?:\nTo:.*?)?(?:\nSubject:.*?)?(?:\n|$)/gi
 *
 *   1. It REQUIRED `Sent:`. Outlook for Mac and Apple Mail write `Date:` — the
 *      founder's own mail — so on his client the rule never fired at all.
 *   2. Even when it fired it ended at `(?:\n|$)`, removing the header LINES and
 *      leaving the quoted message beneath them.
 *
 * WHY EVERY QUOTE TEST ASSERTS BOTH DIRECTIONS. Fault 2 is invisible to a
 * presence check: the newest message is present today, chain and all. Only the
 * ABSENCE of a sentinel that exists solely inside the quoted portion separates
 * fixed from broken, so each fixture carries both and each test asserts both.
 *
 * WHERE THE FIXTURES COME FROM. A header block no producer emits would make
 * these controls false, so each shape is transcribed rather than invented:
 *
 *   From/Sent/To/Subject + a `____` separator — Windows Outlook. Transcribed
 *     from the comment on the rule being replaced, which recorded the shape its
 *     author observed: "Pattern: ________________________________\nFrom: ...
 *     \nSent: ...\nTo: ...", and from the old regex's own field order.
 *   From/Date/To/Subject — Outlook for Mac / Apple Mail. Transcribed from the
 *     `QUOTED` constant of the founder-approved mockup for this item
 *     (artifact ec0e1a71-512c-4464-a6a9-f70a369a575f), which he reviewed and
 *     approved as representative of his own mail.
 *   From/To/Cc/Subject/Date — an RFC-822 header block with Subject BEFORE Date.
 *     Transcribed from this repo's own .eml export fixture,
 *     scripts/qa/harness/__tests__/fixtures/eml-export-tx1/emails/
 *     4_Inspection_Results_a.eml. This is the shape that forces the matcher to
 *     be order-independent instead of assuming Date follows From.
 *
 * All names, addresses and domains are synthesized. No real correspondence.
 *
 * MEASURED CONTROLS — one mutation per behaviour, because BACKLOG-2851's review
 * established that the first failing assertion in an it-block short-circuits
 * the rest, so a single revert leaves later assertions untested. Counts observed
 * by running, not predicted. See the PR body for the table.
 */
import React, { useState } from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { EmailThreadViewModal } from "../EmailThreadViewModal";
import { EmailViewModal } from "../EmailViewModal";
import type { EmailThread } from "../../EmailThreadCard";
import type { Communication } from "../../../types";

const EMAIL_ID = "email-2862";

/** The bound REMOVED by this item, as literals. Not imported: importing would
 *  make the control follow the source, and it would stay green if reinstated. */
const REMOVED_BOUND_CLASSES = ["max-h-96", "overflow-y-auto"];

/* ------------------------------------------------------------------ fixtures */

/** What the person actually wrote. Its tail is the presence sentinel. */
const NEWEST = [
  "Thanks Sam - Thursday at 9am suits us.",
  "",
  "One thing worth flagging: the buyers asked whether the survey covers the",
  "garage roof. Could you confirm with the inspector before Thursday?",
  "",
  "Kind regards,",
  "Dana Whitfield NEWEST-SIGNOFF",
].join("\n");

/**
 * Outlook for Mac / Apple Mail, TWO levels of quoting.
 * QUOTED-LEVEL-1 and QUOTED-LEVEL-2 exist ONLY inside the quoted portion.
 */
const DATE_SHAPE_CHAIN = [
  NEWEST,
  "",
  "From: Sam Fielding <sam@example.test>",
  "Date: Saturday, June 1, 2026 at 9:12 AM",
  "To: Dana Whitfield <dana@example.test>",
  "Subject: Inspection scheduling",
  "",
  "The inspection is booked for Thursday at 9am. QUOTED-LEVEL-1",
  "",
  "From: Dana Whitfield <dana@example.test>",
  "Date: Friday, May 31, 2026 at 4:20 PM",
  "To: Sam Fielding <sam@example.test>",
  "Subject: Inspection scheduling",
  "",
  "Could we get the inspection in before the end of next week? QUOTED-LEVEL-2",
].join("\n");

/** Windows Outlook: the `____` separator, then From/Sent/To/Subject. */
const SENT_SHAPE_CHAIN = [
  NEWEST,
  "",
  "________________________________",
  "From: Sam Fielding <sam@example.test>",
  "Sent: Saturday, June 1, 2026 9:12 AM",
  "To: Dana Whitfield <dana@example.test>",
  "Subject: Inspection scheduling",
  "",
  "The inspection is booked for Thursday at 9am. QUOTED-LEVEL-1",
].join("\n");

/** RFC-822 block as this repo's .eml export writes it: Subject BEFORE Date. */
const RFC822_SHAPE_CHAIN = [
  NEWEST,
  "",
  "From: agent@example.test",
  "To: buyer@example.test",
  "Cc: coordinator@example.test",
  "Subject: Re: Inspection Results - My Recommendations",
  "Date: Sat, 14 Feb 2026 20:00:00 GMT",
  "",
  "Here are my recommendations. QUOTED-LEVEL-1",
].join("\n");

/**
 * The over-match boundary. "Date:" appears in ordinary prose, and a rule
 * anchored on that one token would truncate the message there. There is no
 * `From:` line opening a contiguous header block, so nothing may be removed.
 */
const PROSE_WITH_DATE = [
  "Hi Dana,",
  "",
  "Two things to confirm before we send the pack over.",
  "",
  "Date: Thursday still works for the walkthrough, assuming the inspector",
  "signs off. From: the seller's side there is nothing outstanding.",
  "",
  "PROSE-TAIL-SURVIVES",
].join("\n");

/* -------------------------------------------------------------- render utils */

function makeEmail(overrides: Partial<Communication> = {}): Communication {
  return {
    id: EMAIL_ID,
    subject: "Inspection scheduling",
    sender: "dana@example.test",
    recipients: "sam@example.test",
    body_text: NEWEST,
    sent_at: "2026-06-01T00:00:00.000Z",
    communication_type: "email",
    ...overrides,
  } as unknown as Communication;
}

function makeThread(email: Communication): EmailThread {
  return {
    id: "thr-2862",
    subject: "Inspection scheduling",
    participants: ["dana@example.test", "sam@example.test"],
    emailCount: 1,
    startDate: new Date("2026-06-01T00:00:00.000Z"),
    endDate: new Date("2026-06-01T00:00:00.000Z"),
    emails: [email],
  };
}

/** Renders the DEFAULT, UNEXPANDED bubble — the state the user first sees. */
function renderBubble(overrides: Partial<Communication> = {}) {
  const view = render(
    <EmailThreadViewModal
      thread={makeThread(makeEmail(overrides))}
      onClose={() => undefined}
      onViewEmail={() => undefined}
      userEmail="me@example.test"
    />,
  );
  const body = screen.getByTestId(`thread-bubble-body-${EMAIL_ID}`);
  return { view, body, text: body.textContent ?? "" };
}

/* ------------------------------------------------------ 1..3 quote stripping */

describe("BACKLOG-2862 — the quoted chain is stripped", () => {
  it.each([
    ["Date: shape (Outlook for Mac / Apple Mail), two levels", DATE_SHAPE_CHAIN, ["QUOTED-LEVEL-1", "QUOTED-LEVEL-2"]],
    ["Sent: shape (Windows Outlook, ____ separator)", SENT_SHAPE_CHAIN, ["QUOTED-LEVEL-1"]],
    ["RFC-822 shape, Subject BEFORE Date", RFC822_SHAPE_CHAIN, ["QUOTED-LEVEL-1"]],
  ])("%s", (_name, body_text, quotedSentinels) => {
    const { text } = renderBubble({ body_text });

    // Direction 1: what the person wrote survives, to its last line.
    expect(text).toContain("NEWEST-SIGNOFF");

    // Direction 2 — the one that fails today. A presence check alone passes on
    // the unfixed component, because the chain is appended, not substituted.
    for (const sentinel of quotedSentinels) {
      expect(text).not.toContain(sentinel);
    }

    // The header block itself goes too, not just the body under it.
    expect(text).not.toContain("Subject: Inspection scheduling");
  });

  it("does NOT truncate a body that merely contains 'Date:' in prose", () => {
    // The obvious over-match, and the reason the anchor is the whole header
    // block rather than one token.
    const { text } = renderBubble({ body_text: PROSE_WITH_DATE });

    expect(text).toContain("Date: Thursday still works");
    expect(text.endsWith("PROSE-TAIL-SURVIVES")).toBe(true);
  });

  it("fires on the founder's real Outlook path: HTML -> htmlToPlainText -> body_plain", () => {
    // THE PATH THAT MATTERS, and it is not the one the fixtures above take.
    // Post-BACKLOG-2855 Outlook mail has no text/plain part, so `body_plain` is
    // DERIVED from the HTML by electron/utils/htmlToPlainText.ts. This matcher
    // is line-based, so it only fires if that derivation puts `From:`/`Date:`
    // on separate lines — if it flattened them, the strip would never run on
    // the founder's own mail and the whole fix would be inert for him.
    //
    // The fixture below is TRANSCRIBED, not invented: it is the verbatim stdout
    // of htmlToPlainText() run on an Outlook `divRplyFwdMsg` reply whose headers
    // are `<b>From:</b> ... <br>` markup. Captured once and pasted here rather
    // than imported, because electron/ must not be value-imported from a
    // renderer-side module.
    const derivedFromHtml = [
      "Thanks Sam - Thursday at 9am suits us. NEWEST-SIGNOFF",
      "From: Sam Fielding <sam@example.test>",
      "Date: Saturday, June 1, 2026 at 9:12 AM",
      "To: Dana Whitfield <dana@example.test>",
      "Subject: Inspection scheduling",
      "",
      "The inspection is booked for Thursday. QUOTED-LEVEL-1",
    ].join("\n");

    // body_plain, NOT body_text — that is the column this path populates, and
    // the bubble reads `body_text || body_plain`.
    const { text } = renderBubble({ body_text: undefined, body_plain: derivedFromHtml });

    expect(text).toContain("NEWEST-SIGNOFF");
    expect(text).not.toContain("QUOTED-LEVEL-1");
    expect(text).not.toContain("Subject: Inspection scheduling");
  });

  it("keeps a bare forward rather than emptying the bubble", () => {
    // A forward with no words of the sender's own strips to nothing. The
    // forwarded message IS the content there, so "No content" would be a
    // regression on today's behaviour rather than the fix.
    const bareForward = [
      "From: Sam Fielding <sam@example.test>",
      "Date: Saturday, June 1, 2026 at 9:12 AM",
      "To: Dana Whitfield <dana@example.test>",
      "Subject: Inspection scheduling",
      "",
      "The inspection is booked for Thursday at 9am. FORWARDED-CONTENT",
    ].join("\n");

    const { text } = renderBubble({ body_text: bareForward });

    expect(text).toContain("FORWARDED-CONTENT");
    expect(screen.queryByText("No content")).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------- 4. no nested scroll region */

describe("BACKLOG-2862 — the bubble is not a scroll region", () => {
  it("carries neither max-h-96 nor overflow-y-auto on the element holding the text", () => {
    // Read off the SAME element the text was read from: bounding a wrapper
    // while the text lives in another box is the failure mode BACKLOG-2851
    // wrote its bound assertions against, and it applies to removal too.
    const { body, text } = renderBubble({ body_text: NEWEST });

    expect(text).toContain("NEWEST-SIGNOFF");
    const classes = body.className.split(/\s+/);
    for (const cls of REMOVED_BOUND_CLASSES) {
      expect(classes).not.toContain(cls);
    }
  });
});

/* ----------------------------------------------------- 5. recipients above body */

describe("BACKLOG-2862 — recipients above the body, To only", () => {
  it("shows To above the message and no From inside the unexpanded bubble", () => {
    // COMMENT UPDATED (2862 follow-up round 2), assertion UNCHANGED. This used
    // to read "the expanded 'Tap for details' block still renders From:/To' and
    // is out of scope" — the reason this control never clicked. That block has
    // since been DELETED entirely at the founder's ruling, so `From:` is now
    // absent from every render rather than merely from the default one, and the
    // assertion below is strictly stronger than when it was written.
    const { view } = renderBubble({ body_text: NEWEST });

    const recipients = screen.getByTestId(`thread-bubble-recipients-${EMAIL_ID}`);
    expect(within(recipients).getByText("To")).toBeInTheDocument();
    expect(recipients.textContent).toContain("sam@example.test");

    // From is absent from the whole bubble, not merely from the recipients line.
    expect(view.queryByText(/^From:/)).not.toBeInTheDocument();

    // ORDER: the recipients line precedes the body in document order.
    const body = screen.getByTestId(`thread-bubble-body-${EMAIL_ID}`);
    expect(
      recipients.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

/* ------------------------------------------------------------- 6. attachments */

describe("BACKLOG-2862 — attachments live behind the header pill", () => {
  const ATTACHMENTS = [
    { id: "att-1", filename: "Inspection booking confirmation.pdf", mime_type: "application/pdf", file_size_bytes: 188416, storage_path: "/tmp/a1" },
    { id: "att-2", filename: "Inspector credentials.pdf", mime_type: "application/pdf", file_size_bytes: 94208, storage_path: "/tmp/a2" },
    { id: "att-3", filename: "Amended inventory.docx", mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", file_size_bytes: 41984, storage_path: "/tmp/a3" },
  ];

  beforeEach(() => {
    (window as unknown as { api: unknown }).api = {
      transactions: {
        getEmailAttachments: jest.fn().mockResolvedValue({ success: true, data: ATTACHMENTS }),
      },
    };
  });

  async function renderWithAttachments() {
    const view = render(
      <EmailThreadViewModal
        thread={makeThread(makeEmail({ has_attachments: true } as Partial<Communication>))}
        onClose={() => undefined}
        onViewEmail={() => undefined}
        userEmail="me@example.test"
      />,
    );
    // Let the IPC promise resolve so the list is populated.
    const pill = await screen.findByTestId(`attachment-pill-${EMAIL_ID}`);
    return { view, pill };
  }

  it("renders the pill as a button whose click lists every attachment by identity", async () => {
    const { pill } = await renderWithAttachments();

    // It is a BUTTON, not the inert <span title="..."> it used to be.
    expect(pill.tagName).toBe("BUTTON");

    // Closed until clicked: the list is not merely hidden, it is absent.
    expect(screen.queryByTestId("thread-attachment-list-backdrop")).not.toBeInTheDocument();

    fireEvent.click(pill);

    const list = await screen.findByTestId("thread-attachment-list-backdrop");
    // IDENTITY, not count: every file is named. A length check would pass on a
    // list that rendered the same filename three times.
    for (const att of ATTACHMENTS) {
      expect(within(list).getByText(att.filename)).toBeInTheDocument();
    }
  });

  it("no longer renders the TASK-1782 in-bubble strip", async () => {
    await renderWithAttachments();

    // The strip the pill replaces. Absence, asserted directly.
    expect(screen.queryByTestId(`attachment-toggle-${EMAIL_ID}`)).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------- 7. "View formatted email" */

/**
 * The parent's wiring, transcribed rather than invented:
 * TransactionDetails.tsx `onViewEmail={setViewingEmail}` (:1171, :1178) and
 * `{viewingEmail && (<EmailViewModal email={viewingEmail} ... />)}` (:1299).
 */
function ThreadWithFullView({ email }: { email: Communication }): React.ReactElement {
  const [viewingEmail, setViewingEmail] = useState<Communication | null>(null);
  return (
    <>
      <EmailThreadViewModal
        thread={makeThread(email)}
        onClose={() => undefined}
        onViewEmail={setViewingEmail}
        userEmail="me@example.test"
      />
      {viewingEmail && (
        <EmailViewModal
          email={viewingEmail}
          onClose={() => undefined}
          onRemoveFromTransaction={() => undefined}
        />
      )}
    </>
  );
}

describe("BACKLOG-2862 — 'View formatted email' is gated on a formatted version existing", () => {
  const HTML_BODY = "<p>Thanks Sam - Thursday at 9am suits us.</p><p><strong>FORMATTED-ONLY-MARKER</strong></p>";

  it("renders with that exact label when an HTML version exists", () => {
    renderBubble({ body_text: NEWEST, body_html: HTML_BODY } as Partial<Communication>);

    expect(screen.getByText("View formatted email")).toBeInTheDocument();
    // The superseded label must not survive a partial edit. Case-insensitive.
    // COMMENT UPDATED (2862 follow-up round 2), assertion UNCHANGED. The caveat
    // that used to sit here — "safe because this is the UNEXPANDED render; the
    // expanded block has its own 'Open Full Email' button" — no longer applies:
    // that block is deleted, so "Open Full Email" exists nowhere in the
    // component and this assertion holds unconditionally.
    expect(screen.queryByText(/open full email/i)).not.toBeInTheDocument();
  });

  it("is absent when there is no HTML version", () => {
    // Plain-text-only mail: the formatted view would show the same text the
    // bubble already shows, so the control would change nothing. `body_html`
    // and the deprecated `body` are both `?: string`, so ABSENT is undefined —
    // writing null here would be a shape the type cannot hold.
    renderBubble({ body_text: NEWEST, body_html: undefined, body: undefined });

    expect(screen.queryByText("View formatted email")).not.toBeInTheDocument();
  });

  it("reaches the HTML branch of the full view when clicked", () => {
    // Not "a modal opened": this asserts the formatted view rendered the actual
    // HTML. FORMATTED-ONLY-MARKER exists only in body_html, and it must arrive
    // as a real <strong> element — the plain branch renders body_text inside a
    // <pre> and could never produce one.
    render(<ThreadWithFullView email={makeEmail({ body_text: NEWEST, body_html: HTML_BODY } as Partial<Communication>)} />);

    fireEvent.click(screen.getByText("View formatted email"));

    const marker = screen.getByText("FORMATTED-ONLY-MARKER");
    expect(marker.tagName).toBe("STRONG");
    expect(marker.closest(".email-content")).not.toBeNull();
  });
});
