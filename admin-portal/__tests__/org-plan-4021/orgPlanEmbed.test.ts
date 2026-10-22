/**
 * BACKLOG-4021: pickOrgPlanRow reads the plan from the organization_plans embed in either shape.
 * Fixture source: PostgREST documented behaviour for a one-to-one relationship (organization_plans
 * has UNIQUE (organization_id)): the embed comes back as a single object, not an array.
 */
import { describe, expect, it } from 'vitest';
import { pickOrgPlanRow } from '@/lib/orgPlanEmbed';

const ROW = { plan_id: 'p1', plans: { id: 'p1', name: 'Invented Team Plan', tier: 'team' } };

describe('pickOrgPlanRow', () => {
  it('object (what PostgREST returns for the unique FK)', () => {
    expect(pickOrgPlanRow(ROW)?.plans?.name).toBe('Invented Team Plan');
  });
  it('array', () => {
    expect(pickOrgPlanRow([ROW])?.plans?.name).toBe('Invented Team Plan');
  });
  it('null, undefined and empty array give null', () => {
    expect(pickOrgPlanRow(null)).toBeNull();
    expect(pickOrgPlanRow(undefined)).toBeNull();
    expect(pickOrgPlanRow([])).toBeNull();
  });
  it('row with no joined plan keeps plan_id and null plans', () => {
    expect(pickOrgPlanRow({ plan_id: 'p1', plans: null })?.plans).toBeNull();
  });
});
