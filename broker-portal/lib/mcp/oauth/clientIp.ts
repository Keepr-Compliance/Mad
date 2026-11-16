/**
 * The caller's address for rate limiting (BACKLOG-4238): x-vercel-forwarded-for,
 * else the first entry of x-forwarded-for, else 'unknown'.
 *
 * rateLimitAddress (BACKLOG-4259) is the per-address bucket: an IPv4 address
 * as given, an IPv6 address reduced to its /64 prefix, an IPv4-mapped IPv6
 * address as its IPv4 address. Anything that does not parse is used as given.
 */

import { isIPv4, isIPv6 } from 'node:net';

function firstEntry(value: string | null): string | null {
  if (!value) return null;
  const first = value.split(',')[0]?.trim();
  return first ? first : null;
}

export function clientIp(req: Request): string {
  return (
    firstEntry(req.headers.get('x-vercel-forwarded-for')) ??
    firstEntry(req.headers.get('x-forwarded-for')) ??
    'unknown'
  );
}

/** The eight 16-bit groups of an IPv6 address, or null when it does not parse. */
function ipv6Groups(addr: string): number[] | null {
  if (!isIPv6(addr)) return null;
  let text = addr;
  const lastColon = text.lastIndexOf(':');
  const last = text.slice(lastColon + 1);
  if (isIPv4(last)) {
    const o = last.split('.').map(Number);
    text = `${text.slice(0, lastColon + 1)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (h: string): number[] => (h === '' ? [] : h.split(':').map((g) => parseInt(g, 16)));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

export function rateLimitAddress(ip: string): string {
  const bare = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
  const zoneless = bare.split('%')[0];
  if (isIPv4(zoneless)) return zoneless;
  const g = ipv6Groups(zoneless);
  if (g === null) return ip;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join('.');
  }
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}
