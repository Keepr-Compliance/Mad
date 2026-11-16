/**
 * Learn mode question dialog (boards L2 and L3) — BACKLOG-4120 PR3.
 *
 * Top bar: Skip for now · "Learn mode / Question N of M" · Undo last.
 * Left: what the question is about. A deal question shows its one document
 * (the first PDF of the newest message) once main has opened it, else the
 * newest message. A mail question shows the message.
 * Right: the question and its two answers.
 *
 * Presentational: every action goes through the session hook.
 */
import React from "react";
import { createPortal } from "react-dom";
import { Check, Info, SkipForward, Sparkle, Undo2, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@keepr/ui";
import type { UseLearnSession } from "./useLearnSession";
import { LearnEmailPane, formatLearnDate, splitSender } from "./LearnEmailPane";
import { LearnPdfPane } from "./LearnPdfPane";
import { displayAddress } from "./learnEmailHtml";

const TOP_BUTTON =
  "inline-flex h-[30px] items-center gap-1.5 rounded-md bg-[#F6F5F2] px-2.5 text-[13px] font-medium text-gray-500 hover:bg-gray-200 disabled:opacity-40";
/** Answers sit side by side when they fit (flex-wrap); otherwise each wraps to its own full-width row (grow). A label never wraps inside its button. */
const ANSWER_ROW = "flex flex-wrap gap-3";
/** Secondary, bordered, neutral: visible on the white panel, never ghost. */
const SKIP_BUTTON =
  "inline-flex h-10 w-full items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-gray-300 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50";
export const MAIL_TIP_STEPS: ReadonlyArray<{ label: string; hint: string; tone: string; body: string }> = [
  {
    label: "Real estate work",
    hint: "\u2190",
    tone: "text-green-800",
    body: "a person wrote to you about real estate (a client, lead, agent, lender, title or escrow), or a deal service (e-sign, showing, title portal) wrote about one of your deals.",
  },
  {
    label: "Automated or mass mail",
    hint: "\u2192",
    tone: "text-red-700",
    body: "an automated email or newsletter, like a listing alert, promotion, receipt, or bank or app alert, even when it's about real estate.",
  },
  { label: "Other", hint: "\u2193", tone: "text-gray-700", body: "a person wrote to you about something else, or you can't tell." },
];
export const MAIL_KEYS_TIP = "U undoes your last answer.";

/** Info tip beside the mail question: click toggles, keyboard focus opens, blur closes. */
function MailAnswerHelp(): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  // The dialog and its answer panel clip their children (overflow), so the tip is
  // portalled to <body> and placed from the button's rect, clamped inside the window.
  React.useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const W = 288;
    const left = Math.max(8, Math.min(r.left + r.width / 2 - W / 2, window.innerWidth - W - 8));
    setPos({ left, top: r.bottom + 8 });
  }, [open]);
  return (
    <span className="inline-flex">
      <button
        ref={btnRef}
        type="button"
        aria-label="What do these answers mean?"
        aria-expanded={open}
        data-testid="learn-answer-help-button"
        className="inline-flex text-gray-400 hover:text-gray-600"
        // A mouse press must not focus the button: focus opens the tip, and the click that
        // follows would toggle it shut again. Keyboard focus (Tab) still opens it.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        <Info className="h-4 w-4" aria-hidden="true" />
      </button>
      {open && createPortal(
        <span
          role="tooltip"
          data-testid="learn-answer-help-panel"
          style={{ left: pos?.left ?? 0, top: pos?.top ?? 0 }}
          className="pointer-events-none fixed z-[100] w-72 max-w-[calc(100vw-16px)] rounded-lg border border-gray-200 bg-white p-3 text-left text-xs text-gray-600 shadow-lg"
        >
          <ul className="m-0 list-none space-y-1 p-0">
            {MAIL_TIP_STEPS.map((t) => (
              <li key={t.label}>
                <strong className={`font-semibold ${t.tone}`}>
                  {t.label} ({t.hint}):
                </strong>{" "}
                {t.body}
              </li>
            ))}
          </ul>
          <span className="mt-2 block text-gray-500" data-testid="learn-answer-help-keys">
            {MAIL_KEYS_TIP}
          </span>
        </span>,
        document.body,
      )}
    </span>
  );
}

/** Visible shortcut hint; aria-hidden so the button's name stays its label (aria-keyshortcuts carries it). */
function Hint({ k }: { k: string }): React.ReactElement {
  return (
    <span aria-hidden="true" className="font-normal opacity-80">
      ({k})
    </span>
  );
}

/** True when a key press belongs to a text field (or a modified shortcut), not to Learn. */
function isTypingTarget(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return true;
  return e.ctrlKey || e.metaKey || e.altKey;
}

