/**
 * Learn mode: the email on the left of a question (boards L2/L3) — BACKLOG-4120 PR3.
 *
 * Rich, sanitized HTML (learnEmailHtml.ts). Remote images are blocked until
 * "Show images" is pressed, for THIS message only: the parent remounts the
 * pane for every question, so the choice never carries to the next one.
 * Attachments are listed by name only; nothing here downloads anything.
 */
import React, { useMemo, useState } from "react";
import type { LearnPreviewEmail } from "../../../../electron/types/ipc/window-api-learn";
import {
  HIGHLIGHT_CLASS,
  highlightHtml,
  highlightText,
  sanitizeLearnEmailHtml,
  streetPhraseRegex,
} from "./learnEmailHtml";

/**
 * Long lines wrap anywhere; tables, images and pre blocks are capped at the pane's
 * width. A fixed-width table that still cannot shrink scrolls sideways inside the
 * scroll box, never the dialog (BACKLOG-4120).
 */
export const EMAIL_WRAP =
  "[overflow-wrap:anywhere] [word-break:break-word] [&_table]:max-w-full [&_img]:max-w-full [&_img]:h-auto [&_pre]:max-w-full [&_pre]:whitespace-pre-wrap";

export function formatLearnDate(iso: string | null, withTime: boolean): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", withTime
    ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric" });
}

export function splitSender(sender: string | null): { name: string; address: string | null } {
  if (!sender) return { name: "", address: null };
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(sender);
  if (m) return { name: m[1].trim() || m[2].trim(), address: m[2].trim() };
  return { name: sender.trim(), address: null };
}

export function LearnEmailPane({
  email,
  highlightAddress,
}: {
  email: LearnPreviewEmail;
  /** The deal address Keepr read (deal questions); null for mail questions. */
  highlightAddress: string | null;
}): React.ReactElement {
  const [showImages, setShowImages] = useState(false);
  const re = useMemo(() => (highlightAddress ? streetPhraseRegex(highlightAddress) : null), [highlightAddress]);
  const raw = email.bodyHtml;
  // The images-off pass also says whether "Show images" would load anything
  // (hasRemoteImages is the same decision).
  const imagesOff = useMemo(() => (raw ? sanitizeLearnEmailHtml(raw, { showImages: false }) : null), [raw]);
  const body = useMemo(() => {
    if (!raw || !imagesOff) return null;
    const html = showImages ? sanitizeLearnEmailHtml(raw, { showImages: true }).html : imagesOff.html;
    return highlightHtml(html, re);
  }, [raw, imagesOff, showImages, re]);
  const remote = (imagesOff?.blockedImages ?? 0) > 0;
  const sender = splitSender(email.sender);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-white" data-testid="learn-email-pane">
      <div className="flex flex-col gap-1 border-b border-[#EEECE7] px-5 py-4 text-[13px]">
        <span className="text-base font-semibold">{email.subject || "(no subject)"}</span>
        <span>
          <b>{sender.name}</b>
          {sender.address && <span className="text-gray-500"> &lt;{sender.address}&gt;</span>}
        </span>
        <span className="text-gray-500">To: you · {formatLearnDate(email.sentAt, true)}</span>
      </div>
      {remote && !showImages && (
        <div className="flex items-center justify-between gap-3 border-b border-[#EEECE7] bg-[#FAF9F7] px-5 py-2 text-xs text-gray-600">
          <span>Images are hidden so the sender cannot tell you opened this.</span>
          <button
            type="button"
            onClick={() => setShowImages(true)}
            className="rounded-md border border-gray-300 bg-white px-2.5 py-1 font-medium text-gray-700 hover:bg-gray-50"
          >
            Show images
          </button>
        </div>
      )}
      {/* Contained: nothing in the email can paint outside this box or above the question. */}
      <div
        className="relative isolate min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-auto px-5 py-5 text-[13px] [contain:paint]"
        data-testid="learn-email-scroll"
      >
        {body !== null ? (
          <div
            className={`learn-email-body ${EMAIL_WRAP}`}
            data-testid="learn-email-body"
            dangerouslySetInnerHTML={{ __html: body }}
          />
        ) : (
          <div className={`whitespace-pre-wrap ${EMAIL_WRAP}`} data-testid="learn-email-body">
            {highlightText(email.bodyPlain ?? "", re).map((run, i) =>
              run.mark ? (
                <mark key={i} className={HIGHLIGHT_CLASS}>
                  {run.text}
                </mark>
              ) : (
                <React.Fragment key={i}>{run.text}</React.Fragment>
              ),
            )}
          </div>
        )}
        {email.attachments.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2" data-testid="learn-email-attachments">
            {email.attachments.map((a) => (
              <span
                key={a.id}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[#E6E4DF] px-2.5 text-xs"
              >
                {a.filename}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
