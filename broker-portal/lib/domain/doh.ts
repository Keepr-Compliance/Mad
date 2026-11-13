/**
 * DNS-over-HTTPS TXT lookup for brokerage domain claims — BACKLOG-3962.
 *
 * Reads ONLY `_keepr.<domain>` (no apex fallback) from two public resolvers in parallel.
 * A claim verifies when EITHER resolver returns the exact record value; the comparison itself
 * happens in the database (_domain_claim_record_check), against the claim row's own token.
 *
 * The two providers answer in different shapes (measured 2026-11-10, fixtures in
 * __tests__/domain-claims-3962/fixtures):
 *   - Cloudflare (application/dns-json): `data` is QUOTED; a value over 255 bytes arrives as
 *     "chunk1" "chunk2" and is joined here.
 *   - Google (dns.google/resolve): `data` is UNQUOTED and already joined.
 *   - A missing name: Status 0 with NO Answer key (NOERROR/NODATA), or Status 3 (NXDOMAIN).
 *     Both are "no record", not a resolver failure.
 *   - A CNAME at the name: type 5 and type 16 answers together. Only type 16 is read.
 * Any other Status, a non-2xx response, a timeout or unparseable JSON is a resolver failure.
 * When both resolvers fail the check is recorded as resolver_unavailable and never as a miss.
 */

export const DOH_CLOUDFLARE_URL = 'https://cloudflare-dns.com/dns-query';
export const DOH_GOOGLE_URL = 'https://dns.google/resolve';
export const DOH_TIMEOUT_MS = 4000;
export const MAX_TXT_ANSWERS = 20;
export const MAX_TXT_LENGTH = 512;

const TXT_TYPE = 16;

/** The DNS name the admin publishes the record at. */
export function claimRecordName(domain: string): string {
  return `_keepr.${domain}`;
}

export type ProviderOutcome = { ok: true; answers: string[] } | { ok: false };

export interface TxtLookup {
  resolverOk: boolean;
  answers: string[];
}

type FetchLike = (url: string, init: NonNullable<Parameters<typeof fetch>[1]>) => Promise<Response>;

interface DohAnswer {
  type?: unknown;
  data?: unknown;
}

function dohAnswers(json: unknown): { ok: boolean; answers: DohAnswer[] } {
  if (!json || typeof json !== 'object') return { ok: false, answers: [] };
  const body = json as { Status?: unknown; Answer?: unknown };
  if (body.Status !== 0 && body.Status !== 3) return { ok: false, answers: [] };
  if (body.Status === 3 || body.Answer === undefined) return { ok: true, answers: [] };
  if (!Array.isArray(body.Answer)) return { ok: false, answers: [] };
  return { ok: true, answers: body.Answer as DohAnswer[] };
}

function capped(values: string[]): string[] {
  return values.filter((v) => v.length <= MAX_TXT_LENGTH).slice(0, MAX_TXT_ANSWERS);
}

/** Cloudflare: "a" "b" -> ab. Backslash escapes inside a chunk are undone. */
export function joinQuotedTxt(data: string): string | null {
  const chunks = data.match(/"((?:[^"\\]|\\.)*)"/g);
  if (!chunks) return null;
  return chunks
    .map((c) =>
      c
        .slice(1, -1)
        .replace(/\\(\d{3})/g, (_m, d: string) => String.fromCharCode(Number(d)))
        .replace(/\\(.)/g, '$1')
    )
    .join('');
}

export function parseCloudflareTxt(json: unknown): ProviderOutcome {
  const parsed = dohAnswers(json);
  if (!parsed.ok) return { ok: false };
  const values: string[] = [];
  for (const a of parsed.answers) {
    if (a.type !== TXT_TYPE || typeof a.data !== 'string') continue;
    const joined = joinQuotedTxt(a.data);
    if (joined !== null) values.push(joined);
  }
  return { ok: true, answers: capped(values) };
}

export function parseGoogleTxt(json: unknown): ProviderOutcome {
  const parsed = dohAnswers(json);
  if (!parsed.ok) return { ok: false };
  const values: string[] = [];
  for (const a of parsed.answers) {
    if (a.type !== TXT_TYPE || typeof a.data !== 'string') continue;
    values.push(a.data);
  }
  return { ok: true, answers: capped(values) };
}

async function queryProvider(
  fetchImpl: FetchLike,
  baseUrl: string,
  name: string,
  parse: (json: unknown) => ProviderOutcome
): Promise<ProviderOutcome> {
  const url = `${baseUrl}?name=${encodeURIComponent(name)}&type=TXT`;
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: { accept: 'application/dns-json' },
    // R4: never served from a cache; a re-check must see the zone as it is now.
    cache: 'no-store',
    signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
  });
  if (!res.ok) return { ok: false };
  return parse(await res.json());
}

/** Look up `_keepr.<domain>` on both resolvers. Never throws. */
export async function lookupClaimTxt(domain: string, fetchImpl: FetchLike = fetch): Promise<TxtLookup> {
  const name = claimRecordName(domain);
  const settled = await Promise.allSettled([
    queryProvider(fetchImpl, DOH_CLOUDFLARE_URL, name, parseCloudflareTxt),
    queryProvider(fetchImpl, DOH_GOOGLE_URL, name, parseGoogleTxt),
  ]);
  let resolverOk = false;
  const answers = new Set<string>();
  for (const s of settled) {
    if (s.status !== 'fulfilled' || !s.value.ok) continue;
    resolverOk = true;
    for (const a of s.value.answers) answers.add(a);
  }
  return { resolverOk, answers: [...answers].slice(0, MAX_TXT_ANSWERS * 2) };
}
