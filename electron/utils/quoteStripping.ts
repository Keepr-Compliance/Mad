/**
 * Quote stripping for email bodies — BACKLOG-4257 (moved verbatim from
 * electron/services/folderExport/emailExportHelpers.ts, which re-exports both).
 *
 * Pure: no imports, no I/O, no logging. Lives here so modules that must not
 * reach the database or the logger (electron/services/detectSignals/) can use it;
 * emailExportHelpers.ts imports exportUtils, which imports dbConnection and
 * logService.
 */

/**
 * Strip quoted content from HTML email bodies.
 * Handles Outlook (Graph API), Gmail, Proton Mail, and generic email reply patterns.
 *
 * TECH DEBT: The caller injects raw HTML body content into PDF templates without
 * sanitization. This is a known XSS risk -- malicious email HTML could contain
 * <script>, <iframe>, or event handlers. Since PDFs are rendered in a temporary
 * BrowserWindow, this could execute code in Electron's context. A proper HTML
 * sanitizer (e.g. sanitize-html) should be applied before injection.
 * See backlog for tracking.
 */
export function stripHtmlQuotedContent(html: string): string {
  let result = html;

  // --- Outlook / Microsoft Graph patterns ---
  // Outlook mobile separator line + <hr> + divRplyFwdMsg (entire quoted block)
  result = result.replace(/<div[^>]*id=["']ms-outlook-mobile-body-separator-line["'][^>]*>[\s\S]*$/gi, "");
  // Outlook reply divider: <hr tabindex="-1" ...> followed by <div id="divRplyFwdMsg">
  result = result.replace(/<hr[^>]*tabindex=["']-1["'][^>]*>[\s\S]*$/gi, "");
  // Outlook reply divider: <div id="divRplyFwdMsg"> or <div id="x_divRplyFwdMsg">
  result = result.replace(/<div[^>]*id=["'](?:x_)?divRplyFwdMsg["'][^>]*>[\s\S]*$/gi, "");
  // Outlook separator: <hr> with display:inline-block (Outlook-specific pattern)
  result = result.replace(/<hr[^>]*style=["'][^"']*display:\s*inline-block[^"']*border-top[^"']*["'][^>]*>[\s\S]*$/gi, "");
  result = result.replace(/<hr[^>]*style=["'][^"']*border-top[^"']*display:\s*inline-block[^"']*["'][^>]*>[\s\S]*$/gi, "");
  // Outlook "From:" block: uses border:none + border-top (Outlook's specific separator pattern)
  result = result.replace(/<div[^>]*style=["'][^"']*border:\s*none[^"']*border-top[^"']*["'][^>]*>[\s\S]*$/gi, "");

  // --- Proton Mail patterns ---
  // Proton Mail wraps quotes in <div class="protonmail_quote">...<blockquote class="protonmail_quote">
  result = result.replace(/<div[^>]*class=["'][^"']*protonmail_quote[^"']*["'][^>]*>[\s\S]*$/gi, "");

  // --- Gmail patterns ---
  // Gmail quoted blocks: <div class="gmail_quote">...</div> (greedy to end -- quote is always last)
  result = result.replace(/<div[^>]*class=["'][^"']*gmail_quote[^"']*["'][^>]*>[\s\S]*$/gi, "");
  // Gmail blockquotes: <blockquote class="gmail_quote">
  result = result.replace(/<blockquote[^>]*class=["'][^"']*gmail_quote[^"']*["'][^>]*>[\s\S]*?<\/blockquote>/gi, "");

  // --- Generic patterns ---
  // Generic <blockquote> with type="cite" (used by many clients for quoted replies)
  result = result.replace(/<blockquote[^>]*type=["']cite["'][^>]*>[\s\S]*?<\/blockquote>/gi, "");
  // "-----Original Message-----" text (Outlook plain-style within HTML)
  result = result.replace(/<div[^>]*>-{3,}\s*Original Message\s*-{3,}[\s\S]*$/gi, "");
  result = result.replace(/-{3,}\s*Original Message\s*-{3,}[\s\S]*$/gi, "");
  // "On [date] ... wrote:" lines (Gmail/Apple Mail reply headers)
  result = result.replace(/<div[^>]*>On\s.{10,80}\s+wrote:\s*<\/div>/gi, "");
  result = result.replace(/<p[^>]*>On\s.{10,80}\s+wrote:\s*<\/p>/gi, "");

  return result.trim();
}

/**
 * Strip quoted content from plain text email bodies.
 * Removes lines starting with ">", "On ... wrote:" headers, and "Original Message" dividers.
 */
export function stripPlainTextQuotedContent(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  for (const line of lines) {
    // Stop at "On ... wrote:" line
    if (/^On\s.{10,80}\s+wrote:\s*$/i.test(line.trim())) break;
    // Stop at "-----Original Message-----"
    if (/^-{3,}\s*Original Message\s*-{3,}/i.test(line.trim())) break;
    // Skip quoted lines (starting with >)
    if (/^\s*>/.test(line)) continue;
    result.push(line);
  }
  return result.join("\n").trim();
}
