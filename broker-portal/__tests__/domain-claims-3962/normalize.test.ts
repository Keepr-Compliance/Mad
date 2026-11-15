/**
 * @jest-environment node
 */
/**
 * BACKLOG-3962 C7: the TypeScript half of the domain normalisation rule.
 * The SQL half (public._normalize_claim_domain) is exercised on keepr-test by
 * supabase/tests/backlog-3962/controls.sql T01 and T09-T10; the SQL shape is also asserted here
 * from the migration text so the two halves cannot drift apart silently.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { displayDomain, isClaimDomainShape, normalizeClaimDomain } from '@/lib/domain/normalize';

describe('normalizeClaimDomain', () => {
  it.each([
    ['brokerage.com', 'brokerage.com'],
    ['  Brokerage.COM  ', 'brokerage.com'],
    ['brokerage.com.', 'brokerage.com'],
    ['Bücher.Example.', 'xn--bcher-kva.example'],
    ['mail.brokerage.com', 'mail.brokerage.com'],
    ['xn--bcher-kva.example', 'xn--bcher-kva.example'],
    ['a-b.co.uk', 'a-b.co.uk'],
  ])('%j -> %j', (input, expected) => {
    expect(normalizeClaimDomain(input)).toBe(expected);
  });

  it.each([
    'https://b.com/x',
    'http://b.com',
    'b.com/x',
    'a@b.com',
    'b.com:443',
    'b .com',
    'b.com?x=1',
    'b.com#x',
    'localhost',
    '10.0.0.1',
    '-a.com',
    'a-.com',
    'a..com',
    '.',
    '',
    '   ',
    'b.com..',
    `${'a'.repeat(64)}.com`,
    `${'a.'.repeat(127)}com`,
    'under_score.com',
  ])('refuses %j', (input) => {
    expect(normalizeClaimDomain(input)).toBeNull();
  });
});

describe('displayDomain (R10)', () => {
  it('an internationalised name shows its Unicode form and differs from the A-label', () => {
    expect(displayDomain('xn--bcher-kva.example')).toEqual({
      ascii: 'xn--bcher-kva.example',
      unicode: 'bücher.example',
      differs: true,
    });
  });
  it('an ASCII name is shown once', () => {
    expect(displayDomain('brokerage.com')).toEqual({ ascii: 'brokerage.com', unicode: 'brokerage.com', differs: false });
  });
});

describe('the TS shape and the SQL CHECK are the same rule', () => {
  const migration = readFileSync(
    join(__dirname, '../../../supabase/migrations/20261112100000_backlog_3962_domain_claims.sql'),
    'utf8'
  );
  const sqlLabels = "'^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'";

  it('the migration uses the label pattern in both the table CHECK and the normaliser', () => {
    const count = migration.split(sqlLabels).length - 1;
    expect(count).toBe(2);
  });

  it.each([
    ['brokerage.com', true],
    ['xn--bcher-kva.example', true],
    ['10.0.0.1', false],
    ['Brokerage.com', false],
    ['single', false],
  ])('isClaimDomainShape(%j) = %s', (d, ok) => {
    expect(isClaimDomainShape(d)).toBe(ok);
  });
});
