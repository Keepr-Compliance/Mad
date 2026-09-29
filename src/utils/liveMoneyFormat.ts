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
 * one dot at most, at most two decimals. `keep` is how many of the input's
 * significant characters sit left of the caret; the result says how many of the
 * OUTPUT's characters do. `dropped[i]` is true when input character i was
 * discarded.
 *
 * Leading zeros are NOT stripped here (SR review 3008b20f): deleting the 5 in
 * 500,000 must leave 00,000 so typing 6 gives 600,000. `trimLeadingZeros`
 * removes them when the field loses focus, and `parseMoney` ignores them.
 */
function normalise(
  sig: string,
  keep: number,
): { sig: string; keep: number; dropped: boolean[] } {
  let out = "";
  let outKeep = 0;
  let seenDot = false;
  let decimals = 0;
  const dropped: boolean[] = [];
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
    dropped.push(!take);
    if (take) {
      out += ch;
      if (i < keep) outKeep++;
    }
  }
  return { sig: out, keep: outKeep, dropped };
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

/** The significant characters of `raw`, how many sit left of `rawCaret`, and where each came from. */
function significant(
  raw: string,
  rawCaret: number,
): { sig: string; keep: number; index: number[] } {
  let sig = "";
  let keep = 0;
  const index: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (!isSignificant(raw[i])) continue;
    sig += raw[i];
    index.push(i);
    if (i < rawCaret) keep++;
  }
  return { sig, keep, index };
}

/**
 * Format `raw` (the input's value right after an edit) with the caret at
 * `rawCaret`. Keeps the caret beside the same digit it was beside.
 */
export function formatMoneyLive(raw: string, rawCaret: number): LiveMoneyResult {
  const { sig, keep } = significant(raw, rawCaret);
  const n = normalise(sig, keep);
  return render(n.sig, n.keep);
}

/**
 * Like `formatMoneyLive`, but for an edit to an existing value `previous`.
 * Returns null — reject the edit, keep `previous` — when formatting would throw
 * away a character that was already in the field: a "." typed before existing
 * decimals (1,234.5 -> 1.23), or a digit typed inside full cents
 * (1.2|3 + 5 -> 1.25). Characters the edit itself added may still be dropped,
 * so pasting $1,234.567 into an empty field gives 1,234.56.
 */
export function formatMoneyEdit(
  previous: string,
  raw: string,
  rawCaret: number,
): LiveMoneyResult | null {
  // The inserted span lies between the longest common prefix and suffix of
  // `previous` and `raw`; everything outside it was already in the field.
  let prefix = 0;
  while (
    prefix < previous.length &&
    prefix < raw.length &&
    previous[prefix] === raw[prefix]
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < previous.length - prefix &&
    suffix < raw.length - prefix &&
    previous[previous.length - 1 - suffix] === raw[raw.length - 1 - suffix]
  ) {
    suffix++;
  }
  const insertedEnd = raw.length - suffix;

  const { sig, keep, index } = significant(raw, rawCaret);
  const n = normalise(sig, keep);
  for (let i = 0; i < n.dropped.length; i++) {
    if (!n.dropped[i]) continue;
    const at = index[i];
    if (at < prefix || at >= insertedEnd) return null;
  }
  return render(n.sig, n.keep);
}

/**
 * Remove leading zeros from the whole part, for when the field loses focus:
 * "00,000" -> "0", "007" -> "7", "00.5" -> "0.5". ".5" and "" are unchanged.
 */
export function trimLeadingZeros(text: string): string {
  const { sig } = significant(text, text.length);
  const dot = sig.indexOf(".");
  const whole = dot === -1 ? sig : sig.slice(0, dot);
  let strip = 0;
  while (strip < whole.length - 1 && whole[strip] === "0") strip++;
  if (strip === 0) return text;
  const trimmed = sig.slice(strip);
  return render(trimmed, trimmed.length).text;
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
