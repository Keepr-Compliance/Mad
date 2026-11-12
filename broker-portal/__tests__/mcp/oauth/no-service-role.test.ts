/**
 * @jest-environment node
 *
 * BACKLOG-4238 — H21: the OAuth routes and lib/mcp/oauth reach neither the
 * service-role client nor a cookie-session client, through any local import.
 * The import graph is walked from the real files on disk.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const ENTRY_DIRS = ['app/oauth', 'app/api/mcp/resource-metadata', 'lib/mcp/oauth'];

/** Module specifiers that must never be reached. */
const FORBIDDEN_LOCAL = ['lib/supabase/server', 'lib/supabase/service', 'lib/supabase/client'];
const FORBIDDEN_PACKAGES = ['@supabase/ssr'];
const FORBIDDEN_TEXT = ['SUPABASE_SERVICE_ROLE_KEY', 'cookies()', "from 'next/headers'"];

type Reader = (_abs: string) => string | null;

const diskReader: Reader = (abs) => (existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs, 'utf8') : null);

function listTs(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name))
    .map((e) => path.join(e.parentPath ?? (e as unknown as { path: string }).path, e.name));
}

function specifiers(src: string): string[] {
  const out: string[] = [];
  const re = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm;
  for (const m of src.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
  return out;
}

function resolveLocal(spec: string, fromAbs: string, read: Reader): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(ROOT, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromAbs), spec);
  else return null;
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (read(cand) !== null) return cand;
  }
  return base; // unresolved local: still reported by its path
}

export function findForbidden(entries: string[], read: Reader): string[] {
  const seen = new Set<string>();
  const queue = [...entries];
  const hits: string[] = [];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = read(file);
    if (src === null) continue;
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    for (const t of FORBIDDEN_TEXT) if (src.includes(t)) hits.push(`${rel}: text ${t}`);
    for (const spec of specifiers(src)) {
      if (FORBIDDEN_PACKAGES.includes(spec)) hits.push(`${rel}: imports ${spec}`);
      const local = resolveLocal(spec, file, read);
      if (local === null) continue;
      const localRel = path.relative(ROOT, local).split(path.sep).join('/').replace(/\.(ts|tsx)$/, '');
      if (FORBIDDEN_LOCAL.some((f) => localRel === f || localRel === `${f}/index`)) hits.push(`${rel}: imports ${localRel}`);
      queue.push(local);
    }
  }
  return hits;
}

describe('H21: no service role and no cookie client', () => {
  const entries = ENTRY_DIRS.flatMap(listTs);

  it('positive: the walk starts from the real route and library files', () => {
    const rels = entries.map((e) => path.relative(ROOT, e).split(path.sep).join('/'));
    expect(rels).toEqual(
      expect.arrayContaining([
        'app/oauth/metadata/route.ts',
        'app/oauth/register/route.ts',
        'app/api/mcp/resource-metadata/route.ts',
        'lib/mcp/oauth/rpc.ts',
        'lib/mcp/oauth/guard.ts',
      ])
    );
  });

  it('the real import graph reaches none of them', () => {
    expect(findForbidden(entries, diskReader)).toEqual([]);
  });

  it.each([
    ["import { createClient } from '@/lib/supabase/server';", 'lib/supabase/server'],
    ["import { createServiceClient } from '../../supabase/service';", 'lib/supabase/service'],
    ["import { createServerClient } from '@supabase/ssr';", '@supabase/ssr'],
    ['const k = process.env.SUPABASE_SERVICE_ROLE_KEY;', 'SUPABASE_SERVICE_ROLE_KEY'],
  ])('positive control: a planted %p in rpc.ts is found', (line, needle) => {
    const rpc = path.join(ROOT, 'lib/mcp/oauth/rpc.ts');
    const planted: Reader = (abs) => {
      const real = diskReader(abs);
      return abs === rpc && real !== null ? `${line}\n${real}` : real;
    };
    const hits = findForbidden(entries, planted);
    expect(hits.some((h) => h.startsWith('lib/mcp/oauth/rpc.ts') && h.includes(needle))).toBe(true);
  });
});
