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
 *
 * BACKLOG-4106 — matchForms dispatches on the publisher's marker kind (`header.kind`):
 *   code-line   the v1 path above (R1–R6), `matchPublisher`, moved verbatim.
 *   code-page   `matchWindowed`: a page line that STARTS with the code (after line-start spaces and
 *               `leadingNoise`), e.g. C.A.R. `RPA REVISED 12/22 (PAGE 1 OF 16)`.
 *   mid-line    `matchWindowed`: a marker anywhere in a line, publisher token inside the match,
 *               e.g. `OREF 001 | Released 01/2026`.
 *   title-keyed `matchTitleKeyed` (BACKLOG-4106 PR 2): a registered printed title at the start of a
 *               line is the anchor (TK-L whole line(s); TK-A title + revision on the same line).
 *               Longest title span wins where spans overlap (TK-W), per place, not per text.
 * Windowed kinds: the window is [anchorStart - windowBefore, anchorStart + windowAfter]; every
 * required marker and the paired token must lie wholly inside it; document markers must occur
 * anywhere in the text. Declared revision: anchor group 2 if it matched, else `header.revision`
 * (group 1) in the window or the document; it gates only when `revisionRequired` is true, and it
 * is never part of a key. The page total is matched and discarded. Markers before the anchor gate
 * but are not part of `evidence`, which starts at firstOffset and is capped at EVIDENCE_CAP.
 */
import type {
  CodePageHeader,
  FormRow,
  FormMatch,
  MatchStrength,
  MidLineHeader,
  PublisherHeader,
  PublisherRow,
  Registry,
  TitleKeyedHeader,
} from "./formRegistryTypes";
import { DEFAULT_REGISTRY, codeKey, isCodeLineHeader } from "./registry";

/** A v1 publisher: its header is the code-line model. */
type CodeLinePublisher = PublisherRow & { header: PublisherHeader };

/** Windowed kinds: evidence is at most this many chars, starting at firstOffset (R7). */
export const EVIDENCE_CAP = 400;

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
  // String.match, not RegExp exec: the SQL boundary gate enumerates exec calls and cannot trace a parameter receiver. re is non-global, so the result is identical.
  const m = s.match(re);
  return m ? (m.index ?? 0) + m[0].length : -1;
}

