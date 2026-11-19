/**
 * BACKLOG-4263 PR-10.8 fixtures.
 *
 * Claim answer: keys from the producer, supabase/migrations/20261118180000_backlog_4263_ai_app_connect_notice.sql
 * (jsonb_build_object in ai_app_notice_claim, the KEYS:claim line). Value formats transcribed from
 * the SQL harness output on the test database (scratchpad run3, MUT_M11 first claim element):
 *   {"id": "<uuid>", "user_id": "<uuid>", "attempts": 5, "provider": "anthropic", "replaced": false,
 *    "connected_at": "2026-11-18T23:52:56.767534+00:00"}
 * The ids below are invented; the timestamp shape (microseconds, +00:00) is the producer's.
 *
 * Missing function: the PostgREST shape transcribed in electron/handlers/__tests__/checklistHandlers-3618.test.ts
 * (production, 2026-09-30), with this function's name and parameter.
 *
 * Missing user: auth-js GoTrueAdminApi.getUserById returns { data: { user: null }, error } for an
 * AuthError (node_modules/@supabase/auth-js/dist/main/GoTrueAdminApi.js:527-541); GoTrue answers an
 * unknown user with status 404 and code 'user_not_found' (auth-js lib/error-codes.d.ts). Derived
 * from the library source, not captured from a live call.
 */

export const NOTICE_A = '00000000-0000-4000-8000-0000426310a1'; // pii-allow-uuid: invented fixture id
export const NOTICE_B = '00000000-0000-4000-8000-0000426310b2'; // pii-allow-uuid: invented fixture id
export const USER_A = '00000000-0000-4000-8000-0000426320a1'; // pii-allow-uuid: invented fixture id
export const USER_B = '00000000-0000-4000-8000-0000426320b2'; // pii-allow-uuid: invented fixture id

export const ADDRESS_A = 'person-a@example.test';
export const ADDRESS_B = 'person-b@example.test';

export interface ClaimRow {
  id: string;
  user_id: string;
  attempts: number;
  provider: 'anthropic' | 'openai';
  replaced: boolean;
  connected_at: string;
}

export function claimRow(over: Partial<ClaimRow> = {}): ClaimRow {
  return {
    id: NOTICE_A,
    user_id: USER_A,
    attempts: 1,
    provider: 'anthropic',
    replaced: false,
    connected_at: '2026-11-18T14:05:56.767534+00:00',
    ...over,
  };
}

export const MISSING_CLAIM_FUNCTION = {
  code: 'PGRST202',
  details:
    'Searched for the function public.ai_app_notice_claim with parameter p_limit or with a single unnamed json/jsonb parameter, but no matches were found in the schema cache.',
  hint: null,
  message: 'Could not find the function public.ai_app_notice_claim(p_limit) in the schema cache',
};

export const UNDEFINED_FUNCTION_42883 = { code: '42883', message: 'function public.ai_app_notice_claim(integer) does not exist' };

export const USER_NOT_FOUND = { name: 'AuthApiError', status: 404, code: 'user_not_found', message: 'User not found' };
