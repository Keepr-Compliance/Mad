/**
 * Whole-word term matching for detectSignals — BACKLOG-4257.
 *
 * A term matches only when the characters on either side of it are not
 * letters or digits, so "offer" does not fire inside "offering" and "closing"
 * not inside "enclosing". A space in a term matches any run of whitespace or
 * hyphens ("counter offer" matches "counter-offer"). A term edge that is not
 * a letter or digit (e.g. "©") carries no boundary on that side.
 *
 * Terms are bundled data (signalTerms.ts), never rule-set or user input.
 */

const cache = new Map<string, RegExp>();

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termRegex(term: string): RegExp {
  let re = cache.get(term);
  if (!re) {
    const body = term
      .trim()
      .split(/\s+/)
      .map(escapeRegExp)
      .join("[\\s-]+");
    const lead = /^[a-z0-9]/i.test(term) ? "(?<![a-z0-9])" : "";
    const tail = /[a-z0-9]$/i.test(term) ? "(?![a-z0-9])" : "";
    re = new RegExp(`${lead}${body}${tail}`, "i");
    cache.set(term, re);
  }
  return re;
}

/** `term` occurs in `text` as a whole word. */
export function hasWholeWord(text: string, term: string): boolean {
  return termRegex(term).test(text);
}

/** Some term of `terms` occurs in `text` as a whole word. */
export function hasAnyWholeWord(text: string, terms: readonly string[]): boolean {
  for (const t of terms) if (hasWholeWord(text, t)) return true;
  return false;
}
