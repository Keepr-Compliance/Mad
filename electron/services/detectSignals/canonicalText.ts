/**
 * Canonical email text for detectSignals — BACKLOG-4257 (M3).
 *
 * Order (SR plan review, measured): stripHtmlQuotedContent(html) ->
 * htmlToPlainText -> stripPlainTextQuotedContent. The HTML quote patterns
 * (Outlook divRplyFwdMsg, blockquote type=cite, gmail_quote) only exist in
 * the HTML; converting first turns them into plain lines no stripper can see.
 *
 * Bounds (SR R3). The body is sender-controlled and the strippers run
 * synchronously in the main process:
 *   1. MAX_BODY_CHARS: after the two linear bounds below, the body is cut to
 *      this many characters BEFORE any stripping or conversion. Text past the
 *      cut is not read.
 *   2. Dash runs longer than MAX_DASH_RUN collapse to MAX_DASH_RUN dashes.
 *      stripHtmlQuotedContent's "-----Original Message-----" scan is quadratic
 *      in the length of a dash run (20k dashes measured at 1.44 s); a bounded
 *      run makes it linear. "-- " and "-----Original Message-----" survive.
 *   3. boundMarkup: unterminated tag openings are escaped, tags are cut to
 *      MAX_TAG_CHARS and their quotes balanced (see boundMarkup).
 *
 * Pure: no I/O, no logging.
 */
import { htmlToPlainText } from "../../utils/htmlToPlainText";
import { stripHtmlQuotedContent, stripPlainTextQuotedContent } from "../../utils/quoteStripping";

/** Characters of body read per message (HTML or plain). */
export const MAX_BODY_CHARS = 100_000;
/** Longest dash run passed to the quote strippers. */
export const MAX_DASH_RUN = 16;
/** Longest tag (from "<" to before ">") passed to the quote strippers. */
export const MAX_TAG_CHARS = 1024;

export interface CanonicalEmail {
  /** Lowercased subject, whitespace collapsed. */
  subject: string;
  /** Lowercased non-empty lines of the sender's own text (quotes removed). */
  ownLines: readonly string[];
  /** Lowercased non-empty lines of the whole body (quotes kept). */
  fullLines: readonly string[];
  /** The body was longer than MAX_BODY_CHARS and was cut. */
  truncated: boolean;
}

const DASH_RUN = new RegExp(`-{${MAX_DASH_RUN + 1},}`, "g");
const HTML_TAG = /<(?:html|div|p|br|table|span|head|body|style|meta|img|a|ul|ol|li|h[1-6]|blockquote)\b/i;

function capBody(body: string): { text: string; truncated: boolean } {
  if (body.length <= MAX_BODY_CHARS) return { text: body, truncated: false };
  return { text: body.slice(0, MAX_BODY_CHARS), truncated: true };
}

function boundDashRuns(text: string): string {
  return text.replace(DASH_RUN, "-".repeat(MAX_DASH_RUN));
}

/**
 * Bound the markup the quote strippers scan. One forward pass, linear:
 *   - A "<" followed by another "<" before any ">" cannot open a tag; it is
 *     escaped, so the `<div[^>]*` / `<hr[^>]*` scans cannot restart at every
 *     one of thousands of unterminated openings (100k chars of "<div"
 *     measured at 25 s).
 *   - A tag longer than MAX_TAG_CHARS is cut to that length, and an
 *     unbalanced quote inside a tag is closed before its ">". The strippers'
 *     `style=["'][^"']*X[^"']*Y` scans are cubic in the quote-free run they
 *     cross (8k chars measured at 0.55 s, 20k at 8 s) and, with an open
 *     quote, run past the tag's ">"; this confines each to one short tag.
 */
function boundMarkup(text: string): string {
  if (text.indexOf("<") < 0) return text;
  const out: string[] = [];
  let i = 0;
  // Next ">" at or after the current "<"; -1 once none is left. Cached so a
  // run of "<" with no ">" does not rescan the tail from every one of them.
  let gtCache = -2;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) {
      out.push(text.slice(i));
      break;
    }
    out.push(text.slice(i, lt));
    if (gtCache !== -1 && gtCache <= lt) gtCache = text.indexOf(">", lt + 1);
    const gt = gtCache;
    const nextLt = text.indexOf("<", lt + 1);
    if (nextLt >= 0 && (gt < 0 || nextLt < gt)) {
      out.push("&lt;");
      i = lt + 1;
      continue;
    }
    const end = gt < 0 ? text.length : gt;
    let tag = text.slice(lt, Math.min(end, lt + MAX_TAG_CHARS));
    if ((tag.split('"').length - 1) % 2 === 1) tag += '"';
    if ((tag.split("'").length - 1) % 2 === 1) tag += "'";
    out.push(tag, gt < 0 ? "" : ">");
    i = gt < 0 ? text.length : gt + 1;
  }
  return out.join("");
}

function toLines(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim().toLowerCase())
    .filter((l) => l.length > 0);
}

/** Build the canonical text of one message. */
export function canonicalizeEmail(input: {
  subject: string | null | undefined;
  bodyHtml: string | null | undefined;
  bodyPlain: string | null | undefined;
}): CanonicalEmail {
  const subject = (input.subject ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const html = typeof input.bodyHtml === "string" && input.bodyHtml.trim() ? input.bodyHtml : null;
  const plain = typeof input.bodyPlain === "string" ? input.bodyPlain : "";

  if (html && HTML_TAG.test(html)) {
    // Linear bounds first (a long data: URI tag shrinks to MAX_TAG_CHARS), then the cap.
    const { text: bounded, truncated } = capBody(boundMarkup(boundDashRuns(html)));
    const own = stripPlainTextQuotedContent(htmlToPlainText(stripHtmlQuotedContent(bounded)));
    const full = htmlToPlainText(bounded);
    return { subject, ownLines: toLines(own), fullLines: toLines(full), truncated };
  }

  const source = html ?? plain;
  const { text: bounded, truncated } = capBody(boundDashRuns(source.replace(/\r\n?/g, "\n")));
  const own = stripPlainTextQuotedContent(bounded);
  return { subject, ownLines: toLines(own), fullLines: toLines(bounded), truncated };
}
