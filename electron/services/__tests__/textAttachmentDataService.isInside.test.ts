/**
 * @jest-environment node
 */
/** BACKLOG-3763 — containment rule for attachment paths. */
jest.mock("electron", () => ({ app: { getPath: () => "/unused" } }));
jest.mock("../databaseService", () => ({ __esModule: true, default: {} }));
jest.mock("../sessionService", () => ({ __esModule: true, default: {} }));
jest.mock("../logService", () => ({ __esModule: true, default: {} }));

import path from "path";
import { isInside } from "../textAttachmentDataService";

const S = path.sep;
const root = `${S}data${S}keepr`;

describe("isInside", () => {
  it("accepts a nested file", () => {
    expect(isInside(root, `${root}${S}a${S}b.jpg`, false)).toBe(true);
  });
  it("rejects the root itself", () => {
    expect(isInside(root, root, false)).toBe(false);
  });
  it("tolerates a trailing separator on the root", () => {
    expect(isInside(`${root}${S}`, `${root}${S}x.jpg`, false)).toBe(true);
  });
  it("rejects a near-miss sibling folder sharing the prefix", () => {
    expect(isInside(root, `${S}data${S}keepr-dev${S}x.jpg`, false)).toBe(false);
  });
  it("rejects a case-different path when case-sensitive", () => {
    expect(isInside(root, `${S}data${S}KEEPR${S}x.jpg`, false)).toBe(false);
  });
  it("accepts a case-different path when case-insensitive (Windows)", () => {
    expect(isInside(root, `${S}DATA${S}Keepr${S}x.jpg`, true)).toBe(true);
  });
  it("defaults to case-insensitive only on win32", () => {
    expect(isInside(root, `${S}data${S}KEEPR${S}x.jpg`)).toBe(process.platform === "win32");
  });
});
