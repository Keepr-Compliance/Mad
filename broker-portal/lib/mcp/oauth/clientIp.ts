/**
 * The caller's address for rate limiting (BACKLOG-4238): x-vercel-forwarded-for,
 * else the first entry of x-forwarded-for, else 'unknown'.
 */

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
