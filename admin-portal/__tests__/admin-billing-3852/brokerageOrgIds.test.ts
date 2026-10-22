/** BACKLOG-3852: readPlanLinesWithOrgs returns the brokerage organization each plan line was decided from. */
import { describe, expect, it } from 'vitest';
import { makeClient } from '../plan-view-3859/emulator';
import { BASE_TABLES, BROKERAGE_ORG, NOW, U_BROKER, U_SOLO_PAID } from '../plan-view-3859/fixtures';
import { readPlanLines, readPlanLinesWithOrgs } from '@/lib/planLines';

type Svc = Parameters<typeof readPlanLinesWithOrgs>[0];

describe('readPlanLinesWithOrgs', () => {
  it('brokerage member: the brokerage org id; solo user: no entry; lines equal readPlanLines', async () => {
    const ids = [U_BROKER, U_SOLO_PAID];
    const { client } = makeClient(BASE_TABLES);
    const res = await readPlanLinesWithOrgs(client as unknown as Svc, ids, NOW);
    expect(res.brokerageOrgIds[U_BROKER]).toBe(BROKERAGE_ORG);
    expect(res.brokerageOrgIds[U_SOLO_PAID]).toBeUndefined();
    expect(res.lines[U_BROKER].kind).toBe('brokerage');
    const again = makeClient(BASE_TABLES).client;
    expect(await readPlanLines(again as unknown as Svc, ids, NOW)).toEqual(res.lines);
  });
});
