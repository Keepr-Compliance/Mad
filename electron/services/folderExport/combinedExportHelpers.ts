/**
 * Combined PDF Export Helpers (BACKLOG-1584)
 *
 * Assembles a SINGLE HTML document containing:
 *   1. an index page (reusing the current summary look), where each Email/Text
 *      index row becomes both a clickable title AND a "View Full →" link that
 *      jumps to that item's full section, and
 *   2. the full email-thread and text-thread sections (reusing the current
 *      per-file renderers so output is pixel-identical to today's exports),
 *      each wrapped in an id-anchored container with a visible back-link.
 *
 * Rendering this ONE document once via Chromium `printToPDF` preserves the
 * internal `<a href="#...">` links natively — which the previous per-section
 * PDF + pdf-lib merge dropped.
 *
 * CSS scoping is critical: the section `<style>` blocks reuse colliding class
 * names (`.header`, `.footer`, `.note`, `.meta`, `.message`, `.badge`, `body`,
 * …). In one document they cross-contaminate, so each section's rules are
 * scoped to a wrapper container and only a single global `*` reset is emitted
 * at the document level.
 */

/**
 * Anchor/id constants for the index section headings.
 * These are the back-link targets for the full sections.
 */
export const EMAIL_INDEX_ANCHOR = "email-threads-index";
export const TEXT_INDEX_ANCHOR = "text-threads-index";

/** Section id for the i-th email thread (0-based). */
export const emailThreadSectionId = (i: number): string => `email-thread-${i}`;
/** Section id for the i-th text thread (0-based). */
export const textThreadSectionId = (i: number): string => `text-thread-${i}`;
/** Index-row id for the i-th text thread (0-based) — the exact back-link target. */
export const textIndexRowId = (i: number): string => `text-idx-${i}`;

/**
 * Extract the inner content of the first `<style>...</style>` block and the
 * inner content of the `<body>...</body>` from a full HTML document produced
 * by one of the section renderers.
 *
 * Falls back gracefully: if a `<style>`/`<body>` is missing, returns empty
 * string / the original html respectively.
 */
export function extractStyleAndBody(fullHtml: string): { style: string; body: string } {
  const styleMatch = fullHtml.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  const bodyMatch = fullHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return {
    style: styleMatch ? styleMatch[1] : "",
    body: bodyMatch ? bodyMatch[1] : fullHtml,
  };
}

/**
 * Scope a block of CSS rules to a container selector.
 *
 * Each top-level rule's selector list is prefixed with `.${containerClass} `
 * so that, e.g. `.header { … }` becomes `.doc-summary .header { … }`.
 *
 * Handling:
 *  - The universal reset `* { … }` is DROPPED (a single global reset is emitted
 *    once at the document level) so it does not get scoped and lose its effect.
 *  - `@media print { … }` (and other simple at-rule blocks) have their INNER
 *    rules scoped, and the wrapper is preserved.
 *  - `@page`/`@font-face`/`@keyframes` at-rules are passed through unscoped.
 *  - `body` selectors are rewritten to the container itself (the body styles —
 *    padding/color/font — should apply to the section wrapper).
 */
