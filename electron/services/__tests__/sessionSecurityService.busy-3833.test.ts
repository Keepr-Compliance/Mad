/**
 * BACKLOG-3833: a user-started long operation is not idle time.
 */
const mockLogService = {
  info: jest.fn().mockResolvedValue(undefined),
  warn: jest.fn().mockResolvedValue(undefined),
  error: jest.fn().mockResolvedValue(undefined),
  debug: jest.fn().mockResolvedValue(undefined),
};
jest.mock("../logService", () => mockLogService);

import { sessionSecurityService as svc } from "../sessionSecurityService";

const MIN = 60 * 1000;
const TOKEN = "tok";
let clock = 0;
const session = () => ({ created_at: new Date(clock).toISOString().replace("T", " ").slice(0, 19) });
const at = (min: number) => {
  clock = T0 + min * MIN;
};
const T0 = Date.parse("2026-10-08T12:00:00Z");

describe("SessionSecurityService busy registry (BACKLOG-3833)", () => {
  beforeEach(() => {
    svc.clearAllActivity();
    clock = T0;
    jest.spyOn(Date, "now").mockImplementation(() => clock);
  });
  afterEach(() => jest.restoreAllMocks());

  const check = async () => {
    const s = { created_at: "2026-10-08 12:00:00" };
    return svc.checkSessionValidity(s, TOKEN);
  };

  it("normal idle still expires after 30 min", async () => {
    expect((await check()).valid).toBe(true);
    at(31);
    expect(await check()).toEqual({ valid: false, reason: "idle" });
  });

  it("40-min sync without input is not expired", async () => {
    await check();
    const t = svc.beginBusy("sync");
    at(20);
    expect((await check()).valid).toBe(true);
    at(40);
    expect((await check()).valid).toBe(true);
    svc.endBusy(t);
    at(41);
    expect((await check()).valid).toBe(true);
  });

  it("expires 30 min after the sync ends, not before", async () => {
    await check();
    const t = svc.beginBusy("sync");
    at(40);
    svc.endBusy(t);
    at(40 + 29);
    expect((await check()).valid).toBe(true);
    at(40 + 31);
    expect(await check()).toEqual({ valid: false, reason: "idle" });
  });

  it("a leaked token stops counting after 6 h", async () => {
    await check();
    svc.beginBusy("leaked");
    at(6 * 60 - 1);
    expect((await check()).valid).toBe(true);
    at(6 * 60 + 29);
    expect((await check()).valid).toBe(true); // idle runs from the cap (6 h), 29 min
    at(6 * 60 + 31);
    expect(await check()).toEqual({ valid: false, reason: "idle" });
  });

  it("runBusy ends its token when the operation throws", async () => {
    await check();
    await expect(svc.runBusy("x", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    at(31);
    expect(await check()).toEqual({ valid: false, reason: "idle" });
  });

  it("the user's Reload click restarts the idle clock", async () => {
    await check();
    at(29);
    svc.noteUserReload();
    at(29 + 5);
    expect((await check()).valid).toBe(true);
  });

  it("the absolute 24 h limit still applies during a sync", async () => {
    await check();
    svc.beginBusy("sync");
    at(25 * 60);
    expect(await check()).toEqual({ valid: false, reason: "expired" });
  });
});
