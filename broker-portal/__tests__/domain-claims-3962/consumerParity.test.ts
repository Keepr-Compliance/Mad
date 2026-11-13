/**
 * @jest-environment node
 */
/**
 * BACKLOG-3962 C5 (parity half): the SQL consumer-domain list in the migration contains every
 * entry of the desktop's freeMailDomains (electron/utils/senderFilter/bundledRules.ts). The
 * refusal itself runs on keepr-test (supabase/tests/backlog-3962 T07, T08, mutant
 * M_consumer_no_comcast).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '../../..');

function freeMailDomains(): string[] {
  const src = readFileSync(join(root, 'electron/utils/senderFilter/bundledRules.ts'), 'utf8');
  const m = src.match(/freeMailDomains:\s*\[([\s\S]*?)\]/);
  if (!m) throw new Error('freeMailDomains not found in bundledRules.ts');
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

function sqlConsumerList(): string[] {
  const sql = readFileSync(join(root, 'supabase/migrations/20261112100000_backlog_3962_domain_claims.sql'), 'utf8');
  const fn = sql.slice(sql.indexOf('CREATE FUNCTION public._is_consumer_email_domain'));
  const m = fn.match(/ANY \(ARRAY\[([\s\S]*?)\]::text\[\]\)/);
  if (!m) throw new Error('consumer list not found in the migration');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

describe('consumer domain list parity', () => {
  it('reads a non-trivial list from both files', () => {
    expect(freeMailDomains().length).toBeGreaterThanOrEqual(30);
    expect(sqlConsumerList().length).toBeGreaterThanOrEqual(30);
  });

  it('the SQL list contains every desktop freeMailDomains entry', () => {
    const sql = new Set(sqlConsumerList());
    expect(freeMailDomains().filter((d) => !sql.has(d))).toEqual([]);
  });

  it('includes the ISP domains the plan names', () => {
    expect(sqlConsumerList()).toEqual(expect.arrayContaining(['gmail.com', 'comcast.net']));
  });
});
