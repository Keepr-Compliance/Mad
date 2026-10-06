/**
 * Live (founder): the Downloads copy of the extension is refreshed at app
 * start, only while the extension is not in the Chrome Web Store.
 * Mutations: never called; called for a store install → red.
 */
import { renderHook } from "@testing-library/react";

const mockRefresh = jest.fn();
jest.mock("../../services/rcsImportService", () => ({
  rcsImportService: { refreshExtensionFolder: (...a: unknown[]) => mockRefresh(...a) },
}));

import { useExtensionFolderRefresh } from "../useExtensionFolderRefresh";

beforeEach(() => mockRefresh.mockReset().mockResolvedValue({ refreshed: false }));

describe("useExtensionFolderRefresh", () => {
  it("unpacked install (not published): asks once at start", () => {
    const { rerender } = renderHook(() => useExtensionFolderRefresh(false));
    rerender();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("a store install: never", () => {
    renderHook(() => useExtensionFolderRefresh(true));
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