/** Arrows scroll the email preview while the reader is in it; they never answer from there. */
function inPreview(e: KeyboardEvent): boolean {
  const sel = '[data-testid="learn-preview-column"]';
  const t = e.target as Element | null;
  const a = document.activeElement;
  return Boolean((t && t.closest?.(sel)) || (a && a.closest?.(sel)));
}

function useLearnShortcuts(session: UseLearnSession, active: boolean): void {
  const ref = React.useRef(session);
  ref.current = session;
  React.useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.repeat || isTypingTarget(e) || inPreview(e)) return;
      const s = ref.current;
      if (s.phase !== "question" || !s.current || s.busy) return;
      const deal = s.current.kind === "cleanup";
      // Keys follow screen order: left = first (green) answer, right = second (red), down = skip. U = undo.
      if (e.key === "ArrowDown") void s.skip();
      else if (e.key === "u" || e.key === "U") {
        if (!s.canUndo) return;
        void s.undo();
      } else if (e.key === "ArrowLeft") void (deal ? s.answerDeal("yes") : s.answerMail("real_estate"));
      else if (e.key === "ArrowRight") void (deal ? s.answerDeal("no") : s.answerMail("newsletter_spam"));
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active]);
}

function SkipButton({ session, mail }: { session: UseLearnSession; mail: boolean }): React.ReactElement {
  const hint = "↓";
  return (
    <button
      type="button"
      className={SKIP_BUTTON}
      disabled={session.busy || !session.current}
      aria-keyshortcuts="ArrowDown"
      onClick={() => void session.skip()}
    >
      <SkipForward className="h-4 w-4 shrink-0" aria-hidden="true" />
      {mail ? "Other" : "Skip for now"} <Hint k={hint} />
    </button>
  );
}

const NO_BUTTON =
  "inline-flex h-14 grow basis-[200px] px-4 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-red-200 bg-red-50 text-base font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50";
const YES_BUTTON =
  "inline-flex h-14 grow basis-[200px] px-4 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] bg-green-700 text-base font-semibold text-white hover:bg-green-800 disabled:opacity-50";

function LeftPane({ session }: { session: UseLearnSession }): React.ReactElement {
  const { current, emails, attachment } = session;
  if (!current || emails.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center bg-white text-sm text-gray-500">
        {session.phase === "loading" ? "Loading…" : "This message is no longer on this computer."}
      </div>
    );
  }
  if (current.kind === "cleanup") {
    const address = current.question.address;
    if (attachment.status === "ready") {
      const meta = emails.flatMap((e) => e.attachments).find((a) => a.id === attachment.attachmentId);
      return <LearnPdfPane dataUrl={attachment.dataUrl} filename={meta?.filename ?? "Document"} highlightAddress={address} />;
    }
    if (attachment.status === "loading") {
      return (
        <div className="flex flex-1 items-center justify-center bg-[#EEECE7] text-sm text-gray-500" data-testid="learn-pdf-loading">
          Opening the document…
        </div>
      );
    }
    return <LearnEmailPane email={emails[0]} highlightAddress={address} />;
  }
  return <LearnEmailPane email={emails[0]} highlightAddress={null} />;
}

function RightCard({ session }: { session: UseLearnSession }): React.ReactElement | null {
  const { current, emails, totalEmails, busy } = session;
  if (!current) return null;
  if (current.kind === "cleanup") {
    const n = totalEmails || current.question.emailCount;
    return (
      <>
        <h2 className="m-0 text-xl font-semibold leading-7">Is this one of your deals?</h2>
        <div className="flex flex-col items-center gap-1">
          <span className="text-lg font-semibold leading-[26px]">{displayAddress(current.question.address)}</span>
          <span className="text-sm text-gray-500">Not matched to a deal in Keepr · {n === 1 ? "1 email" : `${n} emails`}</span>
        </div>
        <div className={ANSWER_ROW} data-testid="learn-answer-row">
          <button type="button" className={YES_BUTTON} aria-keyshortcuts="ArrowLeft" disabled={busy} onClick={() => void session.answerDeal("yes")}>
            <Check className="h-[18px] w-[18px] shrink-0" strokeWidth={2.5} aria-hidden="true" />
            Yes, my deal <Hint k="←" />
          </button>
          <button type="button" className={NO_BUTTON} aria-keyshortcuts="ArrowRight" disabled={busy} onClick={() => void session.answerDeal("no")}>
            <X className="h-[18px] w-[18px] shrink-0" strokeWidth={2.5} aria-hidden="true" />
            No <Hint k="→" />
          </button>
        </div>
        <SkipButton session={session} mail={false} />
        <span className="text-[13px] text-gray-500">The highlighted parts are what Keepr read.</span>
      </>
    );
  }
  const email = emails[0];
  const sender = splitSender(email?.sender ?? null);
  return (
    <>
      <h2 className="m-0 inline-flex items-center justify-center gap-2 text-xl font-semibold leading-7">
        <span>What kind of email is this?</span>
        <MailAnswerHelp />
      </h2>
      <div className="flex flex-col items-center gap-1">
        <span className="text-lg font-semibold leading-[26px]">{email?.subject || "(no subject)"}</span>
        <span className="text-sm text-gray-500">
          {sender.name}
          {email?.sentAt ? ` · ${formatLearnDate(email.sentAt, false)}` : ""}
        </span>
      </div>
      <div className={ANSWER_ROW} data-testid="learn-answer-row">
        <button type="button" className={YES_BUTTON} aria-keyshortcuts="ArrowLeft" disabled={busy} onClick={() => void session.answerMail("real_estate")}>
          <Check className="h-[18px] w-[18px] shrink-0" strokeWidth={2.5} aria-hidden="true" />
          Real estate work <Hint k="←" />
        </button>
        <button
          type="button"
          className={NO_BUTTON}
          aria-keyshortcuts="ArrowRight"
          disabled={busy}
          onClick={() => void session.answerMail("newsletter_spam")}
        >
          <X className="h-[18px] w-[18px] shrink-0" strokeWidth={2.5} aria-hidden="true" />
          Automated or mass mail <Hint k="→" />
        </button>
      </div>
      <SkipButton session={session} mail />
      <span className="text-[13px] text-gray-500">Listing alerts and marketing mail count as automated or mass mail.</span>
    </>
  );
}

