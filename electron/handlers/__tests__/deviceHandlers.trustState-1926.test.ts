/**
 * BACKLOG-1926: the trust-state event crosses the process boundary.
 * Main: DeviceDetectionService "device-trust-state" -> sendToMainWindow("device:trust-state").
 * Preload: deviceBridge.onTrustState listens on the same channel and unsubscribes.
 */
import { EventEmitter } from "events";

const mockSend = jest.fn();
const mockOn = jest.fn();
const mockRemoveListener = jest.fn();

jest.mock("electron", () => ({
  ipcMain: { handle: jest.fn() },
  BrowserWindow: jest.fn(),
  ipcRenderer: {
    on: (...a: unknown[]) => mockOn(...a),
    removeListener: (...a: unknown[]) => mockRemoveListener(...a),
    invoke: jest.fn(),
  },
}));
jest.mock("electron-log", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("@sentry/electron/main", () => ({ addBreadcrumb: jest.fn(), captureException: jest.fn() }));
jest.mock("../../windowRegistry", () => ({ sendToMainWindow: (...a: unknown[]) => mockSend(...a) }));

const mockService = new EventEmitter();
jest.mock("../../services/deviceDetectionService", () => ({
  deviceDetectionService: mockService,
}));

import { registerDeviceHandlers } from "../deviceHandlers";
import { deviceBridge } from "../../preload/deviceBridge";

describe("device:trust-state wiring (BACKLOG-1926)", () => {
  it("main forwards each trust state to the renderer on device:trust-state", () => {
    registerDeviceHandlers({} as never);
    mockService.emit("device-trust-state", { udid: "u", state: "locked" });
    mockService.emit("device-trust-state", { udid: "u", state: "trusted" });
    expect(mockSend).toHaveBeenCalledWith("device:trust-state", { udid: "u", state: "locked" });
    expect(mockSend).toHaveBeenCalledWith("device:trust-state", { udid: "u", state: "trusted" });
  });

  it("preload onTrustState listens on device:trust-state and passes the payload through", () => {
    const cb = jest.fn();
    const unsubscribe = deviceBridge.onTrustState(cb);
    expect(mockOn).toHaveBeenCalledWith("device:trust-state", expect.any(Function));
    const listener = mockOn.mock.calls.find((c) => c[0] === "device:trust-state")![1] as (
      e: unknown,
      d: unknown,
    ) => void;
    listener({}, { udid: "u", state: "trust_pending" });
    expect(cb).toHaveBeenCalledWith({ udid: "u", state: "trust_pending" });
    unsubscribe();
    expect(mockRemoveListener).toHaveBeenCalledWith("device:trust-state", listener);
  });
});
