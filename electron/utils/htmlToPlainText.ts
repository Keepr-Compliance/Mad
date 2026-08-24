/**
 * BACKLOG-2855 — derive plain text from an HTML email body, in the MAIN process.
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * `emails.body_plain` is not a display convenience. It is the column that
 * search (`transactionSearchDbService.ts:443/1097/1252` — `e.body_plain LIKE ?`,
 * and ZERO references to `body_html` anywhere in that file) and auto-link
 * (`autoLinkService.ts:330/368` — `subject + body_plain`) read. Whatever is not
 * in this column is, for those two features, not in the email.
 *
 * Before this module, `outlookFetchService` wrote Microsoft Graph's
 * `bodyPreview` into that column for every message Graph reported as
 * `contentType: "html"` — i.e. nearly every real business email. Graph
 * documents `bodyPreview` as "The first 255 characters of the message body"
 * (Microsoft Graph v1.0, `message` resource), so a term appearing later in the
 * message was unfindable and an address later in the message could not
 * auto-link. The full HTML was already being fetched and stored; it was
 * discarded at the mapper.
 *
 * WHY IT IS HAND-WRITTEN
 * ----------------------
 * There is no DOM in the Electron main process and no HTML parsing library in
 * `package.json`. The renderer has its own DOM-based equivalent
 * (`EmailThreadViewModal.getPlainTextPreview`, which builds a detached `div` and
 * reads `textContent`); that one is NOT reusable here and is deliberately left
 * alone. Sharing a module across the main/renderer boundary does not work in
 * either direction — `electron/` cannot import from `src/` (`rootDir`), and the
 * renderer cannot value-import from `electron/` (Vite parses it as JavaScript) —
 * so a shared implementation would need a third home plus a parity test. That is
 * a larger change than this fix, and is NOT done here.
 *
 * WHAT IT IS NOT
 * --------------
 * Not a sanitizer. Output is plain text destined for a SQL text column, LIKE
 * matching and substring scanning. It is never re-inserted into a DOM. Rendering
 * still uses `body_html` through the renderer's DOMPurify path.
 *
 * ORDER OF OPERATIONS (it is load-bearing)
 * ----------------------------------------
 *   1. Drop `<script>` / `<style>` blocks INCLUDING their content. CSS text is
 *      not message text; leaving it in would pollute search with rule bodies.
 *   2. Drop HTML comments. Outlook wraps MSO-only markup in conditional
 *      comments (`<!--[if mso]>…<![endif]-->`) whose content is not visible text,
 *      and its `<style>` blocks nest a comment inside.
 *   3. Collapse ALL source whitespace to single spaces, BEFORE any tag is turned
 *      into a newline. This is what a browser does with whitespace in a text
 *      node, and it is why a paragraph soft-wrapped across several source lines
 *      does not gain a newline in the middle of a phrase — which would break
 *      `body_plain LIKE '%123 Main Street%'`. Cost: `<pre>` formatting is not
 *      preserved. Accepted; email bodies effectively never rely on it, and
 *      search matters more than layout in this column.
 *   4. `<br>` and closing block tags become newlines; `</td>`/`</th>` become a
 *      single space so `<td>A</td><td>B</td>` yields "A B" and not "AB".
 *   5. Strip whatever tags remain.
 *   6. Decode entities — AFTER tag stripping, never before. `&lt;b&gt;` is text
 *      that a sender typed, not markup, and decoding first would let it become a
 *      tag and be stripped. Inside the decoder, `&amp;` is decoded LAST so
 *      `&amp;lt;` yields the literal text `&lt;` rather than double-decoding.
 *   7. Tidy: per-line trim, collapse runs of blank lines, trim the whole thing.
 */

/**
 * Decode the HTML entities that actually occur in mail bodies.
 *
 * `&nbsp;` deliberately decodes to a REGULAR space (U+0020), not U+00A0.
 * Outlook emits `&nbsp;` between words constantly, and a non-breaking space
 * stored in `body_plain` silently defeats `body_plain LIKE '%two words%'` — the
 * exact failure this module exists to remove.
 *
 * `&amp;` is decoded LAST. Decoding it first turns `&amp;lt;` into `&lt;` and
 * then into `<`, inventing markup the sender never wrote.
 */