export function LearnQuestionDialog({
  session,
  onClose,
}: {
  session: UseLearnSession;
  onClose: () => void;
}): React.ReactElement {
  const open = session.phase === "loading" || session.phase === "question" || session.phase === "error";
  const questionKey =
    session.current?.kind === "cleanup" ? session.current.question.detectionId : session.current?.rowId ?? "none";
  useLearnShortcuts(session, open);

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent
        hideClose
        className="flex h-[640px] max-h-[calc(100vh-32px)] w-[1120px] max-w-[calc(100vw-32px)] xl:w-[1280px] flex-col gap-0 overflow-hidden rounded-xl border-0 bg-white p-0 text-[15px] leading-normal text-[#1C2430]"
      >
        <DialogTitle className="sr-only">Learn mode question</DialogTitle>
        <DialogDescription className="sr-only">Answer the question about the item on the left.</DialogDescription>
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 border-b border-[#EEECE7] px-5 py-3.5">
          <span aria-hidden="true" />
          <span className="flex flex-col items-center gap-1">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-sky-700">
              <Sparkle className="h-3 w-3" fill="currentColor" aria-hidden="true" />
              Learn mode
            </span>
            <span className="text-xs font-medium text-gray-500" data-testid="learn-question-progress">
              Question {Math.max(1, session.index)} of {Math.max(session.total, session.index, 1)}
            </span>
          </span>
          <span className="flex items-center gap-2 justify-self-end">
            <button
              type="button"
              className={TOP_BUTTON}
              aria-keyshortcuts="U"
              disabled={session.busy || !session.canUndo}
              onClick={() => void session.undo()}
            >
              <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
              Undo last <Hint k="U" />
            </button>
            {/* Always shown and never disabled: keeps the answers and shows the score. */}
            <button type="button" className={TOP_BUTTON} onClick={onClose}>
              Done for now
            </button>
          </span>
        </div>
        {/* The preview column can never widen or heighten the dialog: minmax(0,1fr) and
            min-w-0 / min-h-0 down the chain. Without them a 1400px email table measured the
            column at 2737px and pushed the answer panel out of the dialog (BACKLOG-4120). */}
        <div
          className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_420px] xl:grid-cols-[minmax(0,1fr)_600px] grid-rows-[minmax(0,1fr)]"
          data-testid="learn-question-body"
        >
          <div
            className="flex min-h-0 min-w-0 flex-col overflow-hidden border-r border-[#EEECE7]"
            key={questionKey}
            data-testid="learn-preview-column"
          >
            <LeftPane session={session} />
          </div>
          <div
            className="flex min-h-0 min-w-0 flex-col justify-center gap-6 overflow-y-auto px-9 py-10 text-center xl:px-6"
            data-testid="learn-answer-panel"
          >
            {session.phase === "error" ? (
              <>
                <p className="text-sm text-red-700">{session.error ?? "Something went wrong."}</p>
                <button type="button" className={TOP_BUTTON + " self-center"} onClick={onClose}>
                  Close
                </button>
              </>
            ) : (
              <RightCard session={session} />
            )}
            {session.phase === "question" && session.error && (
              <p className="text-[13px] text-red-700">{session.error}</p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
