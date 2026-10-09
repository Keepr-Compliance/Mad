/**
 * BACKLOG-3833 R4: the once-a-minute idle check reads the session row through
 * getSessionTimes, which must never write (validateSession UPDATEs
 * last_accessed_at and deletes expired rows).
 */
const mockDbGet = jest.fn();
const mockDbRun = jest.fn();
jest.mock("../core/dbConnection", () => ({
  dbGet: (...a: unknown[]) => mockDbGet(...a),
  dbRun: (...a: unknown[]) => mockDbRun(...a),
}));
jest.mock("../../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { getSessionTimes } from "../sessionDbService";

const ROW = {
  user_id: "user-1",
  created_at: "2026-10-08 12:00:00",
  last_accessed_at: "2026-10-08 12:00:00",
  expires_at: "2026-10-01T00:00:00.000Z", // already past: still no delete
};

describe("getSessionTimes (BACKLOG-3833)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns the row's times and writes nothing, even for an expired row", () => {
    mockDbGet.mockReturnValue(ROW);
    for (let i = 0; i < 10; i++) {
      expect(getSessionTimes("tok")).toEqual(ROW);
    }
    expect(mockDbGet).toHaveBeenCalledTimes(10);
    expect(mockDbRun).not.toHaveBeenCalled();
    const sqlText = String(mockDbGet.mock.calls[0][0]);
    expect(sqlText).toMatch(/^\s*SELECT\b/i);
    expect(sqlText).not.toMatch(/\b(UPDATE|DELETE|INSERT)\b/i);
    expect(mockDbGet.mock.calls[0][1]).toEqual(["tok"]);
  });

  it("returns null when there is no row", () => {
    mockDbGet.mockReturnValue(undefined);
    expect(getSessionTimes("tok")).toBeNull();
    expect(mockDbRun).not.toHaveBeenCalled();
  });
});
