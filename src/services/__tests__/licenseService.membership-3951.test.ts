/**
 * BACKLOG-3951 — the renderer licenseService maps main's `membership` field
 * (license:get / license:refresh) onto LicenseInfo; absent stays undefined.
 */

import { licenseService } from "../licenseService";

describe("renderer licenseService maps main's membership field", () => {

  it.each(["get", "refresh"] as const)("%s: membership → membershipStanding / membershipOrgName; absent → undefined", async (fn) => {
    const mainAnswer = jest.fn();
    (window.api as unknown as { license: unknown }).license = { get: mainAnswer, refresh: mainAnswer };
    mainAnswer.mockResolvedValueOnce({
      success: true,
      sessionBacked: true,
      license: { license_type: "individual", ai_detection_enabled: false },
      membership: {
        standing: "left_brokerage",
        organization_name: "Fixture Brokerage",
        organization_id: "fixture-org-a",
      },
    });
    const withField = await licenseService[fn]();
    expect(withField.data).toMatchObject({
      membershipStanding: "left_brokerage",
      membershipOrgName: "Fixture Brokerage",
      membershipOrgId: "fixture-org-a",
    });

    mainAnswer.mockResolvedValueOnce({
      success: true,
      sessionBacked: true,
      license: { license_type: "individual", ai_detection_enabled: false },
    });
    const without = await licenseService[fn]();
    expect(without.data?.membershipStanding).toBeUndefined();
    expect(without.data?.membershipOrgId).toBeUndefined();
  });
});
