/**
 * @jest-environment node
 */
/**
 * BACKLOG-4185 B2: registerDevice hands the device-profile service the machine
 * id it already read and the devices row id the upsert returned — on success
 * only, once per call, with the reason its caller gave. main.ts:699 (deep-link
 * sign-in) passes "login"; every other caller defaults to "restore".
 */
const mockMachineIdSync = jest.fn(() => "machine-id-a");
jest.mock("node-machine-id", () => ({ machineIdSync: mockMachineIdSync }));
jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
const mockOnDeviceRegistered = jest.fn();
jest.mock("../deviceProfile/deviceProfileService", () => ({ onDeviceRegistered: mockOnDeviceRegistered }));

const mockSingle = jest.fn();
interface Chain {
  from: jest.Mock;
  upsert: jest.Mock;
  select: jest.Mock;
  single: jest.Mock;
}
const chain: Chain = { from: jest.fn(), upsert: jest.fn(), select: jest.fn(), single: mockSingle };
chain.from.mockReturnValue(chain);
chain.upsert.mockReturnValue(chain);
chain.select.mockReturnValue(chain);
jest.mock("../supabaseService", () => ({ __esModule: true, default: { getClient: () => chain } }));

import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { registerDevice } from "../deviceService";

const ROW = randomUUID();

beforeEach(() => {
  jest.clearAllMocks();
});

describe("registerDevice -> onDeviceRegistered", () => {
  it("success: one call with (userId, the machine id it read, reason, devices.id); one machine-id read", async () => {
    mockSingle.mockResolvedValueOnce({ data: { id: ROW, user_id: "u1", device_id: "machine-id-a" }, error: null });
    await registerDevice("u1");
    expect(mockOnDeviceRegistered.mock.calls).toEqual([["u1", "machine-id-a", "restore", ROW]]);
    expect(mockMachineIdSync).toHaveBeenCalledTimes(1);
  });
  it("login reason is passed through", async () => {
    mockSingle.mockResolvedValueOnce({ data: { id: ROW }, error: null });
    await registerDevice("u1", "login");
    expect(mockOnDeviceRegistered.mock.calls[0][2]).toBe("login");
  });
  it("device limit or error: no call", async () => {
    mockSingle.mockResolvedValueOnce({ data: null, error: { message: "Device limit reached" } });
    await registerDevice("u1");
    mockSingle.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    await registerDevice("u1");
    expect(mockOnDeviceRegistered).not.toHaveBeenCalled();
  });
  it("main.ts deep-link sign-in registers with reason login", () => {
    const main = fs.readFileSync(path.resolve(__dirname, "../../main.ts"), "utf8");
    expect(main).toMatch(/registerDevice\(user\.id, "login"\)/);
  });
});