export function scopeCss(css: string, containerClass: string): string {
  const prefix = `.${containerClass}`;
  const out: string[] = [];
  let i = 0;
  const n = css.length;

  while (i < n) {
    // Skip whitespace
    while (i < n && /\s/.test(css[i])) i++;
    if (i >= n) break;

    // At-rule?
    if (css[i] === "@") {
      const atStart = i;
      // Read the at-rule prelude up to `{` or `;`
      while (i < n && css[i] !== "{" && css[i] !== ";") i++;
      const prelude = css.slice(atStart, i).trim();

      if (css[i] === ";") {
        // e.g. @import — pass through
        out.push(prelude + ";");
        i++; // consume ';'
        continue;
      }

      // css[i] === '{' — read the balanced block
      const block = readBalancedBlock(css, i);
      i = block.end; // position past the closing '}'
      const inner = block.inner;

      const lower = prelude.toLowerCase();
      if (lower.startsWith("@media") || lower.startsWith("@supports")) {
        // Scope the inner rules, keep the wrapper
        out.push(`${prelude} {\n${scopeCss(inner, containerClass)}\n}`);
      } else {
        // @page / @font-face / @keyframes / etc. — pass through unchanged
        out.push(`${prelude} {${inner}}`);
      }
      continue;
    }

    // Normal rule: read selector up to `{`
    const selStart = i;
    while (i < n && css[i] !== "{") i++;
    if (i >= n) break; // malformed tail — ignore
    const selectorList = css.slice(selStart, i).trim();

    const block = readBalancedBlock(css, i);
    i = block.end;
    const body = block.inner.trim();

    const scopedSelector = selectorList
      .split(",")
      .map((sel) => {
        const s = sel.trim();
        if (!s) return "";
        // Drop the universal reset — a single global reset is emitted separately.
        if (s === "*") return null;
        // Body styles apply to the section container itself.
        if (s === "body") return prefix;
        return `${prefix} ${s}`;
      })
      .filter((s): s is string => s !== null && s !== "")
      .join(", ");

    if (scopedSelector) {
      out.push(`${scopedSelector} { ${body} }`);
    }
  }

  return out.join("\n");
}

/**
 * Read a `{ … }` block starting at `css[start] === '{'`, respecting nesting.
 * Returns the inner content (between the outermost braces) and `end` = index
 * just past the matching closing brace.
 */
function readBalancedBlock(css: string, start: number): { inner: string; end: number } {
  let depth = 0;
  let i = start;
  const n = css.length;
  let innerStart = start + 1;
  for (; i < n; i++) {
    const ch = css[i];
    if (ch === "{") {
      depth++;
      if (depth === 1) innerStart = i + 1;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return { inner: css.slice(innerStart, i), end: i + 1 };
      }
    }
  }
  // Unbalanced — return the rest
  return { inner: css.slice(innerStart), end: n };
}

/** A full section (email/text thread) rendered by an existing helper. */
export interface CombinedSection {
  /** id anchor for this section's wrapper (link target from the index). */
  id: string;
  /** Full HTML document produced by the section renderer. */
  html: string;
  /** href for the visible back-link at the bottom of this section. */
  backHref: string;
  /** Visible label for the back-link. */
  backLabel: string;
}

/**
 * Post-process the summary (index) HTML to inject internal links.
 *
 * The summary renderer emits, in order:
 *  - `<h3>Email Threads Index (N)</h3>` followed by `.email-item` rows
 *  - `<h3>Text Threads Index (N)</h3>` followed by `.text-item` rows
 *
 * We:
 *  - give the two headings anchor ids (EMAIL_INDEX_ANCHOR / TEXT_INDEX_ANCHOR),
 *  - wrap each email row's `.subject` span in an `<a>` to its thread section and
 *    append a "View Full →" link,
 *  - give each text row an id (textIndexRowId), wrap its `.contact` span in an
 *    `<a>` to its section and append a "View Full →" link.
 *
 * When `summaryOnly` is true we ONLY add the heading anchor ids (no links),
 * mirroring the old service (only emit links when target content exists).
 *
 * @param emailRowTargets  section id for the i-th email index row (per-email
 *                         → the thread section that contains that email).
 * @param textRowTargets   section id for the i-th text index row.
 */
