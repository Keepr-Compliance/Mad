/**
 * @jest-environment node
 *
 * BACKLOG-4238 — the consent page file sits where /oauth/authorize sends the
 * browser (CONSENT_PATH_PREFIX + the request id). Kept apart from the page
 * tests, which import the page module.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { CONSENT_PATH_PREFIX } from '@/lib/mcp/oauth/paths';

describe('consent page location', () => {
  it('app + CONSENT_PATH_PREFIX + [requestId]/page.tsx exists', () => {
    expect(existsSync(path.resolve(__dirname, `../../../app${CONSENT_PATH_PREFIX}[requestId]/page.tsx`))).toBe(true);
  });
});
