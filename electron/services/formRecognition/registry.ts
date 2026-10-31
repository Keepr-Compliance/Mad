/**
 * BACKLOG-3941 — assembles and validates the form registry. Pure; throws on an invalid row set
 * so a bad row fails at load and in tests, never silently at match time.
 */
import type { FormRow, PublisherRow, Registry } from "./formRegistryTypes";
import { DEFAULT_PUBLISHERS } from "./publishers";
import { NWMLS_FORMS } from "./nwmlsForms";

export function codeKey(publisherId: string, code: string): string {
  return `${publisherId}\u0000${code}`;
}

export function buildRegistry(
  publishers: readonly PublisherRow[],
  forms: readonly FormRow[]
): Registry {
  const pubById = new Map<string, PublisherRow>();
  for (const p of publishers) {
    if (pubById.has(p.id)) throw new Error(`form registry: duplicate publisher id "${p.id}"`);
    if (!(p.header.windowChars > 0)) {
      throw new Error(`form registry: publisher "${p.id}" needs a positive windowChars`);
    }
    if (p.header.codeLine && !p.header.codeLine.multiline) {
      throw new Error(`form registry: publisher "${p.id}" codeLine must use the m flag`);
    }
    pubById.set(p.id, p);
  }

  const ids = new Set<string>();
  const byCode = new Map<string, FormRow>();
  for (const f of forms) {
    if (ids.has(f.id)) throw new Error(`form registry: duplicate form id "${f.id}"`);
    ids.add(f.id);
    const pub = pubById.get(f.publisherId);
    if (!pub) throw new Error(`form registry: form "${f.id}" names unknown publisher`);
    if (f.sampleProvenance.length === 0) {
      throw new Error(`form registry: form "${f.id}" has no sample provenance`);
    }
    if (pub.header.codeLine) {
      if (!f.code) throw new Error(`form registry: form "${f.id}" needs a code`);
      const key = codeKey(f.publisherId, f.code);
      if (byCode.has(key)) throw new Error(`form registry: duplicate code "${f.code}"`);
      byCode.set(key, f);
    } else if (f.knownTitles.length === 0) {
      throw new Error(`form registry: title-keyed form "${f.id}" needs a known title`);
    }
  }

  return { publishers, forms, byCode };
}

export const DEFAULT_REGISTRY: Registry = buildRegistry(DEFAULT_PUBLISHERS, NWMLS_FORMS);
