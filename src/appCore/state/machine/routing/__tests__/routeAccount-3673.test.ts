/**
 * BACKLOG-3673 C1 — the one routing function, table-tested.
 *
 * Every row of the plan's routing table reduces to the account record, so the
 * table here is the record's three values plus malformed IPC input. Terms are
 * not an input (SR condition 2): the terms screen is AuthContext's and is shown
 * over whichever destination this returns.
 */
import { routeAccount, type AccountSetup } from "../routeAccount";
import { readAccountSetup } from "../readAccountSetup";

describe("C1 — routeAccount", () => {
  const table: Array<[AccountSetup, "dashboard" | "setup" | "unavailable"]> = [
    ["finished", "dashboard"], // rows 11-16, 18, 19 (record or cache set)
    ["not-finished", "setup"], // rows 1-10, 17
    ["unknown", "unavailable"], // row 20: the Retry / Sign out screen, never setup
  ];

  it.each(table)("setup=%s -> %s", (setup, destination) => {
    expect(routeAccount({ setup })).toEqual({ destination });
  });

  it("a malformed runtime value is unavailable: never the dashboard, never setup (SR C1 allowlist)", () => {
    for (const bad of [undefined, null, "", "FINISHED", "done", true, 1]) {
      expect(routeAccount({ setup: bad as unknown as AccountSetup })).toEqual({
        destination: "unavailable",
      });
    }
  });
});

describe("C1 — readAccountSetup (IPC result -> routing input)", () => {
  it("a well-formed answer passes through", () => {
    expect(
      readAccountSetup({
        success: true,
        setup: "finished",
        emailStepAnswered: true,
        contactSourceAnswered: true,
      }),
    ).toEqual({
      setup: "finished",
      emailStepAnswered: true,
      contactSourceAnswered: true,
      hasRecordedEmailProvider: false,
    });
  });

  it.each([
    ["missing bridge / rejection", undefined],
    ["null", null],
    ["success:false", { success: false, setup: "finished" }],
    ["unrecognised setup value", { success: true, setup: "yes" }],
    ["setup missing", { success: true }],
  ])("%s -> unknown, nothing answered", (_name, input) => {
    expect(readAccountSetup(input)).toEqual({
      setup: "unknown",
      emailStepAnswered: false,
      contactSourceAnswered: false,
      hasRecordedEmailProvider: false,
    });
  });

  it("answers are true only when literally true", () => {
    expect(
      readAccountSetup({
        success: true,
        setup: "not-finished",
        emailStepAnswered: "true",
        contactSourceAnswered: 1,
      }),
    ).toEqual({
      setup: "not-finished",
      emailStepAnswered: false,
      contactSourceAnswered: false,
      hasRecordedEmailProvider: false,
    });
  });
});

describe("BACKLOG-3888 — readAccountSetup carries the recorded mailbox providers", () => {
  const base = { success: true, setup: "finished", emailStepAnswered: true, contactSourceAnswered: true };
  it.each<[string, unknown, boolean]>([
    ["one provider", ["outlook"], true],
    ["two providers", ["outlook", "gmail"], true],
    ["empty set", [], false],
    ["only empty strings", [""], false],
    ["not an array", "outlook", false],
    ["absent (timeout / cache path)", undefined, false],
  ])("%s -> %s", (_name, emailProviders, expected) => {
    expect(readAccountSetup({ ...base, emailProviders }).hasRecordedEmailProvider).toBe(expected);
  });
});
