/**
 * BACKLOG-4155 — the desktop's membership standing and the portal's
 * classifier give the SAME purchase verdict for every row combination.
 *
 * Electron cannot import packages/shared at runtime (tsconfig.electron.json
 * rootDir ./electron; packaging leaves packages/** out), but a TEST may: this
 * file is excluded from the electron build and tsconfig.test.json's rootDir is
 * the repo root. Relative import, no moduleNameMapper.
 *
 * Compared: the purchase VERDICT, not labels (the vocabularies differ:
 * personal_owner / left_brokerage, deactivated / unknown).
 *   portal refuses  <=> classifyPortalAccess is floor via 'unlicensed'
 *   desktop refuses <=> classifyMembershipStanding is 'unlicensed'
 *
 * Sweep, not sample: every ordered list of 1-3 brokerage rows over every
 * status the code distinguishes (granting, unassigned, both deactivated,
 * pending, null, a status never seen), each with and without the user's own
 * personal row. Row shape: getMembershipStandingRows' select
 * (user_id, organization_id, role, license_status, organizations(*)), the
 * organizations embed from the transcribed UNASSIGNED_MEMBER_ROW.
 */

jest.mock("../supabaseService", () => ({ __esModule: true, default: {} }));
jest.mock("../logService", () => ({ __esModule: true, default: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));

import { classifyPortalAccess, type PortalMembershipRow } from "../../../packages/shared/src/billing/planRule";
import { classifyMembershipStanding } from "../membershipStanding";
import { UNASSIGNED_MEMBER_ROW } from "./helpers/membership3951Fixtures";
import { FIXTURE_USER_ID, personalMembership, type Row } from "./helpers/postgrestEmulator";

const U = FIXTURE_USER_ID;
const STATUSES: (string | null)[] = ["active", "unassigned", "suspended", "expired", "pending", null, "on_hold"];
const ORGS = ["a", "b", "c"].map((k) => `00000000-0000-4000-8000-0000004155c${k}`); // pii-allow-uuid: invented fixture ids

function brokerageRow(index: number, status: string | null): Row {
  const embed = UNASSIGNED_MEMBER_ROW.organizations as Record<string, unknown>;
  return {
    user_id: U,
    organization_id: ORGS[index],
    role: "agent",
    license_status: status,
    organizations: { ...embed, id: ORGS[index], name: `Brokerage ${index}` },
  };
}

function* combos(): Generator<[string, Row[]]> {
  for (let n = 1; n <= 3; n += 1) {
    const total = STATUSES.length ** n;
    for (let i = 0; i < total; i += 1) {
      const picked: (string | null)[] = [];
      let k = i;
      for (let j = 0; j < n; j += 1) {
        picked.push(STATUSES[k % STATUSES.length]);
        k = Math.floor(k / STATUSES.length);
      }
      const rows = picked.map((s, j) => brokerageRow(j, s));
      const label = picked.map(String).join(",");
      yield [label, rows];
      yield [`${label},own-personal`, [...rows, personalMembership()]];
    }
  }
}

const CASES = [...combos()];

describe("BACKLOG-4155: desktop and portal give the same purchase verdict", () => {
  it("the sweep covers every 1-3 row ordering, with and without a personal row", () => {
    expect(CASES.length).toBe(2 * (7 + 49 + 343));
  });

  it.each([
    ["no rows", [] as Row[]],
    ["own personal row only", [personalMembership()]],
  ])("%s: both allow", (_l, rows) => {
    expect(classifyPortalAccess(rows as unknown as PortalMembershipRow[], U)).not.toMatchObject({ via: "unlicensed" });
    expect(classifyMembershipStanding(rows, U).standing).not.toBe("unlicensed");
  });

  it("every combination: portal refuses exactly when desktop refuses, and both match the database rule", () => {
    const mismatches: string[] = [];
    let refused = 0;
    for (const [label, rows] of CASES) {
      const web = classifyPortalAccess(rows as unknown as PortalMembershipRow[], U);
      const webRefuses = web.kind === "floor" && web.via === "unlicensed";
      const desktopRefuses = classifyMembershipStanding(rows, U).standing === "unlicensed";
      // The DB unlock guard: refuse iff ANY brokerage row is unassigned and NONE grants.
      const statuses = rows.filter((r) => r.organization_id !== undefined && ORGS.includes(r.organization_id as string)).map((r) => r.license_status);
      const dbRefuses = statuses.includes("unassigned") && !statuses.includes("active");
      if (webRefuses !== desktopRefuses || webRefuses !== dbRefuses) {
        mismatches.push(`${label}: web=${webRefuses} desktop=${desktopRefuses} db=${dbRefuses}`);
      }
      if (webRefuses) refused += 1;
    }
    expect(mismatches).toEqual([]);
    // Non-vacuous: both verdicts occur in the sweep.
    expect(refused).toBeGreaterThan(0);
    expect(refused).toBeLessThan(CASES.length);
  });
});
