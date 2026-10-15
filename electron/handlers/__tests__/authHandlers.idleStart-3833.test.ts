/**
 * BACKLOG-3833 B1: main starts the once-a-minute idle check. It is started by
 * registerAuthHandlers (which main.ts must call for any sign-in to work), so
 * the check cannot be unwired without unwiring auth.
 */
const mockStart = jest.fn();
jest.mock("../../services/sessionIdleEnforcer", () => ({
  startSessionIdleEnforcement: () => mockStart(),
}));
const mockRegisterSession = jest.fn();
jest.mock("../googleAuthHandlers", () => ({ registerGoogleAuthHandlers: jest.fn() }));
jest.mock("../microsoftAuthHandlers", () => ({ registerMicrosoftAuthHandlers: jest.fn() }));
jest.mock("../sessionHandlers", () => ({ registerSessionHandlers: () => mockRegisterSession() }));
jest.mock("../sharedAuthHandlers", () => ({ registerSharedAuthHandlers: jest.fn() }));
jest.mock("../../services/databaseService", () => ({ __esModule: true, default: {} }));
jest.mock("../../services/supabaseService", () => ({ __esModule: true, default: {} }));
jest.mock("../../services/auditService", () => ({ __esModule: true, default: {} }));
jest.mock("../../services/logService", () => ({ __esModule: true, default: {} }));
jest.mock("../../services/supportAccess", () => ({ getSupportAccess: jest.fn() }));

import fs from "fs";
import path from "path";
import { registerAuthHandlers } from "../authHandlers";

describe("idle check startup (BACKLOG-3833)", () => {
  it("registerAuthHandlers starts the once-a-minute idle check, with the session channels", () => {
    registerAuthHandlers(null);
    expect(mockRegisterSession).toHaveBeenCalledTimes(1);
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it("main.ts calls registerAuthHandlers", () => {
    const main = fs.readFileSync(path.join(__dirname, "..", "..", "main.ts"), "utf8");
    expect(main).toMatch(/^\s*registerAuthHandlers\(mainWindow!?\);/m);
  });
});
