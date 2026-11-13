/**
 * @jest-environment node
 */
/**
 * BACKLOG-3962 C1, R3, R4: the DNS-over-HTTPS lookup.
 *
 * Fixtures are TRANSCRIBED, not invented: ./fixtures/*.json are the raw bodies returned on
 * 2026-11-10 by
 *   curl -H 'accept: application/dns-json' 'https://cloudflare-dns.com/dns-query?name=<n>&type=TXT'  (cf_*)
 *   curl 'https://dns.google/resolve?name=<n>&type=TXT'                                             (g_*)
 * for <n> = google._domainkey.github.com (a TXT value over 255 bytes, split in two chunks),
 * _keepr.example.com (a name with no record: Status 0, no Answer key), s1._domainkey.stripe.com
 * (a CNAME at the name) and nonexistent-zzq.invalid (Status 3).
 * Where a Keepr value is needed, the fixture's own answer `data` is replaced with one in the
 * same provider's format; the rest of the body is the real response.
 *
 * Every fetch is a mock. No test here reaches the network.
 */

import cfSplit from './fixtures/cf_google._domainkey.github.com.json';
import gSplit from './fixtures/g_google._domainkey.github.com.json';
import cfNoData from './fixtures/cf__keepr.example.com.json';
import gNoData from './fixtures/g__keepr.example.com.json';
import cfCname from './fixtures/cf_s1._domainkey.stripe.com.json';
import gCname from './fixtures/g_s1._domainkey.stripe.com.json';
import cfNx from './fixtures/cf_nx.json';
import gNx from './fixtures/g_nx.json';
import {
  DOH_CLOUDFLARE_URL,
  DOH_GOOGLE_URL,
  joinQuotedTxt,
  lookupClaimTxt,
  parseCloudflareTxt,
  parseGoogleTxt,
} from '@/lib/domain/doh';

const TOKEN = 'keepr-domain-verification=' + '0123456789abcdef'.repeat(3);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The github DKIM record as each provider returned it, joined by hand. */
const DKIM_JOINED = (gSplit as { Answer: { data: string }[] }).Answer[0].data;

function withData<T extends { Answer?: { data: string; type: number }[] }>(body: T, data: string): T {
  const b = clone(body);
  b.Answer![b.Answer!.length - 1].data = data;
  return b;
}

