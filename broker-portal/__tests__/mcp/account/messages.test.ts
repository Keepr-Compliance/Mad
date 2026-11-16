/**
 * @jest-environment node
 *
 * BACKLOG-4238 — the support-session messages on the consent page and the AI
 * apps page, word for word.
 */

import { M_A, M_C } from '@/lib/mcp/account/messages';

describe('support-session messages', () => {
  it('consent page', () => {
    expect(M_C.supportSession).toBe(
      'Connecting an AI app is not available during a support session. End the support session, then try again.'
    );
  });

  it('AI apps page', () => {
    expect(M_A.supportSession).toBe('Not available during a support session. End the support session, then try again.');
  });

  it('neither tells the person to sign out', () => {
    for (const m of [M_C.supportSession, M_A.supportSession]) expect(m.toLowerCase()).not.toContain('sign out');
  });
});
