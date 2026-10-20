/**
 * BACKLOG-3339 slice B — bulk export when some files were saved but their
 * export could not be recorded in the audit log.
 *
 * Kept apart from failures: a red banner names every such deal, even when
 * other deals exported fine; the green banner counts recorded exports only.
 */

import { renderHook, act } from "@testing-library/react";
import { useBulkActions } from "../useBulkActions";

const exportEnhancedMock = window.api.transactions.exportEnhanced as jest.Mock;

const LABELS: Record<string, string> = {
  "tx-a": "1 Fixture Way",
  "tx-b": "2 Fixture Way",
  "tx-c": "3 Fixture Way",
};

const makeCallbacks = () => ({
  onComplete: jest.fn().mockResolvedValue(undefined),
  showError: jest.fn(),
  exitSelectionMode: jest.fn(),
  closeBulkDeleteModal: jest.fn(),
  closeBulkExportModal: jest.fn(),
  labelForTransaction: (id: string) => LABELS[id],
});

const NOT_RECORDED = (id: string) => ({ success: false, notRecorded: true, path: `/out/${id}`, error: "x" });

// Founder-approved wording (pm_comments b002a154), verbatim.
const PLURAL = (n: number, list: string) =>
  `${n} exports were saved but could not be recorded in the audit log: ${list}. Export them again before you send them. If this keeps happening, contact support.`;
const SINGULAR = (list: string) =>
  `1 export was saved but could not be recorded in the audit log: ${list}. Export it again before you send it. If this keeps happening, contact support.`;

beforeEach(() => {
  jest.clearAllMocks();
});

async function run(ids: string[]) {
  const cb = makeCallbacks();
  const { result } = renderHook(() => useBulkActions(new Set(ids), ids.length, cb));
  await act(async () => {
    await result.current.handleBulkExport("pdf");
  });
  return { cb, result };
}

it("3 deals, the middle one not recorded: red banner names it, green banner counts 2", async () => {
  exportEnhancedMock.mockImplementation((id: string) =>
    Promise.resolve(id === "tx-b" ? NOT_RECORDED(id) : { success: true, path: `/out/${id}` }),
  );
  const { cb, result } = await run(["tx-a", "tx-b", "tx-c"]);
  expect(result.current.bulkActionSuccess).toBe("Successfully exported 2 transactions");
  expect(cb.showError).toHaveBeenCalledWith(SINGULAR("2 Fixture Way"));
});

it("every deal not recorded: red banner with every address, no green banner", async () => {
  exportEnhancedMock.mockImplementation((id: string) => Promise.resolve(NOT_RECORDED(id)));
  const { cb, result } = await run(["tx-a", "tx-b", "tx-c"]);
  expect(result.current.bulkActionSuccess).toBeNull();
  expect(cb.showError).toHaveBeenCalledTimes(1);
  expect(cb.showError).toHaveBeenCalledWith(PLURAL(3, "1 Fixture Way, 2 Fixture Way, 3 Fixture Way"));
  expect(cb.showError).not.toHaveBeenCalledWith("Failed to export transactions");
});

it("not-recorded mixed with a real failure: the not-recorded deals are still named", async () => {
  exportEnhancedMock.mockImplementation((id: string) =>
    Promise.resolve(id === "tx-a" ? { success: false, error: "disk full" } : NOT_RECORDED(id)),
  );
  const { cb } = await run(["tx-a", "tx-b", "tx-c"]);
  expect(cb.showError).toHaveBeenCalledWith(PLURAL(2, "2 Fixture Way, 3 Fixture Way"));
});

it("all recorded: no red banner", async () => {
  exportEnhancedMock.mockImplementation((id: string) => Promise.resolve({ success: true, path: `/out/${id}` }));
  const { cb, result } = await run(["tx-a", "tx-b"]);
  expect(result.current.bulkActionSuccess).toBe("Successfully exported 2 transactions");
  expect(cb.showError).not.toHaveBeenCalledWith(expect.stringContaining("could not be recorded"));
});