function respond(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

type Route = { cf: unknown | Error; g: unknown | Error };

function fetchFor(route: Route) {
  return jest.fn(async (url: string) => {
    const v = url.startsWith(DOH_CLOUDFLARE_URL) ? route.cf : route.g;
    if (v instanceof Error) throw v;
    return respond(v);
  });
}

describe('provider parsers (R3)', () => {
  it('Cloudflare: quoted chunks are joined into the full value', () => {
    expect(parseCloudflareTxt(cfSplit)).toEqual({ ok: true, answers: [DKIM_JOINED] });
  });
  it('Google: the value is already unquoted and joined', () => {
    expect(parseGoogleTxt(gSplit)).toEqual({ ok: true, answers: [DKIM_JOINED] });
  });
  it('NOERROR with no Answer key is "no record", not a resolver error', () => {
    expect(parseCloudflareTxt(cfNoData)).toEqual({ ok: true, answers: [] });
    expect(parseGoogleTxt(gNoData)).toEqual({ ok: true, answers: [] });
  });
  it('NXDOMAIN (Status 3) is "no record"', () => {
    expect(parseCloudflareTxt(cfNx)).toEqual({ ok: true, answers: [] });
    expect(parseGoogleTxt(gNx)).toEqual({ ok: true, answers: [] });
  });
  it('a CNAME answer (type 5) is ignored; only the TXT answer is read', () => {
    expect(parseCloudflareTxt(cfCname).ok && (parseCloudflareTxt(cfCname) as { answers: string[] }).answers).toEqual([
      (gCname as { Answer: { data: string }[] }).Answer[1].data,
    ]);
    expect(parseGoogleTxt(gCname)).toEqual({ ok: true, answers: [(gCname as { Answer: { data: string }[] }).Answer[1].data] });
  });
  it.each([[2], [5], ['0'], [undefined]])('Status %j is a resolver error', (status) => {
    const b = { ...clone(cfNoData), Status: status };
    expect(parseCloudflareTxt(b)).toEqual({ ok: false });
    expect(parseGoogleTxt(b)).toEqual({ ok: false });
  });
  it('joinQuotedTxt undoes escapes and joins chunks', () => {
    expect(joinQuotedTxt('"ab" "cd"')).toBe('abcd');
    expect(joinQuotedTxt('"a\\"b" "\\\\c"')).toBe('a"b\\c');
    expect(joinQuotedTxt('"a\\059b"')).toBe('a;b');
    expect(joinQuotedTxt('unquoted')).toBeNull();
  });
  it('answers over 512 characters are dropped and at most 20 are kept', () => {
    const many = clone(gNoData) as { Answer?: { name: string; type: number; data: string }[] };
    many.Answer = Array.from({ length: 25 }, (_, i) => ({ name: 'x', type: 16, data: `v${i}` }));
    many.Answer.push({ name: 'x', type: 16, data: 'z'.repeat(513) });
    const out = parseGoogleTxt(many) as { ok: true; answers: string[] };
    expect(out.answers).toHaveLength(20);
    expect(out.answers.every((a) => a.length <= 512)).toBe(true);
  });
});

describe('lookupClaimTxt', () => {
  it('C1: queries exactly _keepr.<domain> on both providers, uncached, with a timeout (R4)', async () => {
    const f = fetchFor({ cf: cfNoData, g: gNoData });
    await lookupClaimTxt('example.com', f);
    expect(f).toHaveBeenCalledTimes(2);
    const urls = f.mock.calls.map((c) => c[0]).sort();
    expect(urls).toEqual(
      [
        `${DOH_CLOUDFLARE_URL}?name=_keepr.example.com&type=TXT`,
        `${DOH_GOOGLE_URL}?name=_keepr.example.com&type=TXT`,
      ].sort()
    );
    for (const call of f.mock.calls) {
      const init = (call as unknown as [string, RequestInit])[1];
      expect(init.cache).toBe('no-store');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.method).toBe('GET');
    }
  });

  it('C1: a correct token published only at the apex is not seen', async () => {
    // A resolver that only answers for the apex name.
    const f = jest.fn(async (url: string) => {
      const name = new URL(url).searchParams.get('name');
      const isCf = url.startsWith(DOH_CLOUDFLARE_URL);
      if (name === 'example.com') return respond(withData(isCf ? cfSplit : gSplit, isCf ? `"${TOKEN}"` : TOKEN));
      return respond(isCf ? cfNoData : gNoData);
    });
    const out = await lookupClaimTxt('example.com', f);
    expect(out).toEqual({ resolverOk: true, answers: [] });
  });

  it('Cloudflare alone returning the value is enough', async () => {
    const f = fetchFor({ cf: withData(cfSplit, `"${TOKEN.slice(0, 30)}" "${TOKEN.slice(30)}"`), g: gNoData });
    expect(await lookupClaimTxt('example.com', f)).toEqual({ resolverOk: true, answers: [TOKEN] });
  });

  it('Google alone returning the value is enough', async () => {
    const f = fetchFor({ cf: new Error('down'), g: withData(gSplit, TOKEN) });
    expect(await lookupClaimTxt('example.com', f)).toEqual({ resolverOk: true, answers: [TOKEN] });
  });

  it('NODATA from both is "no record" with the resolver up', async () => {
    const f = fetchFor({ cf: cfNoData, g: gNoData });
    expect(await lookupClaimTxt('example.com', f)).toEqual({ resolverOk: true, answers: [] });
  });

  it('both providers failing is resolver_unavailable', async () => {
    const f = fetchFor({ cf: new Error('timeout'), g: { Status: 2 } });
    expect(await lookupClaimTxt('example.com', f)).toEqual({ resolverOk: false, answers: [] });
  });

  it('a non-2xx response is a provider failure', async () => {
    const f = jest.fn(async () => respond({}, false));
    expect(await lookupClaimTxt('example.com', f)).toEqual({ resolverOk: false, answers: [] });
  });

  it('the same value from both providers is listed once', async () => {
    const f = fetchFor({ cf: withData(cfSplit, `"${TOKEN}"`), g: withData(gSplit, TOKEN) });
    expect(await lookupClaimTxt('example.com', f)).toEqual({ resolverOk: true, answers: [TOKEN] });
  });

  it('the domain is URL-encoded into the query', async () => {
    const f = fetchFor({ cf: cfNoData, g: gNoData });
    await lookupClaimTxt('a&b.example', f);
    expect(f.mock.calls[0][0]).toContain('name=_keepr.a%26b.example&type=TXT');
  });
});
