/**
 * @jest-environment node
 *
 * BACKLOG-4238 — H16a (library part): logOutcome redacts the whole line,
 * filterKeys keeps allowlisted names only, errorNameTag and dbCode reduce
 * values to fixed shapes.
 */

import { dbCode, errorNameTag, filterKeys, logOutcome, REGISTER_LOG_KEYS } from '@/lib/mcp/oauth/log';
import { redactKpr } from '@/lib/mcp/oauth/redact';
import { captureConsole, PLANTED_KPR, PLANTED_PLAIN } from './fixtures';

let cap: ReturnType<typeof captureConsole>;
beforeEach(() => {
  cap = captureConsole();
});
afterEach(() => cap.restore());

describe('redactKpr', () => {
  it.each(['at', 'rt', 'ac', 'bd'])('redacts kpr_%s_ + 43 characters', (kind) => {
    const v = `kpr_${kind}_${'a-_Z9'.repeat(8)}abc`;
    expect(v.length).toBe(4 + kind.length + 1 + 43);
    expect(redactKpr(`x ${v} y ${v}`)).toBe('x [redacted] y [redacted]');
  });
  it.each([`kpr_xx_${'A'.repeat(43)}`, `kpr_rt_${'A'.repeat(42)}`, 'kpr_c_AAAAAAAAAAAAAAAAAAAAAA', 'plain text'])(
    'leaves %p alone',
    (v) => {
      expect(redactKpr(v)).toBe(v);
    }
  );
});

describe('logOutcome', () => {
  it('redacts a credential anywhere in the serialised line', () => {
    logOutcome({ route: 'register', outcome: PLANTED_KPR, status: 400, ms: 1, keys: [PLANTED_KPR], error: PLANTED_KPR });
    const lines = cap.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(PLANTED_KPR);
    expect(lines[0]).toContain('[redacted]');
    expect(lines[0].startsWith('[mcp-oauth] ')).toBe(true);
  });

  it('writes 5xx to console.error and the rest to console.warn', () => {
    const err = jest.spyOn(console, 'error');
    const warn = jest.spyOn(console, 'warn');
    logOutcome({ route: 'register', outcome: 'x', status: 503, ms: 1 });
    logOutcome({ route: 'register', outcome: 'x', status: 400, ms: 1 });
    expect(err).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('filterKeys', () => {
  it('keeps allowlisted names sorted once each and counts the rest', () => {
    expect(filterKeys(['scope', PLANTED_PLAIN, 'client_name', 'scope', PLANTED_KPR], REGISTER_LOG_KEYS)).toEqual({
      keys: ['client_name', 'scope'],
      otherKeys: 2,
    });
  });
  it('the register list holds no token parameter names', () => {
    for (const k of ['code', 'code_verifier', 'refresh_token', 'client_secret', 'grant_type']) {
      expect(REGISTER_LOG_KEYS).not.toContain(k);
    }
  });
});

describe('errorNameTag / dbCode', () => {
  it.each([
    [new TypeError('x'), 'TypeError'],
    [Object.assign(new Error('x'), { name: 'AbortError' }), 'AbortError'],
    [Object.assign(new Error('x'), { name: PLANTED_KPR }), 'Other'],
    [Object.assign(new Error('x'), { name: PLANTED_PLAIN }), 'Other'],
    [{ name: 42 }, 'Other'],
    [null, 'Other'],
    ['string thrown', 'Other'],
  ])('%p → %p', (err, tag) => {
    expect(errorNameTag(err)).toBe(tag);
  });
  it.each([
    ['57014', '57014'],
    ['PGRST202', 'PGRST202'],
    ['', 'none'],
    [PLANTED_PLAIN, 'none'],
    [undefined, 'none'],
  ])('dbCode(%p) → %p', (code, out) => {
    expect(dbCode(code)).toBe(out);
  });
});
