/**
 * Live thousands-separator formatting for a dollar amount typed into a text
 * input (BACKLOG-3614): 100 -> 1,000 -> 1,000,000 as the user types, with the
 * caret kept beside the character it was next to.
 *
 * Pure functions only; `LiveMoneyInput` wires them to an <input>. The text this
 * produces is display text — callers still parse it with `parseMoney`, which
 * strips the commas, so the stored value stays a plain number.
 */

/** Characters that carry value. Everything else ($, commas, spaces, letters) is dropped. */
function isSignificant(ch: string): boolean {
  return (ch >= "0" && ch <= "9") || ch === ".";
}

/** Group an all-digit string in threes: "1234567" -> "1,234,567". */
function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Cents are the finest unit an amount is shown in (matches `formatSaleInput`). */
const MAX_DECIMALS = 2;

export interface LiveMoneyResult {
  /** The formatted display text. */
  text: string;
  /** Where the caret belongs in `text`. */
  caret: number;
}

/**
 * Normalise a run of significant characters (digits and dots) to an amount:
 * one dot at most, at most two decimals, no leading zeros on the whole part.
 * `keep` is how many of the input's significant characters sit left of the
 * caret; the result says how many of the OUTPUT's characters do.
 */
function normalise(sig: string, keep: number): { sig: string; keep: number } {
  let out = "";
  let outKeep = 0;
  let seenDot = false;
  let decimals = 0;
  for (let i = 0; i < sig.length; i++) {
    const ch = sig[i];
    let take: boolean;
    if (ch === ".") {
      take = !seenDot;
      seenDot = true;
    } else if (seenDot) {
      take = decimals < MAX_DECIMALS;
      if (take) decimals++;
    } else {
      take = true;
    }
    if (take) {
      out += ch;
      if (i < keep) outKeep++;
    }
  }

  // Leading zeros on the whole part: "007" -> "7", "000" -> "0", ".5" stays.
  const dot = out.indexOf(".");
  const whole = dot === -1 ? out : out.slice(0, dot);
  let strip = 0;
  while (strip < whole.length - 1 && whole[strip] === "0") strip++;
  if (strip > 0) {
    out = out.slice(strip);
    outKeep = Math.max(0, outKeep - strip);
  }
  return { sig: out, keep: outKeep };
}

/** Format a run of significant characters and place the caret after `keep` of them. */
function render(sig: string, keep: number): LiveMoneyResult {
  const dot = sig.indexOf(".");
  const whole = dot === -1 ? sig : sig.slice(0, dot);
  const text = groupThousands(whole) + (dot === -1 ? "" : sig.slice(dot));

  let caret = 0;
  let seen = 0;
  while (caret < text.length && seen < keep) {
    if (isSignificant(text[caret])) seen++;
    caret++;
  }
  return { text, caret };
}

/**
 * Format `raw` (the input's value right after an edit) with the caret at
 * `rawCaret`. Keeps the caret beside the same digit it was beside.
 */
export function formatMoneyLive(raw: string, rawCaret: number): LiveMoneyResult {
  let sig = "";
  let keep = 0;
  for (let i = 0; i < raw.length; i++) {
    if (!isSignificant(raw[i])) continue;
    sig += raw[i];
    if (i < rawCaret) keep++;
  }
  const n = normalise(sig, keep);
  return render(n.sig, n.keep);
}

/**
 * The edit removed only a separator (a comma), leaving the digits unchanged —
 * so re-formatting alone would put the comma straight back and the key would
 * appear to do nothing. Delete the digit on the far side of the comma instead:
 * the one before it for Backspace, the one after it for Delete.
 *
 * Returns null when the edit was not a separator-only deletion.
 */
export function deleteAcrossSeparator(
  previous: string,
  raw: string,
  rawCaret: number,
  key: "Backspace" | "Delete",
): LiveMoneyResult | null {
  const strip = (s: string) => Array.from(s).filter(isSignificant).join("");
  if (raw.length >= previous.length) return null;
  const sig = strip(raw);
  if (sig !== strip(previous)) return null;

  let keep = 0;
  for (let i = 0; i < rawCaret && i < raw.length; i++) {
    if (isSignificant(raw[i])) keep++;
  }
  let next: string;
  let nextKeep: number;
  if (key === "Backspace") {
    if (keep === 0) return null;
    next = sig.slice(0, keep - 1) + sig.slice(keep);
    nextKeep = keep - 1;
  } else {
    if (keep >= sig.length) return null;
    next = sig.slice(0, keep) + sig.slice(keep + 1);
    nextKeep = keep;
  }
  const n = normalise(next, nextKeep);
  return render(n.sig, n.keep);
}