function matchPublisher(
  original: string,
  norm: string,
  pub: CodeLinePublisher,
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
    // String.match, not RegExp exec: the SQL boundary gate cannot trace a destructured receiver. revision is non-global (nonGlobal), so the result is identical.
    const revMatch = window.match(revision);
    if (pubEnd < 0) continue; // R3
    if (otherEnds.some((e) => e < 0)) continue; // R4
    if (!revMatch) continue; // R5

    const row = registry.byCode.get(codeKey(pub.id, code)) ?? null;
    const titled = row ? row.knownTitles.some((t) => nonGlobal(t).test(window)) : false;
    const strength: MatchStrength = titled ? "footer+title" : "footer";
    const end = Math.max(pubEnd, (revMatch.index ?? 0) + revMatch[0].length, ...otherEnds);

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

/** Absolute end offset of the first match of `re` in `window` (which starts at `base`), or -1. */
function windowMarkerEnd(window: string, base: number, re: RegExp): number {
  const e = markerEnd(window, re);
  return e < 0 ? -1 : base + e;
}

/** code-page and mid-line publishers (BACKLOG-4106). */
function matchWindowed(
  original: string,
  norm: string,
  pub: PublisherRow,
  h: CodePageHeader | MidLineHeader,
  registry: Registry,
  byKey: Map<string, FormMatch>
): void {
  // Document markers: tested once per text.
  if (h.documentMarkers && !h.documentMarkers.every((r) => nonGlobal(r).test(norm))) return;
  const source = h.kind === "code-page" ? h.codePage : h.marker;
  const anchor = new RegExp(source.source, source.flags.replace("g", "") + "g");
  const lead = h.kind === "code-page" ? nonGlobal(h.leadingNoise ?? /^[ \t]*/) : null;
  const required = h.requiredMarkers.map(nonGlobal);
  const revision = h.revision ? nonGlobal(h.revision) : null;
  // String.match, not RegExp exec (SQL boundary gate); revision is non-global.
  const docRevision = revision && h.revisionScope === "document" ? norm.match(revision) : null;

  for (const m of norm.matchAll(anchor)) {
    const code = m[1];
    if (!code) continue;
    if (h.kind === "code-page" && h.codeUpperCase && code !== code.toUpperCase()) continue;
    const at = m.index ?? 0;
    const leadLen = lead ? (m[0].match(lead)?.[0].length ?? 0) : 0;
    const start = at + leadLen;
    const wStart = Math.max(0, start - h.windowBefore);
    const window = norm.slice(wStart, start + h.windowAfter);

    const ends = [at + m[0].length];
    const requiredEnds = required.map((r) => windowMarkerEnd(window, wStart, r));
    if (requiredEnds.some((e) => e < 0)) continue;
    ends.push(...requiredEnds);
    if (h.kind === "code-page" && h.pairedToken) {
      const e = windowMarkerEnd(window, wStart, h.pairedToken(code));
      if (e < 0) continue;
      ends.push(e);
    }

    let rev: string | null = m[2] ?? null;
    if (rev === null && revision) {
      if (h.revisionScope === "document") {
        rev = docRevision ? docRevision[1] : null;
      } else {
        // String.match, not RegExp exec (SQL boundary gate); revision is non-global.
        const rm = window.match(revision);
        if (rm) {
          rev = rm[1];
          ends.push(wStart + (rm.index ?? 0) + rm[0].length);
        }
      }
    }
    if (h.revisionRequired && rev === null) continue;

    const key = codeKey(pub.id, code);
    const row = registry.byCode.get(key) ?? null;
    if (!row && !h.reportUnregistered) continue;
    const titled = row ? row.knownTitles.some((t) => nonGlobal(t).test(window)) : false;
    const strength: MatchStrength = titled ? "footer+title" : "footer";

    const prior = byKey.get(key);
    if (prior) {
      prior.occurrences += 1;
      if (strength === "footer+title") prior.strength = strength;
      continue;
    }
    const end = Math.min(start + EVIDENCE_CAP, Math.max(...ends));
    byKey.set(key, {
      formId: row ? row.id : null,
      publisherId: pub.id,
      code,
      kind: row ? row.kind : null,
      strength,
      occurrences: 1,
      firstOffset: start,
      evidence: original.slice(start, end),
      revisionSeen: rev,
    });
  }
}

/** Title anchors start a line (after line-start spaces): a title inside body prose never anchors. */
const LINE_START = "(?<=^|\\n)[ \\t]*";

/** Dedupe key of a title-keyed row; never collides with codeKey (a title row may carry a code). */
function titleRowKey(pub: PublisherRow, row: FormRow): string {
  return `${pub.id}\u0000#${row.id}`;
}

interface TitleHit {
  row: FormRow;
  /** Start of the title (after line-start spaces). */
  start: number;
  /** End of the anchor match. */
  end: number;
  /** Revision from the anchor (adjacent), else null. */
  rev: string | null;
}

/** The compiled anchor of one title source (TK-L / TK-A), global, always at line start. */
function titleAnchor(h: TitleKeyedHeader, title: RegExp): RegExp {
  if (h.placement === "line") {
    return new RegExp(`${LINE_START}(?:${title.source})[ \\t]*(?=\\n|$)`, "g");
  }
  const body = (h.anchorTemplate ?? "").split("{title}").join(`(?:${title.source})`);
  return new RegExp(`${LINE_START}(?:${body})`, "g");
}

/** title-keyed publishers (BACKLOG-4106 PR 2). */
function matchTitleKeyed(
  original: string,
  norm: string,
  pub: PublisherRow,
  h: TitleKeyedHeader,
  registry: Registry,
  byKey: Map<string, FormMatch>
): void {
  const rows = registry.byTitle.get(pub.id);
  if (!rows || rows.length === 0) return;
  if (h.documentMarkers && !h.documentMarkers.every((r) => nonGlobal(r).test(norm))) return;
  const required = h.requiredMarkers.map(nonGlobal);
  const revision = h.revision ? nonGlobal(h.revision) : null;
  // String.match, not RegExp exec (SQL boundary gate); revision is non-global.
  const docRevision = revision && h.revisionScope === "document" ? norm.match(revision) : null;

  const hits: TitleHit[] = [];
  for (const row of rows) {
    for (const t of row.titleKey ?? []) {
      for (const m of norm.matchAll(titleAnchor(h, t))) {
        const at = m.index ?? 0;
        const start = at + (m[0].length - m[0].trimStart().length);
        hits.push({ row, start, end: at + m[0].length, rev: m.groups?.rev ?? null });
      }
    }
  }
  // TK-W: where two title spans overlap, the longer one wins at that place only.
  const kept = hits.filter(
    (a) => !hits.some((b) => b !== a && b.start < a.end && a.start < b.end && b.end - b.start > a.end - a.start)
  );
  kept.sort((a, b) => a.start - b.start);

  for (const hit of kept) {
    const { row, start } = hit;
    const wStart = Math.max(0, start - h.windowBefore);
    const window = norm.slice(wStart, start + h.windowAfter);
    const ends = [hit.end];
    const requiredEnds = required.map((r) => windowMarkerEnd(window, wStart, r));
    if (requiredEnds.some((e) => e < 0)) continue;
    ends.push(...requiredEnds);

    let rev = hit.rev;
    if (rev === null && revision) {
      if (h.revisionScope === "document") {
        rev = docRevision ? (docRevision[1] ?? null) : null;
      } else {
        // String.match, not RegExp exec (SQL boundary gate); revision is non-global.
        const rm = window.match(revision);
        if (rm && rm[1] !== undefined) {
          rev = rm[1];
          ends.push(wStart + (rm.index ?? 0) + rm[0].length);
        }
      }
    }
    if (h.revisionRequired && rev === null) continue;

    const key = titleRowKey(pub, row);
    const prior = byKey.get(key);
    if (prior) {
      prior.occurrences += 1;
      continue;
    }
    const end = Math.min(start + EVIDENCE_CAP, Math.max(...ends));
    byKey.set(key, {
      formId: row.id,
      publisherId: pub.id,
      code: row.code ?? null,
      kind: row.kind,
      strength: "footer+title",
      occurrences: 1,
      firstOffset: start,
      evidence: original.slice(start, end),
      revisionSeen: rev,
    });
  }
}

/** Every recognised form in `text` (a bundle yields several), ordered by first offset. */
export function matchForms(text: string, registry: Registry = DEFAULT_REGISTRY): FormMatch[] {
  if (!text || text.trim().length === 0) return [];
  const norm = normalizeFormText(text);
  const byKey = new Map<string, FormMatch>();
  for (const pub of registry.publishers) {
    const h = pub.header;
    if (isCodeLineHeader(h)) {
      matchPublisher(text, norm, pub as CodeLinePublisher, registry, byKey);
    } else if (h.kind === "code-page" || h.kind === "mid-line") {
      matchWindowed(text, norm, pub, h, registry, byKey);
    } else if (h.kind === "title-keyed") {
      matchTitleKeyed(text, norm, pub, h, registry, byKey);
    }
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
