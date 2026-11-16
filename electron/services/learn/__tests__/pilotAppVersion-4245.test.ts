/**
 * @jest-environment node
 */

/**
 * BACKLOG-4245: a prerelease app version is sent in the Learn pilot report as
 * its release part. The schema (pilotReport.ts PilotReportSchema) and the
 * server (20261112130000_backlog_4219_learn_pilot_report.sql) accept only
 * x.y.z. The full-report case lives in pilotReport-4219.test.ts.
 */

import { pilotAppVersion, PilotReportSchema } from "../pilotReport";

describe("pilotAppVersion", () => {
  it.each([
    ["2.50.0-beta.1", "2.50.0"],
    ["2.50.0-beta.12", "2.50.0"],
    ["2.50.0-alpha.3", "2.50.0"],
    ["2.50.0+build.7", "2.50.0"],
    ["2.48.0", "2.48.0"],
    ["v2.50.0-beta.1", "v2.50.0-beta.1"],
    ["2.50-beta.1", "2.50-beta.1"],
    ["2.50.0-", "2.50.0-"],
  ])("%s -> %s", (input, expected) => {
    expect(pilotAppVersion(input)).toBe(expected);
  });


  it("every mapped beta version passes the schema's app_version check", () => {
    const appVersion = PilotReportSchema.shape.app_version;
    for (const v of ["2.50.0-beta.1", "2.50.0-alpha.3", "2.50.0+build.7"]) {
      expect(appVersion.safeParse(v).success).toBe(false);
      expect(appVersion.safeParse(pilotAppVersion(v)).success).toBe(true);
    }
  });
});
