/**
 * safeNextPath — BACKLOG-3863 PR-2 (SR R7), BACKLOG-3705.
 *
 * @jest-environment node
 */

import { NextResponse } from 'next/server';
import {
  NEXT_PATH_COOKIE_NAME,
  clearNextPathCookie,
  isSafeNextPath,
  readNextPathCookie,
  safeNextPath,
  setNextPathCookie,
} from '@/lib/auth/safeNextPath';

const ORIGIN = 'http://localhost:3000';

describe('refused -> /dashboard', () => {
  it.each([
    ['protocol-relative host', '//evil.test'],
    ['protocol-relative host with a dashboard path', '//evil.test/dashboard'],
    ['backslash host', '/\\evil.test'],
    ['backslash host with a dashboard path', '/\\evil.test/dashboard'],
    ['absolute URL', 'https://evil.test/dashboard'],
    ['scheme', 'javascript:alert(1)'],
    ['relative', 'dashboard'],
    ['empty', ''],
    ['parent segment', '/dashboard/../admin'],
    ['parent segment, encoded-looking tail', '/dashboard/..'],
    ['newline', '/dashboard\n'],
    ['tab', '/dashboard/\tbilling'],
    ['NUL', '/dashboard\u0000'],
    ['DEL', '/dashboard\u007f'],
    ['outside /dashboard', '/settings'],
    ['outside /dashboard: login', '/login'],
    ['bare prefix', '/dashboardx'],
    ['bare prefix with sub-path', '/dashboard-evil/x'],
    ['root', '/'],
  ])('%s', (_n, raw) => {
    expect(isSafeNextPath(raw)).toBe(false);
    expect(safeNextPath(raw)).toBe('/dashboard');
  });

  it.each([
    '/dashboard/%2e%2e/login',
    '/dashboard/%2E%2E/login',
    '/dashboard/%252e%252e/login',
    '/dashboard/%25252e%25252e/login',
    '/dashboard/%252e%252e/%5Cevil.test',
    '%2F%2Fevil.test',
    '/%2Fevil.test',
    '/dashboard/%5Cevil.test',
    '/dashboard/%255Cevil.test',
    '/dashboard%2F..%2F',
    '/dashboard/%2e%2e%2fadmin',
    '/dashboard/%zz',
    '/dashboard/x%0Ay',
    '/dashboard/\\evil.test',
    '/dashboard/a\\..\\login',
  ])('encoded or backslash traversal: %s', (raw) => {
    expect(isSafeNextPath(raw)).toBe(false);
    expect(safeNextPath(raw)).toBe('/dashboard');
  });

  it('a value still changing after the decode cap is refused, one inside it is not', () => {
    const nested = (rounds: number): string => {
      let v = '%78'; // "x" encoded once
      for (let i = 1; i < rounds; i++) v = v.replace(/%/g, '%25');
      return `/dashboard/${v}`;
    };
    expect(isSafeNextPath(nested(2))).toBe(true);
    expect(isSafeNextPath(nested(9))).toBe(false);
  });

  it.each([null, undefined, 42, {}])('non-string %p', (raw) => {
    expect(safeNextPath(raw)).toBe('/dashboard');
  });
});

describe('kept', () => {
  it.each([
    '/dashboard',
    '/dashboard/billing',
    '/dashboard/billing/x',
    '/dashboard?tab=1',
    '/dashboard#top',
    '/dashboard/billing?from=desktop',
  ])('%s', (raw) => {
    expect(safeNextPath(raw)).toBe(raw);
  });
});

describe('every kept value resolves on this origin', () => {
  it.each(['/dashboard', '/dashboard/billing', '/dashboard?x=//evil.test'])('%s', (raw) => {
    expect(new URL(safeNextPath(raw), ORIGIN).origin).toBe(ORIGIN);
  });
});

describe('cookie', () => {
  function req(cookie: string): Request {
    return new Request(`${ORIGIN}/auth/callback`, { headers: { cookie } });
  }

  it('reads a safe value back', () => {
    expect(readNextPathCookie(req(`a=b; ${NEXT_PATH_COOKIE_NAME}=%2Fdashboard%2Fbilling`))).toBe('/dashboard/billing');
  });

  it('re-validates on read: an unsafe value reads as null', () => {
    expect(readNextPathCookie(req(`${NEXT_PATH_COOKIE_NAME}=%2F%2Fevil.test`))).toBeNull();
    expect(readNextPathCookie(req(`${NEXT_PATH_COOKIE_NAME}=%2Fsettings`))).toBeNull();
    expect(readNextPathCookie(req(`${NEXT_PATH_COOKIE_NAME}=%E0%A4%A`))).toBeNull();
  });

  it('absent -> null', () => {
    expect(readNextPathCookie(req('keepr_invite=invite.abc'))).toBeNull();
  });

  it('never stores an unsafe value', () => {
    const response = NextResponse.redirect(`${ORIGIN}/login`);
    setNextPathCookie(response, '//evil.test');
    expect(response.cookies.get(NEXT_PATH_COOKIE_NAME)).toBeUndefined();
  });

  it('clear sets an expired cookie on Path=/auth', () => {
    const response = NextResponse.redirect(`${ORIGIN}/dashboard`);
    clearNextPathCookie(response);
    const header = response.headers.getSetCookie().find((c) => c.startsWith(`${NEXT_PATH_COOKIE_NAME}=`));
    expect(header).toBeDefined();
    expect(header!.toLowerCase()).toContain('path=/auth');
    expect(header!.toLowerCase()).toMatch(/expires=thu, 01 jan 1970|max-age=0/);
  });
});
