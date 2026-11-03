/**
 * BACKLOG-3941 — assembles and validates the form registry. Pure; throws on an invalid row set
 * so a bad row fails at load and in tests, never silently at match time.
 *
 * BACKLOG-4106 adds the per-kind checks (each throws /form registry/):
 *   1. a code-kind row (code-line with a codeLine, code-page, mid-line) has no `code`
 *   2. a title-keyed row has no `titleKey`
 *   3. two rows of one publisher share a `titleKey` source
 *   4. an adjacent title-keyed header has no `anchorTemplate` containing "{title}"
 *   5. a mid-line `marker` starts with `^` or ends with `$`
 *   6. a title-line publisher with no `requiredMarkers` and no revision gate has a row whose title
 *      is a single line (such rows need a title of at least 2 lines)
 *   7. a windowed header has `windowAfter <= 0` or `windowBefore < 0`
 *   8. a `codePage` lacks the `m` flag
 *   9. a code-page or mid-line header has no publisher proof (requiredMarkers, documentMarkers
 *      or pairedToken) — `namePattern` is not read for those kinds
 */
import type { FormRow, Header, PublisherHeader, PublisherRow, Registry } from "./formRegistryTypes";
import { DEFAULT_PUBLISHERS } from "./publishers";
import { NWMLS_FORMS } from "./nwmlsForms";
import { OR_FORMS } from "./orForms";
import { CA_FORMS } from "./caForms";

export function codeKey(publisherId: string, code: string): string {
  return `${publisherId}\u0000${code}`;
}

/** v1 header (kind absent or "code-line"). */
export function isCodeLineHeader(h: Header): h is PublisherHeader {
  return h.kind === undefined || h.kind === "code-line";
}

/** True when rows of this publisher are keyed by code. */
function isCodeKeyed(h: Header): boolean {
  if (isCodeLineHeader(h)) return Boolean(h.codeLine);
  return h.kind === "code-page" || h.kind === "mid-line";
}

function checkPublisher(p: PublisherRow): void {
  const h = p.header;
  if (isCodeLineHeader(h)) {
    if (!(h.windowChars > 0)) {
      throw new Error(`form registry: publisher "${p.id}" needs a positive windowChars`);
    }
    if (h.codeLine && !h.codeLine.multiline) {
      throw new Error(`form registry: publisher "${p.id}" codeLine must use the m flag`);
    }
    return;
  }
  // 7
  if (!(h.windowAfter > 0) || !(h.windowBefore >= 0)) {
    throw new Error(`form registry: publisher "${p.id}" needs windowAfter > 0 and windowBefore >= 0`);
  }
  if (h.kind === "code-page") {
    // 8
    if (!h.codePage.multiline) {
      throw new Error(`form registry: publisher "${p.id}" codePage must use the m flag`);
    }
  }
  if (h.kind === "mid-line") {
    // 5
    if (h.marker.source.startsWith("^") || h.marker.source.endsWith("$")) {
      throw new Error(`form registry: publisher "${p.id}" mid-line marker must not be anchored`);
    }
  }
  if (h.kind === "code-page" || h.kind === "mid-line") {
    // 9
    const proof =
      h.requiredMarkers.length > 0 ||
      (h.documentMarkers?.length ?? 0) > 0 ||
      (h.kind === "code-page" && h.pairedToken !== undefined);
    if (!proof) {
      throw new Error(`form registry: publisher "${p.id}" has no publisher proof`);
    }
  }
  if (h.kind === "title-keyed" && h.placement === "adjacent") {
    // 4
    if (!h.anchorTemplate || !h.anchorTemplate.includes("{title}")) {
      throw new Error(`form registry: publisher "${p.id}" anchorTemplate needs {title}`);
    }
  }
}

export function buildRegistry(
  publishers: readonly PublisherRow[],
  forms: readonly FormRow[]
): Registry {
  const pubById = new Map<string, PublisherRow>();
  for (const p of publishers) {
    if (pubById.has(p.id)) throw new Error(`form registry: duplicate publisher id "${p.id}"`);
    checkPublisher(p);
    pubById.set(p.id, p);
  }

  const ids = new Set<string>();
  const byCode = new Map<string, FormRow>();
  const byTitle = new Map<string, FormRow[]>();
  const titleSources = new Set<string>();
  for (const f of forms) {
    if (ids.has(f.id)) throw new Error(`form registry: duplicate form id "${f.id}"`);
    ids.add(f.id);
    const pub = pubById.get(f.publisherId);
    if (!pub) throw new Error(`form registry: form "${f.id}" names unknown publisher`);
    if (f.sampleProvenance.length === 0) {
      throw new Error(`form registry: form "${f.id}" has no sample provenance`);
    }
    const h = pub.header;
    if (isCodeKeyed(h)) {
      // 1
      if (!f.code) throw new Error(`form registry: form "${f.id}" needs a code`);
      const key = codeKey(f.publisherId, f.code);
      if (byCode.has(key)) throw new Error(`form registry: duplicate code "${f.code}"`);
      byCode.set(key, f);
    } else if (!isCodeLineHeader(h) && h.kind === "title-keyed") {
      // 2
      if (!f.titleKey || f.titleKey.length === 0) {
        throw new Error(`form registry: title-keyed form "${f.id}" needs a titleKey`);
      }
      for (const t of f.titleKey) {
        // 3
        const k = `${f.publisherId}\u0000${t.source}`;
        if (titleSources.has(k)) throw new Error(`form registry: duplicate titleKey in "${f.id}"`);
        titleSources.add(k);
        // 6
        if (
          h.placement === "line" &&
          h.requiredMarkers.length === 0 &&
          !h.revisionRequired &&
          !t.source.includes("\\n")
        ) {
          throw new Error(`form registry: form "${f.id}" needs a title of at least 2 lines`);
        }
      }
      const list = byTitle.get(f.publisherId) ?? [];
      list.push(f);
      byTitle.set(f.publisherId, list);
    } else if (f.knownTitles.length === 0) {
      throw new Error(`form registry: title-keyed form "${f.id}" needs a known title`);
    }
  }

  return { publishers, forms, byCode, byTitle };
}

export const DEFAULT_FORMS: readonly FormRow[] = [...NWMLS_FORMS, ...OR_FORMS, ...CA_FORMS];

export const DEFAULT_REGISTRY: Registry = buildRegistry(DEFAULT_PUBLISHERS, DEFAULT_FORMS);
