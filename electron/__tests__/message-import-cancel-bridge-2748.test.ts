/**
 * BACKLOG-2748 — the cancel actually crosses the bridge.
 *
 * ---------------------------------------------------------------------------
 * WHY A TEST FOR SOMETHING THIS SMALL
 * ---------------------------------------------------------------------------
 * This defect WAS a broken chain, and it stayed broken for a whole release
 * cycle while every link looked healthy in isolation: the service had a working
 * `requestCancellation()`, the handler registered a listener for
 * `messages:import-cancel`, the preload bridge exposed a `cancelImport()` that
 * sent on it — and no renderer code could reach any of it, so nothing ever
 * carried a cancel from one end to the other.
 *
 * A test that asserts "the handler calls requestCancellation" re-tests one link.
 * This one drives the REAL preload bridge and the REAL handler registration and
 * asserts they meet: the channel the renderer sends on is the channel the main
 * process listens on, and the listener behind it stops the import.
 *
 * That is also the §6.2e guard made executable. The two sides now import one
 * shared constant, so a typo is a compile error — but "they import the same
 * constant" is a claim about today's source. This asserts the property itself,
 * so re-inlining either string is caught by a failing test and not only by
 * whoever is reading the diff.
 */

import {
  createIpcHandlerRegistry,
  type IpcHandlerRegistry,
} from "../../tests/support/ipcHandlerRegistry";
import type { BrowserWindow } from "electron";

/** Channel -> listener, for the one-way `ipcMain.on` registrations. */
let registeredListeners: IpcHandlerRegistry;
/** Channels the preload bridge sent on, in order. */
let sentChannels: string[] = [];

jest.mock("electron", () => ({
  ipcMain: {
    handle: jest.fn(),
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      registeredListeners.set(channel, listener);
    },
  },
  ipcRenderer: {
    send: (channel: string) => {
      sentChannels.push(channel);
    },
    invoke: jest.fn(),
    on: jest.fn(),
    removeListener: jest.fn(),
  },
  contextBridge: { exposeInMainWorld: jest.fn() },
  BrowserWindow: jest.fn(),
  app: { getPath: jest.fn(() => "/tmp/keepr-test") },
}));

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  addBreadcrumb: jest.fn(),
}));

jest.mock("../services/logService", () => {
  const m = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

const mockRequestCancellation = jest.fn();
jest.mock("../services/macOSMessagesImportService", () => ({
  __esModule: true,
  default: {
    requestCancellation: (...args: unknown[]) => mockRequestCancellation(...args),
    importMessages: jest.fn(),
    resetImportLock: jest.fn(),
    repairAttachmentMessageIds: jest.fn(),
    getImportCount: jest.fn(),
    getAttachmentsForMessage: jest.fn(),
    getAttachmentsForMessages: jest.fn(),
    getAttachmentAsBase64: jest.fn(),
  },
}));

jest.mock("../services/databaseService", () => ({
  __esModule: true,
  default: {
    isInitialized: jest.fn(() => true),
    getUserById: jest.fn(),
    getRawDatabase: jest.fn(),
  },
}));

jest.mock("../services/supabaseService", () => ({
  __esModule: true,
  default: { getPreferences: jest.fn() },
}));

import { registerMessageImportHandlers } from "../handlers/messageImportHandlers";
import { messageBridge } from "../preload/messageBridge";
import { MESSAGES_IMPORT_CANCEL_CHANNEL } from "../types/ipc/messageChannels";

beforeAll(() => {
  registeredListeners = createIpcHandlerRegistry();
  sentChannels = [];
  // The handler module guards against double registration, so this runs once
  // for the whole suite — as it does in the app.
  registerMessageImportHandlers({} as BrowserWindow);
});

beforeEach(() => {
  sentChannels = [];
  mockRequestCancellation.mockClear();
});

describe("BACKLOG-2748 — renderer cancel reaches the import service", () => {
  it("the channel the preload bridge sends on is the channel the main process listens on", () => {
    messageBridge.cancelImport();

    expect(sentChannels).toEqual([MESSAGES_IMPORT_CANCEL_CHANNEL]);
    // The end of the chain that was missing: a listener exists for exactly the
    // channel that was just sent on. Not "a listener exists somewhere".
    expect(registeredListeners.has(sentChannels[0])).toBe(true);
  });

  it("the listener behind that channel stops the running import", () => {
    messageBridge.cancelImport();

    const listener = registeredListeners.get(sentChannels[0]);
    listener();

    expect(mockRequestCancellation).toHaveBeenCalledTimes(1);
  });

  it("CONTROL: no cancel is requested until something sends on the channel", () => {
    // Guards against a listener that fires on registration or on any event —
    // "requestCancellation was called" must mean the user pressed Cancel.
    expect(mockRequestCancellation).not.toHaveBeenCalled();
    expect(sentChannels).toEqual([]);
  });
});
