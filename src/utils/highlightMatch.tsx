/**
 * highlightMatch (BACKLOG-2248)
 *
 * Presentational search-term highlighter. Given a piece of display text and the
 * user's raw search term, it splits the text on case-insensitive occurrences of
 * the term and wraps each occurrence in a subtle <mark>, so search results can
 * show WHAT matched (subject/body/sender and 📎 attachment filenames).
 *
 * Intentionally dumb + purely visual:
 *   - The term is treated as a LITERAL substring — regex special characters are
 *     escaped, so queries like "a.b" or "(x)" never throw and only match literally.
 *   - Matching is case-insensitive; the ORIGINAL casing of the text is preserved
 *     in the output (we split the source text, we never rewrite it).
 *   - When the term is empty or is not present in the text, the original string is
 *     returned untouched (no <mark>, no wrapper) — callers get a plain string.
 *
 * It does NOT participate in the search/query logic; it only decorates already-
 * computed result text.
 */
import React from "react";

/** Escape regex metacharacters so a user's query is matched as a literal substring. */
function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Split `text` on case-insensitive occurrences of `term` and wrap each match in a
 * subtle <mark> (tagged `data-testid="search-highlight"`). Returns the untouched
 * string when there is nothing to highlight.
 */
export function highlightMatch(text: string, term: string): React.ReactNode {
  const needle = term.trim();
  if (needle.length === 0 || text.length === 0) return text;

  // Capturing group so String.split keeps the matched substrings in the output.
  const pattern = new RegExp(`(${escapeRegExp(needle)})`, "gi");
  const parts = text.split(pattern);
  if (parts.length <= 1) return text; // no occurrence — nothing to wrap

  // With a capturing group, split yields [before, match, before, match, ...] so
  // the matched substrings live at the odd indices.
  return parts.map((part, i) => {
    if (part === "") return null;
    if (i % 2 === 1) {
      return (
        <mark
          key={i}
          data-testid="search-highlight"
          className="rounded-[2px] bg-yellow-200 px-0.5 text-gray-900 dark:bg-yellow-500/40 dark:text-gray-50"
        >
          {part}
        </mark>
      );
    }
    return <React.Fragment key={i}>{part}</React.Fragment>;
  });
}
