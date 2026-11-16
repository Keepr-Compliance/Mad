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
const FORBIDDEN_TEXT = ['SUPABASE_SERVICE_ROLE_KEY', 'cookies()', "from 'next/headers'", 'getClaims'];

interface Rule {
  local: readonly string[];
  packages: readonly string[];
  text: readonly string[];
}
const H21_RULE: Rule = { local: FORBIDDEN_LOCAL, packages: FORBIDDEN_PACKAGES, text: FORBIDDEN_TEXT };

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

export function findForbidden(entries: string[], read: Reader, rule: Rule = H21_RULE): string[] {
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
    for (const t of rule.text) if (src.includes(t)) hits.push(`${rel}: text ${t}`);
    for (const spec of specifiers(src)) {
      if (rule.packages.includes(spec)) hits.push(`${rel}: imports ${spec}`);
      const local = resolveLocal(spec, file, read);
      if (local === null) continue;
      const localRel = path.relative(ROOT, local).split(path.sep).join('/').replace(/\.(ts|tsx)$/, '');
      if (rule.local.some((f) => localRel === f || localRel === `${f}/index`)) hits.push(`${rel}: imports ${localRel}`);
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
        'app/oauth/authorize/route.ts',
        'app/oauth/token/route.ts',
        'lib/mcp/oauth/redirect.ts',
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

const relOf = (abs: string) => path.relative(ROOT, abs).split(path.sep).join('/');
const plantedIn =
  (relFile: string, line: string): Reader =>
  (abs) => {
    const real = diskReader(abs);
    return relOf(abs) === relFile && real !== null ? `${line}\n${real}` : real;
  };

/**
 * BACKLOG-4238 Rule V: the vendor path (/api/mcp, /oauth and every lib/mcp
 * module outside lib/mcp/account) reaches no service-role client, no
 * cookie-session client and no support-session module. lib/mcp/account is left
 * out of the entries only; an import of it from an entry is still walked.
 */
const RULE_V: Rule = {
  local: [
    'lib/supabase/server',
    'lib/supabase/service',
    'lib/supabase/client',
    'lib/impersonation',
    'lib/impersonation-guards',
    'lib/scoped-client',
  ],
  packages: ['@supabase/ssr', 'next/headers'],
  text: ['SUPABASE_SERVICE_ROLE_KEY', 'cookies()', "from 'next/headers'", 'getClaims'],
};
const RULE_V_DIRS = ['app/api/mcp', 'app/oauth', 'lib/mcp'];
const ruleVEntries = () => RULE_V_DIRS.flatMap(listTs).filter((abs) => !relOf(abs).startsWith('lib/mcp/account/'));

/**
 * BACKLOG-4238 Rule S: the signed-in AI apps pages and lib/mcp/account use the
 * person's own cookie-session client and nothing above it.
 */
const RULE_S: Rule = {
  local: ['lib/supabase/service', 'lib/impersonation', 'lib/impersonation-guards', 'lib/scoped-client'],
  packages: [],
  text: ['SUPABASE_SERVICE_ROLE_KEY', 'createServiceClient'],
};
const RULE_S_DIRS = ['app/dashboard/account/ai-apps', 'lib/mcp/account'];
const ruleSEntries = () => RULE_S_DIRS.flatMap(listTs);

describe('BACKLOG-4238 Rule V: vendor path', () => {
  it('positive: the entries include the MCP route, server, tool and the OAuth modules, and no account module', () => {
    const rels = ruleVEntries().map(relOf);
    expect(rels).toEqual(
      expect.arrayContaining([
        'app/api/mcp/route.ts',
        'lib/mcp/server.ts',
        'lib/mcp/tools/status.ts',
        'lib/mcp/tools/deals.ts',
        'lib/mcp/tools/checklists.ts',
        'app/oauth/authorize/route.ts',
        'lib/mcp/oauth/rpc.ts',
        'lib/mcp/oauth/binding.ts',
      ])
    );
    expect(rels.filter((r) => r.startsWith('lib/mcp/account/'))).toEqual([]);
  });

  it('the real import graph reaches none of the forbidden modules', () => {
    expect(findForbidden(ruleVEntries(), diskReader, RULE_V)).toEqual([]);
  });

  it.each([
    ['lib/mcp/server.ts', "import { createServiceClient } from '@/lib/supabase/service';", 'lib/supabase/service'],
    ['app/api/mcp/route.ts', "import { createServiceClient } from '@/lib/supabase/service';", 'lib/supabase/service'],
    ['lib/mcp/oauth/rpc.ts', "import { createServiceClient } from '@/lib/supabase/service';", 'lib/supabase/service'],
    ['lib/mcp/server.ts', "import { getImpersonationSession } from '@/lib/impersonation';", 'lib/impersonation'],
    ['lib/mcp/server.ts', "import { cookies } from 'next/headers';", "from 'next/headers'"],
    ['lib/mcp/server.ts', 'import { headers } from "next/headers";', 'imports next/headers'],
    ['lib/mcp/server.ts', "const nh = require('next/headers');", 'imports next/headers'],
  ])('positive control: a line planted in %s is found (%s)', (file, line, needle) => {
    const hits = findForbidden(ruleVEntries(), plantedIn(file, line), RULE_V);
    expect(hits.some((h) => h.startsWith(`${file}:`) && h.includes(needle))).toBe(true);
  });

  // BACKLOG-4238 PR-3b: each forbidden form planted in each MCP endpoint file is found.
  // BACKLOG-4244: and in each data tool module.
  const ENDPOINT_FILES = [
    'app/api/mcp/route.ts',
    'lib/mcp/server.ts',
    'lib/mcp/tools/status.ts',
    'lib/mcp/tools/deals.ts',
    'lib/mcp/tools/checklists.ts',
    'lib/mcp/tools/result.ts',
    'lib/mcp/tools/shapes.ts',
    'lib/mcp/tools/text.ts',
  ];
  const PLANTS: Array<[string, string]> = [
    ["import { createServiceClient } from '@/lib/supabase/service';", 'imports lib/supabase/service'],
    ["import { createClient } from '@/lib/supabase/server';", 'imports lib/supabase/server'],
    ["import { createServerClient } from '@supabase/ssr';", 'imports @supabase/ssr'],
    ["import { headers } from 'next/headers';", 'imports next/headers'],
    ['import { headers } from "next/headers";', 'imports next/headers'],
    ["const nh = require('next/headers');", 'imports next/headers'],
    ['const c = await client.auth.getClaims(token);', 'text getClaims'],
  ];
  it.each(ENDPOINT_FILES.flatMap((f) => PLANTS.map(([line, needle]) => [f, line, needle] as const)))(
    'positive control: in %s, %s is found',
    (file, line, needle) => {
      const hits = findForbidden(ruleVEntries(), plantedIn(file, line), RULE_V);
      expect(hits).toContain(`${file}: ${needle}`);
    }
  );

  it('positive control: getClaims planted in an H21 entry is found by H21', () => {
    const hits = findForbidden(ENTRY_DIRS.flatMap(listTs), plantedIn('lib/mcp/oauth/rpc.ts', 'auth.getClaims(t);'));
    expect(hits).toContain('lib/mcp/oauth/rpc.ts: text getClaims');
  });

  it('positive control: an account module imported from lib/mcp/sentryScrub.ts (no route imports it) is walked', () => {
    const hits = findForbidden(ruleVEntries(), plantedIn('lib/mcp/sentryScrub.ts', "import '@/lib/mcp/account/rpc';"), RULE_V);
    expect(hits).toContain('lib/mcp/account/rpc.ts: imports lib/supabase/server');
  });

  it('positive control: an account module imported from lib/mcp/server.ts is walked', () => {
    const hits = findForbidden(ruleVEntries(), plantedIn('lib/mcp/server.ts', "import '@/lib/mcp/account/rpc';"), RULE_V);
    expect(hits).toContain('lib/mcp/account/rpc.ts: imports lib/supabase/server');
  });
});

describe('BACKLOG-4238 Rule S: signed-in AI apps pages', () => {
  it('positive: the entries include both pages, both client components and the account modules', () => {
    expect(ruleSEntries().map(relOf)).toEqual(
      expect.arrayContaining([
        'app/dashboard/account/ai-apps/page.tsx',
        'app/dashboard/account/ai-apps/AiAppsList.tsx',
        'app/dashboard/account/ai-apps/connect/[requestId]/page.tsx',
        'app/dashboard/account/ai-apps/connect/[requestId]/ConsentForm.tsx',
        'lib/mcp/account/rpc.ts',
        'lib/mcp/account/actions.ts',
        'lib/mcp/account/request.ts',
      ])
    );
  });

  it('the real import graph reaches none of the forbidden modules', () => {
    expect(findForbidden(ruleSEntries(), diskReader, RULE_S)).toEqual([]);
  });

  it.each([
    ['lib/mcp/account/rpc.ts', "import { createServiceClient } from '@/lib/supabase/service';", 'lib/supabase/service'],
    ['lib/mcp/account/actions.ts', 'const k = process.env.SUPABASE_SERVICE_ROLE_KEY;', 'SUPABASE_SERVICE_ROLE_KEY'],
    ['app/dashboard/account/ai-apps/page.tsx', "import { getImpersonationSession } from '@/lib/impersonation';", 'lib/impersonation'],
  ])('positive control: a line planted in %s is found (%s)', (file, line, needle) => {
    const hits = findForbidden(ruleSEntries(), plantedIn(file, line), RULE_S);
    expect(hits.some((h) => h.startsWith(`${file}:`) && h.includes(needle))).toBe(true);
  });

  it('positive control: a module outside the entries, reached through lib/mcp/account/request.ts, is walked', () => {
    const hits = findForbidden(ruleSEntries(), plantedIn('lib/mcp/oauth/binding.ts', "import '@/lib/impersonation';"), RULE_S);
    expect(hits).toContain('lib/mcp/oauth/binding.ts: imports lib/impersonation');
  });
});
