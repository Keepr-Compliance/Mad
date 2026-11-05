/**
 * Learn mode email preview: sanitizing and highlighting — BACKLOG-4120 PR3.
 *
 * Founder rules (2026-11-04): the preview shows the RICH email (formatted
 * HTML, sanitized); remote images are BLOCKED by default with a per-email
 * "Show images" button; embedded images display.
 *
 * This is a separate sanitizer on purpose. EmailViewModal's keeps remote
 * `src` and `style`, so reusing it would load tracking pixels and CSS
 * `url(...)` backgrounds from ~200 newsletters while the user labels them.
 *
 * Blocked (images off):  http(s) `src`, every `srcset`, `background`, and any
 *                        `url(...)` inside `style`.
 * Always kept:           `data:image/...` sources (already inside the message).
 * Never resolvable:      `cid:` parts. The local database stores no content id
 *                        for an inline part, so they render as a placeholder.
 * Links are inert:       `href` is never kept.
 *
 * Pure apart from DOMPurify and the DOM it parses into; no I/O, no logging.
 */
import DOMPurify from "dompurify";

const ALLOWED_TAGS = [
  "p", "br", "div", "span", "a", "b", "i", "strong", "em", "u", "s", "small", "sup", "sub",
  "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "font", "center",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col",
  "img", "blockquote", "pre", "code", "hr", "mark",
];

const ALLOWED_ATTR = ["src", "alt", "style", "width", "height", "align", "valign", "colspan", "rowspan", "color", "class"];

/** Placeholder for an inline (cid:) image the database cannot resolve. */
export const INLINE_IMAGE_PLACEHOLDER = "[inline image]";

const CID_IMG = /<img\b[^>]*\ssrc\s*=\s*["']?cid:[^"'\s>]*["']?[^>]*>/gi;
const CSS_URL = /url\s*\([^)]*\)/gi;

export interface SanitizedEmail {
  html: string;
  /** Remote images (and CSS url() sources) removed because images are off. */
  blockedImages: number;
}

export function sanitizeLearnEmailHtml(raw: string, opts: { showImages: boolean }): SanitizedEmail {
  let blocked = 0;
  const withPlaceholders = raw.replace(
    CID_IMG,
    `<span class="learn-inline-image">${INLINE_IMAGE_PLACEHOLDER}</span>`,
  );

  DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
    const name = data.attrName;
    const value = (data.attrValue ?? "").trim();
    if (name === "src") {
      if (/^data:image\//i.test(value)) return;
      if (/^https?:/i.test(value) && opts.showImages) return;
      if (/^https?:/i.test(value)) blocked += 1;
      data.keepAttr = false;
      return;
    }
    if (name === "style" && CSS_URL.test(value)) {
      CSS_URL.lastIndex = 0;
      if (!opts.showImages) {
        blocked += 1;
        data.attrValue = value.replace(CSS_URL, "none");
      }
    }
    CSS_URL.lastIndex = 0;
  });
  try {
    const html = DOMPurify.sanitize(withPlaceholders, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      ALLOW_DATA_ATTR: false,
      FORBID_ATTR: ["href", "srcset", "background", "onerror", "onload", "onclick", "onmouseover"],
    });
    return { html: String(html), blockedImages: blocked };
  } finally {
    DOMPurify.removeHook("uponSanitizeAttribute");
  }
}

/** True when the raw message has something "Show images" would load. */
export function hasRemoteImages(raw: string): boolean {
  return /<img\b[^>]*\ssrc\s*=\s*["']?https?:/i.test(raw) || /url\s*\(\s*["']?https?:/i.test(raw);
}

// ---------------------------------------------------------------------------
// What Keepr read: the deal's street line
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The street line of an address ("1428 Example St" of "1428 Example St, Portland"). */
export function streetLine(address: string): string {
  return (address.split(/[,\n]/)[0] ?? "").trim();
}

/** The street line as one phrase, any whitespace between words. Null when empty. */
export function streetPhraseRegex(address: string): RegExp | null {
  const words = streetLine(address).split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  return new RegExp(words.map(escapeRegExp).join("\\s+"), "gi");
}

/**
 * The street number and the street-name words (3+ letters) as separate
 * terms: a PDF text layer splits a line into pieces, so a phrase rarely
 * survives in one piece.
 */
export function streetTokenRegex(address: string): RegExp | null {
  const words = streetLine(address)
    .split(/\s+/)
    .filter((w, i) => (i === 0 ? /\d/.test(w) : w.replace(/[^A-Za-z]/g, "").length >= 3));
  if (words.length === 0) return null;
  return new RegExp(`\\b(?:${words.map(escapeRegExp).join("|")})\\b`, "gi");
}

export const HIGHLIGHT_CLASS = "rounded-sm bg-yellow-100 px-0.5";

/** Wrap every match in text nodes of sanitized HTML with <mark>. */
export function highlightHtml(html: string, re: RegExp | null): string {
  if (!re || typeof document === "undefined") return html;
  const template = document.createElement("template");
  template.innerHTML = html;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
  for (const text of texts) {
    const value = text.nodeValue ?? "";
    const runs = highlightText(value, re);
    if (!runs.some((r) => r.mark)) continue;
    const frag = document.createDocumentFragment();
    for (const run of runs) {
      if (!run.mark) {
        frag.appendChild(document.createTextNode(run.text));
        continue;
      }
      const mark = document.createElement("mark");
      mark.className = HIGHLIGHT_CLASS;
      mark.textContent = run.text;
      frag.appendChild(mark);
    }
    text.parentNode?.replaceChild(frag, text);
  }
  return template.innerHTML;
}

/** Split plain text into runs, marking matches. */
export function highlightText(text: string, re: RegExp | null): Array<{ text: string; mark: boolean }> {
  if (!re) return [{ text, mark: false }];
  const out: Array<{ text: string; mark: boolean }> = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (m[0].length === 0) continue;
    if (at > last) out.push({ text: text.slice(last, at), mark: false });
    out.push({ text: m[0], mark: true });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), mark: false });
  return out;
}

/** HTML-escape a PDF text-layer string, then mark the matches. */
export function highlightPdfText(str: string, re: RegExp | null): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return highlightText(str, re)
    .map((r) => (r.mark ? `<mark class="${HIGHLIGHT_CLASS}">${esc(r.text)}</mark>` : esc(r.text)))
    .join("");
}

/**
 * The detection's address is stored normalised to lower case
 * ("4120 canarytest lane, testville, zz 00000"). Shown with each word
 * capitalised and a two-letter state in capitals.
 */
export function displayAddress(address: string): string {
  return address
    .split(",")
    .map((part, i) =>
      part.replace(/[A-Za-z][A-Za-z'’]*/g, (w) =>
        i > 0 && /^[a-z]{2}$/i.test(w) && /\b[a-z]{2}\b\s*\d*\s*$/i.test(part.trim())
          ? w.toUpperCase()
          : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
      ),
    )
    .join(",");
}
