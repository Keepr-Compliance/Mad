/**
 * @jest-environment node
 *
 * BACKLOG-4238 — request parsing for /oauth/authorize and /oauth/token:
 * duplicates, empty values, resource canonicalisation (H28, library part),
 * scope normalisation (H10, library part) and the identifier shapes.
 */

import {
  canonicalResource,
  isClientId,
  isCodeVerifier,
  isCredential,
  isRequestId,
  normaliseScope,
  parseForm,
} from '@/lib/mcp/oauth/validate';
import { RESOURCE } from './fixtures';

describe('parseForm', () => {
  const DEFINED = ['a', 'b', 'c'];
  it('keeps defined values, drops empty ones, and lists every name', () => {
    const f = parseForm(new URLSearchParams('a=1&b=&x=9&y'), DEFINED);
    expect([...f.values]).toEqual([['a', '1']]);
    expect(f.duplicates).toEqual([]);
    expect(f.names).toEqual(['a', 'b', 'x', 'y']);
  });
  it('reports a defined parameter sent twice and drops its value', () => {
    const f = parseForm(new URLSearchParams('a=1&a=2&b=3&x=1&x=2'), DEFINED);
    expect(f.duplicates).toEqual(['a']);
    expect(f.values.has('a')).toBe(false);
    expect(f.values.get('b')).toBe('3');
  });
  it('a defined parameter sent twice with one empty value is still a duplicate', () => {
    expect(parseForm(new URLSearchParams('c=&c=1'), DEFINED).duplicates).toEqual(['c']);
  });
});

describe('H28 (library): canonicalResource', () => {
  it.each([RESOURCE, 'HTTPS://PORTAL.TEST/api/mcp', 'https://Portal.Test/api/mcp'])('accepts %p', (v) => {
    expect(canonicalResource(v, RESOURCE)).toBe(true);
  });
  it.each([
    `${RESOURCE}/`,
    `${RESOURCE}?`,
    `${RESOURCE}?x=1`,
    `${RESOURCE}#`,
    'https://portal.test:443/api/mcp',
    'https://u@portal.test/api/mcp',
    'https://portal.test/API/mcp',
    'https://portal.test/api/./mcp',
    'https://portal.test/api/x/../mcp',
    'https://portal.test/api/mcp%2F',
    'http://portal.test/api/mcp',
    'https://other.test/api/mcp',
    'https://portal.test.other.test/api/mcp',
    'https://portal.test',
    '//portal.test/api/mcp',
    '',
  ])('refuses %p', (v) => {
    expect(canonicalResource(v, RESOURCE)).toBe(false);
  });
});

describe('H10 (library): normaliseScope', () => {
  it.each([
    [null, 'mcp:read'],
    ['', 'mcp:read'],
    ['mcp:read', 'mcp:read'],
    ['mcp:read offline_access', 'mcp:read'],
    ['openid profile email', 'mcp:read'],
    ['offline_access', 'mcp:read'],
    ['mcp:write', 'mcp:write'],
    ['mcp:read mcp:write', 'mcp:read mcp:write'],
    ['MCP:READ', 'MCP:READ'],
  ])('%p → %p', (raw, out) => {
    expect(normaliseScope(raw)).toBe(out);
  });
});

describe('identifier shapes', () => {
  it.each([
    [`kpr_c_${'A'.repeat(22)}`, true],
    [`kpr_c_${'A'.repeat(21)}`, false],
    [`kpr_c_${'A'.repeat(23)}`, false],
    [`kpr_c_${'A'.repeat(21)}=`, false],
    [`kpr_x_${'A'.repeat(22)}`, false],
  ])('isClientId(%p) = %p', (v, ok) => {
    expect(isClientId(v)).toBe(ok);
  });

  it.each([
    ['ac', `kpr_ac_${'a'.repeat(43)}`, true],
    ['ac', `kpr_ac_${'a'.repeat(42)}`, false],
    ['ac', `kpr_ac_${'a'.repeat(44)}`, false],
    ['ac', `kpr_rt_${'a'.repeat(43)}`, false],
    ['rt', `kpr_rt_${'a'.repeat(43)}`, true],
    ['rt', `kpr_rt_${'a'.repeat(42)}.`, false],
    ['bd', `kpr_bd_${'a'.repeat(43)}`, true],
    ['bd', ` kpr_bd_${'a'.repeat(43)}`, false],
  ] as const)('isCredential(%p, %p) = %p', (kind, v, ok) => {
    expect(isCredential(kind, v)).toBe(ok);
  });

  it.each([
    ['a'.repeat(42), false],
    ['a'.repeat(43), true],
    ['a'.repeat(128), true],
    ['a'.repeat(129), false],
    [`${'a'.repeat(42)}.~-_`, true],
    [`${'a'.repeat(43)}+`, false],
    [`${'a'.repeat(43)}=`, false],
  ])('isCodeVerifier(length %#) = %p', (v, ok) => {
    expect(isCodeVerifier(v)).toBe(ok);
  });

  it.each([
    ['A'.repeat(22), true],
    ['A'.repeat(21), false],
    ['A'.repeat(23), false],
    [`../${'A'.repeat(19)}`, false],
  ])('isRequestId(%p) = %p', (v, ok) => {
    expect(isRequestId(v)).toBe(ok);
  });
});
