/**
 * BACKLOG-3879: outlookFetchService.initialize() returns false (instead of
 * throwing) when no Outlook mailbox is connected. canSync must keep reporting
 * "not ready" WITHOUT reconnectRequired (BACKLOG-3203: never connected is not
 * "reconnect me").
 */
import { OutlookContactProvider } from "../outlookContactProvider";
import outlookFetchService from "../../outlookFetchService";

jest.mock("../../outlookFetchService");

const mockInit = outlookFetchService.initialize as jest.Mock;

describe("OutlookContactProvider.canSync (BACKLOG-3879)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("not connected (initialize false) -> ready false, no reconnectRequired", async () => {
    mockInit.mockResolvedValue(false);
    const result = await new OutlookContactProvider().canSync("u1");
    expect(result.ready).toBe(false);
    expect(result.reconnectRequired).toBeUndefined();
    expect(result.error).toContain("connect Outlook");
  });

  it("connected -> ready true", async () => {
    mockInit.mockResolvedValue(true);
    expect(await new OutlookContactProvider().canSync("u1")).toEqual({ ready: true });
  });

  it("initialize throws -> ready false, no reconnectRequired", async () => {
    mockInit.mockRejectedValue(new Error("db down"));
    const result = await new OutlookContactProvider().canSync("u1");
    expect(result.ready).toBe(false);
    expect(result.reconnectRequired).toBeUndefined();
  });
});
