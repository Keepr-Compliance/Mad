/**
 * lib/auth/membership.ts — BACKLOG-3364.
 *
 * The three portal entry points each hand this module a raw PostgREST result
 * and act on one word back. Everything it can be handed is enumerated here,
 * because every one of these inputs is reachable in production and the wrong
 * answer to any of them is silent:
 *
 *   - the embed as an OBJECT, which is what the wire delivers;
 *   - the embed as an ARRAY, which is what supabase-js's inferred type says
 *     (no generated `Database` type, so it cannot know the cardinality);
 *   - the embed with the column absent, which is every response from a database
 *     that has not had migration 1 applied;
 *   - `null` data, which is what an error result — 42703 included — leaves.
 *
 * The organization records are the ones PR 1 captured from a real PostgREST,
 * read from supabase/tests/backlog-3364/fixtures/, not retyped here.
 *
 * @jest-environment node
 */

import {
  BROKERAGE_ORG_POST,
  BROKERAGE_ORG_PRE,
  PERSONAL_COLUMN,
  PERSONAL_ORG,
} from '../../helpers/postgrestEmulator';
import {
  PORTAL_MEMBERSHIP_SELECT,
  isPersonalMembership,
  pickBrokerageMembership,
  type EmbeddedOrganization,
  type PortalMembershipRow,
} from '@/lib/auth/membership';

const BROKERAGE_ID = '00000000-0000-4000-8000-0000003364bb'; // pii-allow-uuid: invented fixture id
const PERSONAL_ID = '00000000-0000-4000-8000-0000003364ee'; // pii-allow-uuid: invented fixture id
const OWNER_ID = '00000000-0000-4000-8000-000000336403'; // pii-allow-uuid: invented fixture id

function row(
  role: string,
  organization_id: string,
  organizations: EmbeddedOrganization | EmbeddedOrganization[] | null
): PortalMembershipRow {
  return { role, organization_id, organizations };
}

const personalOrg = { ...PERSONAL_ORG, [PERSONAL_COLUMN]: OWNER_ID } as EmbeddedOrganization;

describe('the select string', () => {
  it('embeds the whole organization record and names no column of it', () => {
    expect(PORTAL_MEMBERSHIP_SELECT).toContain('organizations(*)');
    expect(PORTAL_MEMBERSHIP_SELECT).not.toContain(PERSONAL_COLUMN);
  });
});

describe('isPersonalMembership', () => {
  it('is true for the organization ensure_personal_organization() creates', () => {
    expect(isPersonalMembership(row('agent', PERSONAL_ID, personalOrg))).toBe(true);
  });

  it('is true when the embed arrives as a one-element array', () => {
    // supabase-js's inferred type. Reading only `embed[0]` or only `embed`
    // would be right for exactly one of these two cases and silently wrong for
    // the other, with no type error either way.
    expect(isPersonalMembership(row('agent', PERSONAL_ID, [personalOrg]))).toBe(true);
  });

  it('is false for a brokerage, whose column is null', () => {
    expect(isPersonalMembership(row('broker', BROKERAGE_ID, BROKERAGE_ORG_POST))).toBe(false);
    expect(isPersonalMembership(row('broker', BROKERAGE_ID, [BROKERAGE_ORG_POST]))).toBe(false);
  });

  it('is false against a database where the column does not exist yet', () => {
    // Not "null" — ABSENT. The pre-migration record has 24 keys and this is
    // not one of them.
    expect(PERSONAL_COLUMN in BROKERAGE_ORG_PRE).toBe(false);
    expect(isPersonalMembership(row('broker', BROKERAGE_ID, BROKERAGE_ORG_PRE))).toBe(false);
  });

  it.each([
    ['a null embed', null],
    ['an empty array', [] as EmbeddedOrganization[]],
  ])('is false for %s', (_label, embed) => {
    expect(isPersonalMembership(row('agent', BROKERAGE_ID, embed))).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('is false for %s rather than throwing', (_label, value) => {
    expect(isPersonalMembership(value)).toBe(false);
  });
});

describe('pickBrokerageMembership', () => {
  const personal = row('agent', PERSONAL_ID, personalOrg);
  const broker = row('broker', BROKERAGE_ID, BROKERAGE_ORG_POST);
  const agent = row('agent', BROKERAGE_ID, BROKERAGE_ORG_POST);

  it.each([
    ['null — what an error result leaves behind', null],
    ['undefined', undefined],
    ['an empty array — the user belongs nowhere', []],
  ])('returns null for %s', (_label, rows) => {
    expect(pickBrokerageMembership(rows as PortalMembershipRow[] | null)).toBeNull();
  });

  it('returns null when the only membership is personal', () => {
    // The whole point: identical to the answer for a user with no row, which
    // is the answer every solo user gave before this item existed.
    expect(pickBrokerageMembership([personal])).toBeNull();
  });

  it('returns the brokerage row when a personal row sorts first', () => {
    expect(pickBrokerageMembership([personal, broker])).toBe(broker);
  });

  it('returns the brokerage row when a personal row sorts last', () => {
    expect(pickBrokerageMembership([broker, personal])).toBe(broker);
  });

  it('keeps the order the query returned for two brokerage rows', () => {
    expect(pickBrokerageMembership([agent, broker])).toBe(agent);
    expect(pickBrokerageMembership([broker, agent])).toBe(broker);
  });

  it('skips a null row rather than returning it as a membership', () => {
    expect(pickBrokerageMembership([null as unknown as PortalMembershipRow, broker])).toBe(broker);
  });

  it('is not fooled by a personal row whose embed came back as an array', () => {
    expect(pickBrokerageMembership([row('agent', PERSONAL_ID, [personalOrg])])).toBeNull();
  });
});