export function injectIndexLinks(
  summaryHtml: string,
  emailRowTargets: string[],
  textRowTargets: string[],
  summaryOnly: boolean
): string {
  let html = summaryHtml;

  // Give the index headings anchor ids so full sections can link back to them.
  html = html.replace(
    /<h3>(\s*Email Threads Index[^<]*)<\/h3>/i,
    `<h3 id="${EMAIL_INDEX_ANCHOR}">$1</h3>`
  );
  html = html.replace(
    /<h3>(\s*Text Threads Index[^<]*)<\/h3>/i,
    `<h3 id="${TEXT_INDEX_ANCHOR}">$1</h3>`
  );

  if (summaryOnly) {
    return html;
  }

  // Wrap email index rows. Rows appear in the SAME order the summary renders
  // them (chronological, oldest first), so index N maps to emailRowTargets[N].
  let emailRowIdx = 0;
  html = html.replace(
    /<div class="email-item">([\s\S]*?)<\/div>\s*<\/div>/g,
    (match, inner: string) => {
      const target = emailRowTargets[emailRowIdx];
      emailRowIdx++;
      if (!target) return match;
      // Make the subject a clickable link to the thread section.
      const linkedInner = inner.replace(
        /<span class="subject">([\s\S]*?)<\/span>/,
        `<span class="subject"><a class="index-link" href="#${target}">$1</a></span>` +
          `<a class="view-full-link" href="#${target}">View Full &rarr;</a>`
      );
      return `<div class="email-item">${linkedInner}</div></div>`;
    }
  );

  // Wrap text index rows, giving each an id and a link to its section.
  let textRowIdx = 0;
  html = html.replace(
    /<div class="text-item">([\s\S]*?)<\/div>\s*<\/div>/g,
    (match, inner: string) => {
      const idx = textRowIdx;
      const target = textRowTargets[idx];
      textRowIdx++;
      if (!target) return match;
      const linkedInner = inner.replace(
        /<span class="contact">([\s\S]*?)<\/span>/,
        `<span class="contact"><a class="index-link" href="#${target}">$1</a></span>` +
          `<a class="view-full-link" href="#${target}">View Full &rarr;</a>`
      );
      return `<div class="text-item" id="${textIndexRowId(idx)}">${linkedInner}</div></div>`;
    }
  );

  return html;
}

/**
 * Assemble the single combined HTML document.
 *
 * @param indexHtml   summary HTML AFTER link injection (full doc from renderer).
 * @param sections    full sections in render order (emails then texts). Empty
 *                    when `summaryOnly`.
 */
export function buildCombinedHTML(indexHtml: string, sections: CombinedSection[]): string {
  const indexParts = extractStyleAndBody(indexHtml);

  const styleBlocks: string[] = [scopeCss(indexParts.style, "doc-summary")];
  const bodyBlocks: string[] = [
    `<div class="doc-section doc-summary">${indexParts.body}</div>`,
  ];

  for (const section of sections) {
    const parts = extractStyleAndBody(section.html);
    // Derive a container class from the id prefix (email-thread / text-thread).
    const containerClass = section.id.startsWith("email-")
      ? "doc-email-thread"
      : "doc-text-thread";
    styleBlocks.push(scopeCss(parts.style, containerClass));

    const backLink =
      `<a class="doc-back-link" href="${section.backHref}">` +
      `&larr; ${section.backLabel}</a>`;

    bodyBlocks.push(
      `<div class="doc-section ${containerClass} doc-page-break" id="${section.id}">` +
        `${backLink}${parts.body}${backLink}` +
        `</div>`
    );
  }

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    /* Single global reset (section resets are dropped during scoping). */
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { background: white; }
    .doc-section { position: relative; }
    /* Mirror today's per-PDF page boundaries between sections. */
    .doc-page-break { page-break-before: always; }
    .doc-back-link {
      display: inline-block;
      color: #667eea;
      text-decoration: none;
      font-size: 13px;
      font-weight: 500;
      margin: 0 40px 16px;
    }
    .doc-back-link:hover { text-decoration: underline; }
    .index-link { color: inherit; text-decoration: none; }
    .index-link:hover { text-decoration: underline; }
    .view-full-link {
      color: #667eea;
      text-decoration: none;
      font-size: 12px;
      font-weight: 500;
      margin-left: 8px;
    }
    .view-full-link:hover { text-decoration: underline; }
${styleBlocks.join("\n")}
  </style>
</head>
<body>
${bodyBlocks.join("\n")}
</body>
</html>`;
}
