/**
 * Guard test: transactionHandlers registrar wires ALL sub-handlers.
 *
 * Purpose: Catch the "wrote but never wired" bug that caused BACKLOG-1866
 * (transactionSearchHandlers.ts existed but registerTransactionSearchHandlers
 * was never called from the startup chain).
 *
 * This test mocks every leaf registrar and asserts that
 * registerTransactionHandlers() delegates to each of them so the same
 * omission cannot recur silently.
 */

jest.mock("../transactionCrudHandlers", () => ({
  registerTransactionCrudHandlers: jest.fn(),
}));
jest.mock("../transactionExportHandlers", () => ({
  registerTransactionExportHandlers: jest.fn(),
  cleanupTransactionHandlers: jest.fn(),
}));
jest.mock("../emailSyncHandlers", () => ({
  registerEmailSyncHandlers: jest.fn(),
}));
jest.mock("../emailLinkingHandlers", () => ({
  registerEmailLinkingHandlers: jest.fn(),
}));
jest.mock("../emailAutoLinkHandlers", () => ({
  registerEmailAutoLinkHandlers: jest.fn(),
}));
jest.mock("../attachmentHandlers", () => ({
  registerAttachmentHandlers: jest.fn(),
}));
jest.mock("../transactionSearchHandlers", () => ({
  registerTransactionSearchHandlers: jest.fn(),
}));

import { registerTransactionHandlers } from "../transactionHandlers";
import { registerTransactionCrudHandlers } from "../transactionCrudHandlers";
import { registerTransactionExportHandlers } from "../transactionExportHandlers";
import { registerEmailSyncHandlers } from "../emailSyncHandlers";
import { registerEmailLinkingHandlers } from "../emailLinkingHandlers";
import { registerEmailAutoLinkHandlers } from "../emailAutoLinkHandlers";
import { registerAttachmentHandlers } from "../attachmentHandlers";
import { registerTransactionSearchHandlers } from "../transactionSearchHandlers";

describe("registerTransactionHandlers (guard: all sub-handlers wired)", () => {
  const mockWindow = {} as Electron.BrowserWindow;

  beforeEach(() => {
    jest.clearAllMocks();
    registerTransactionHandlers(mockWindow);
  });

  it("calls registerTransactionCrudHandlers", () => {
    expect(registerTransactionCrudHandlers).toHaveBeenCalledWith(mockWindow);
  });

  it("calls registerTransactionExportHandlers", () => {
    expect(registerTransactionExportHandlers).toHaveBeenCalledWith(mockWindow);
  });

  it("calls registerEmailSyncHandlers", () => {
    expect(registerEmailSyncHandlers).toHaveBeenCalledWith(mockWindow);
  });

  it("calls registerEmailLinkingHandlers", () => {
    expect(registerEmailLinkingHandlers).toHaveBeenCalled();
  });

  it("calls registerEmailAutoLinkHandlers", () => {
    expect(registerEmailAutoLinkHandlers).toHaveBeenCalled();
  });

  it("calls registerAttachmentHandlers", () => {
    expect(registerAttachmentHandlers).toHaveBeenCalledWith(mockWindow);
  });

  it("calls registerTransactionSearchHandlers — the BACKLOG-1866 guard", () => {
    expect(registerTransactionSearchHandlers).toHaveBeenCalled();
  });
});