function decodeHtmlEntities(input: string): string {
  let out = input;

  // Named entities (case-insensitive: senders and mail clients emit `&NBSP;`).
  out = out.replace(/&nbsp;/gi, " ");
  out = out.replace(/&lt;/gi, "<");
  out = out.replace(/&gt;/gi, ">");
  out = out.replace(/&quot;/gi, '"');
  out = out.replace(/&apos;/gi, "'");

  // Numeric entities, hexadecimal (`&#x27;`) then decimal (`&#39;`).
  // Out-of-range or surrogate code points are left as literal text rather than
  // throwing — a malformed entity must never cost us the whole message body.
  const fromCodePoint = (code: number, original: string): string => {
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return original;
    if (code >= 0xd800 && code <= 0xdfff) return original;
    try {
      return String.fromCodePoint(code);
    } catch {
      return original;
    }
  };
  out = out.replace(/&#x([0-9a-f]+);/gi, (m, hex: string) =>
    fromCodePoint(parseInt(hex, 16), m),
  );
  out = out.replace(/&#(\d+);/g, (m, dec: string) =>
    fromCodePoint(parseInt(dec, 10), m),
  );

  // MUST stay last — see the doc comment above.
  out = out.replace(/&amp;/gi, "&");

  return out;
}

/**
 * Closing tags that end a visual block and therefore earn a line break.
 * `</td>` and `</th>` are handled separately (space, not newline) so table rows
 * read as one line of words rather than one word per line.
 */
const BLOCK_CLOSE_TAGS =
  /<\/(?:p|div|tr|li|h[1-6]|blockquote|table|ul|ol|section|article|pre|address|figure|dd|dt|dl)\s*>/gi;

const CELL_CLOSE_TAGS = /<\/(?:td|th)\s*>/gi;

const LINE_BREAK_TAGS = /<br\s*\/?\s*>/gi;

/**
 * Convert an HTML email body to plain text suitable for `emails.body_plain`.
 *
 * Returns `""` for null/undefined/empty input, so callers can use
 * `htmlToPlainText(x) || fallback` and have an empty body fall through.
 *
 * @param html Raw HTML (Graph `message.body.content`, or a Gmail `text/html`
 *   MIME part). Non-HTML plain text passed in survives essentially unchanged,
 *   apart from whitespace collapsing and any `<…>` sequence being read as a tag.
 */
export function htmlToPlainText(html: string | null | undefined): string {
  if (!html || typeof html !== "string") return "";

  let text = html;

  // 1. Script/style blocks, content included — in a SINGLE pass.
  //
  //    End-of-input is an ALTERNATE terminator (`|$`). That is what handles an
  //    UNTERMINATED block, which a browser also swallows to end of document;
  //    without it a truncated `<style>` would dump CSS into the search column.
  //
  //    This was two passes (closed blocks, then a second sweep for an
  //    unterminated one) and that shape is QUADRATIC on repeated unclosed
  //    openings: the closed-block pass restarts a full close-tag search from
  //    every one of them. This function runs in the MAIN process,
  //    synchronously, during sync, on HTML supplied by whoever sent the mail —
  //    so the quadratic case was a remote freeze, once per message. Measured:
  //    1 MB of `<script>` openings took 16,927 ms two-pass, ~1 ms this way.
  //    The perf guard in the test suite fails at 2 s if this ever regresses.
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, " ");

  // 2. Comments (includes Outlook's `<!--[if mso]>…<![endif]-->` blocks).
  text = text.replace(/<!--[\s\S]*?-->/g, " ");

  // 3. Source whitespace → single spaces, before any tag becomes a newline.
  text = text.replace(/\s+/g, " ");

  // 4. Structural tags → whitespace with meaning.
  text = text.replace(LINE_BREAK_TAGS, "\n");
  text = text.replace(CELL_CLOSE_TAGS, " ");
  text = text.replace(BLOCK_CLOSE_TAGS, "\n");

  // 5. Everything else that looks like a tag.
  text = text.replace(/<[^>]*>/g, "");

  // 6. Entities (see decodeHtmlEntities — order matters).
  text = decodeHtmlEntities(text);

  // 7. Tidy. Entity decoding can introduce CR/LF (`&#13;`, `&#10;`), so
  //    normalize line endings here rather than earlier.
  text = text.replace(/\r\n?/g, "\n");
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t\u00A0]+/g, " ").trim())
    .join("\n");
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

export default htmlToPlainText;
