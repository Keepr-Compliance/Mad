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
import { Check, SkipForward, Sparkle, Undo2, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@keepr/ui";
import type { UseLearnSession } from "./useLearnSession";
import { LearnEmailPane, formatLearnDate, splitSender } from "./LearnEmailPane";
import { LearnPdfPane } from "./LearnPdfPane";
import { displayAddress } from "./learnEmailHtml";

const TOP_BUTTON =
  "inline-flex h-[30px] items-center gap-1.5 rounded-md bg-[#F6F5F2] px-2.5 text-[13px] font-medium text-gray-500 hover:bg-gray-200 disabled:opacity-40";
const NO_BUTTON =
  "inline-flex h-14 items-center justify-center gap-2 rounded-[10px] border border-red-200 bg-red-50 text-base font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50";
const YES_BUTTON =
  "inline-flex h-14 items-center justify-center gap-2 rounded-[10px] bg-green-700 text-base font-semibold text-white hover:bg-green-800 disabled:opacity-50";

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
          <span className="text-sm text-gray-500">Not in Keepr yet · {n === 1 ? "1 email" : `${n} emails`}</span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <button type="button" className={NO_BUTTON} disabled={busy} onClick={() => void session.answerDeal("no")}>
            <X className="h-[18px] w-[18px]" strokeWidth={2.5} aria-hidden="true" />
            No
          </button>
          <button type="button" className={YES_BUTTON} disabled={busy} onClick={() => void session.answerDeal("yes")}>
            <Check className="h-[18px] w-[18px]" strokeWidth={2.5} aria-hidden="true" />
            Yes, my deal
          </button>
        </div>
        <span className="text-[13px] text-gray-500">The highlighted parts are what Keepr read.</span>
      </>
    );
  }
  const email = emails[0];
  const sender = splitSender(email?.sender ?? null);
  return (
    <>
      <h2 className="m-0 text-xl font-semibold leading-7">Is this real estate business, or a newsletter / spam?</h2>
      <div className="flex flex-col items-center gap-1">
        <span className="text-lg font-semibold leading-[26px]">{email?.subject || "(no subject)"}</span>
        <span className="text-sm text-gray-500">
          {sender.name}
          {email?.sentAt ? ` · ${formatLearnDate(email.sentAt, false)}` : ""}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          className={NO_BUTTON}
          disabled={busy}
          onClick={() => void session.answerMail("newsletter_spam")}
        >
          <X className="h-[18px] w-[18px]" strokeWidth={2.5} aria-hidden="true" />
          Newsletter or spam
        </button>
        <button type="button" className={YES_BUTTON} disabled={busy} onClick={() => void session.answerMail("real_estate")}>
          <Check className="h-[18px] w-[18px]" strokeWidth={2.5} aria-hidden="true" />
          Real estate business
        </button>
      </div>
      <span className="text-[13px] text-gray-500">Listing alerts and marketing mail count as newsletters.</span>
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

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent
        hideClose
        className="flex h-[640px] max-h-[calc(100vh-32px)] w-[1120px] max-w-[calc(100vw-32px)] flex-col gap-0 overflow-hidden rounded-xl border-0 bg-white p-0 text-[15px] leading-normal text-[#1C2430]"
      >
        <DialogTitle className="sr-only">Learn mode question</DialogTitle>
        <DialogDescription className="sr-only">Answer the question about the item on the left.</DialogDescription>
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 border-b border-[#EEECE7] px-5 py-3.5">
          <button
            type="button"
            className={`${TOP_BUTTON} justify-self-start`}
            disabled={session.busy || !session.current}
            onClick={() => void session.skip()}
          >
            <SkipForward className="h-3.5 w-3.5" aria-hidden="true" />
            Skip for now
          </button>
          <span className="flex flex-col items-center gap-1">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-sky-700">
              <Sparkle className="h-3 w-3" fill="currentColor" aria-hidden="true" />
              Learn mode
            </span>
            <span className="text-xs font-medium text-gray-500" data-testid="learn-question-progress">
              Question {Math.max(1, session.index)} of {Math.max(session.total, session.index, 1)}
            </span>
          </span>
          <button
            type="button"
            className={`${TOP_BUTTON} justify-self-end`}
            disabled={session.busy || !session.canUndo}
            onClick={() => void session.undo()}
          >
            <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
            Undo last
          </button>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-[1fr_420px]">
          <div className="flex min-h-0 flex-col border-r border-[#EEECE7]" key={questionKey}>
            <LeftPane session={session} />
          </div>
          <div className="flex flex-col justify-center gap-6 px-9 py-10 text-center">
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
