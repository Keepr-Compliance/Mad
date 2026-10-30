/**
 * BACKLOG-3941 — recognise standard real-estate forms in attachment text.
 *
 * Input: one `attachments.text_content` string as produced by the pdfjs extractor loop
 * (attachmentTextExtractionService.ts): page text joined with "\n", no page markers.
 * Pure: no I/O, no DB, no logging. Nothing in the app calls it yet (deliberately unwired).
 *
 * A form is recognised from its printed header, per publisher:
 *   R1  the code line is a WHOLE line (`Form 41 ©Copyright 2024`); prose fails.
 *   R2  the whole code token is looked up exactly ("41" never matches "41C" or "1A-SWF").
 *   R3  the publisher's name lies inside the window.
 *   R4  every other required marker (NWMLS: ALL RIGHTS RESERVED) lies inside the window.
 *   R5  the revision marker (`Rev. M/YY`) lies inside the window.
 *   R6  every hit of every form is collected; a bundle returns all of its forms.
 * The window starts at the code line and is `windowChars` long; a marker counts only when its
 * match lies wholly inside. A known title raises strength; it is never a gate. Revision is
 * reported, never matched on.
 *
 * Known limits: two copies of the same form in one bundle read as one form with more pages
 * (dedupe per code); OCR layouts that merge the code line into another line fail R1 by design.
 */
import type { FormMatch, MatchStrength, PublisherRow, Registry } from "./formRegistryTypes";
import { DEFAULT_REGISTRY, codeKey } from "./registry";

const NORMALISE_RE = /[‘’“”   \t]/g;
const NORMALISE_MAP: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  " ": " ",
  " ": " ",
  " ": " ",
  "\t": " ",
};

/**
 * Char-for-char normalisation: curly quotes to straight, NBSP/figure space/tab to space.
 * It never changes the text's length and never touches newlines, so an offset into the
 * normalised text is the same offset into the original, and line structure (R1) survives.
 */
export function normalizeFormText(text: string): string {
  return text.replace(NORMALISE_RE, (c) => NORMALISE_MAP[c] ?? c);
}

function nonGlobal(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags.replace("g", ""));
}

/** End offset (exclusive) of the first match of `re` in `s`, or -1. */
function markerEnd(s: string, re: RegExp): number {
  const m = re.exec(s);
  return m ? m.index + m[0].length : -1;
}

function matchPublisher(
  original: string,
  norm: string,
  pub: PublisherRow,
  registry: Registry,
  byKey: Map<string, FormMatch>
): void {
  // A publisher without a code line (title-keyed) is not matched yet: no such rows ship.
  if (!pub.header.codeLine) return;
  const codeLine = new RegExp(pub.header.codeLine.source, pub.header.codeLine.flags.replace("g", "") + "g");
  const namePattern = nonGlobal(pub.namePattern);
  const required = pub.header.requiredMarkers.map(nonGlobal);
  const revision = nonGlobal(pub.header.revision);
  const windowChars = pub.header.windowChars;

  for (const m of norm.matchAll(codeLine)) {
    const start = (m.index ?? 0) + (m[0].length - m[0].trimStart().length);
    const code = m[1];
    const window = norm.slice(start, start + windowChars);

    const pubEnd = markerEnd(window, namePattern);
    const otherEnds = required.map((r) => markerEnd(window, r));
    const revMatch = revision.exec(window);
    if (pubEnd < 0) continue; // R3
    if (otherEnds.some((e) => e < 0)) continue; // R4
    if (!revMatch) continue; // R5

    const row = registry.byCode.get(codeKey(pub.id, code)) ?? null;
    const titled = row ? row.knownTitles.some((t) => nonGlobal(t).test(window)) : false;
    const strength: MatchStrength = titled ? "footer+title" : "footer";
    const end = Math.max(pubEnd, revMatch.index + revMatch[0].length, ...otherEnds);

    const key = codeKey(pub.id, code);
    const prior = byKey.get(key);
    if (prior) {
      prior.occurrences += 1;
      if (strength === "footer+title") prior.strength = strength;
      continue;
    }
    byKey.set(key, {
      formId: row ? row.id : null,
      publisherId: pub.id,
      code,
      kind: row ? row.kind : null,
      strength,
      occurrences: 1,
      firstOffset: start,
      evidence: original.slice(start, start + end),
      revisionSeen: revMatch[1].replace(/\s+/g, ""),
    });
  }
}

/** Every recognised form in `text` (a bundle yields several), ordered by first offset. */
export function matchForms(text: string, registry: Registry = DEFAULT_REGISTRY): FormMatch[] {
  if (!text || text.trim().length === 0) return [];
  const norm = normalizeFormText(text);
  const byKey = new Map<string, FormMatch>();
  for (const pub of registry.publishers) {
    matchPublisher(text, norm, pub, registry, byKey);
  }
  return [...byKey.values()].sort((a, b) => a.firstOffset - b.firstOffset);
}

export interface RegionTally {
  state: string;
  publisherId: string;
  /** Distinct registered forms from this publisher. */
  forms: number;
}

/**
 * Tally the publishers of REGISTERED matches into regions. Display / tie-break only — never a
 * gate. Unregistered codes (formId null) do not count.
 */
export function inferRegion(
  matches: readonly FormMatch[],
  registry: Registry = DEFAULT_REGISTRY
): RegionTally[] {
  const formsByPub = new Map<string, Set<string>>();
  for (const m of matches) {
    if (m.formId === null) continue;
    const set = formsByPub.get(m.publisherId) ?? new Set<string>();
    set.add(m.formId);
    formsByPub.set(m.publisherId, set);
  }
  const out: RegionTally[] = [];
  for (const [publisherId, set] of formsByPub) {
    const pub = registry.publishers.find((p) => p.id === publisherId);
    if (!pub) continue;
    out.push({ state: pub.region.state, publisherId, forms: set.size });
  }
  return out.sort((a, b) => b.forms - a.forms);
}
