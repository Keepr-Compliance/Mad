/**
 * BACKLOG-2210 — desktop message store is deviceId-INDEPENDENT.
 *
 * The fix changes a phone's `deviceId` from a name-derived value to a
 * desktop-minted UUID. We must prove that changing the deviceId does NOT
 * duplicate (or lose) message rows on the desktop: the dedup key is a SHA-256
 * of `sender|timestamp|body` (generateExternalId), and deviceId is carried only
 * in metadata. So the SAME message synced under two different deviceIds hashes
 * to the SAME external_id — the desktop's content dedup absorbs the re-send with
 * zero duplicate rows. This is what lets a phone re-sync cleanly after adopting
 * a new identity (no message-queue reset required).
 */

// Keep localSyncService importable under jest without touching the network.
jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: { getClient: () => ({ auth: { getUser: jest.fn() } }) },
}));

// Capture every message batch handed to the DB layer.
// The declared row shape covers only the two columns this suite reads back.
const batchInsertMessages = jest.fn(
  (rows: Array<{ externalId: string; metadata: string }>, _chunk?: number) => ({
    stored: rows.length,
    skipped: 0,
  })
);
jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    batchInsertMessages: (rows: unknown, chunk?: number) =>
      batchInsertMessages(
        rows as Array<{ externalId: string; metadata: string }>,
        chunk
      ),
  },
}));

import localSyncService from "../localSyncService";
import type { SyncMessage } from "../../types/localSync";

/** Access the private storeMessages, bound to the singleton (uses `this`). */
type StoreMessages = (
  userId: string,
  deviceId: string,
  messages: SyncMessage[]
) => number;
const storeMessages = (
  localSyncService as unknown as { storeMessages: StoreMessages }
).storeMessages.bind(localSyncService);

const USER = "user-1";
const MESSAGE: SyncMessage = {
  sender: "+15555550112",
  body: "hello world",
  timestamp: 1_700_000_000_000,
  direction: "inbound",
};

beforeEach(() => jest.clearAllMocks());

describe("storeMessages — external_id independent of deviceId (BACKLOG-2210)", () => {
  function externalIdFor(deviceId: string): string {
    batchInsertMessages.mockClear();
    storeMessages(USER, deviceId, [MESSAGE]);
    const rows = batchInsertMessages.mock.calls[0][0];
    return rows[0].externalId;
  }

  it("hashes the SAME message to the SAME external_id under two different ids", () => {
    const idUnderName = externalIdFor("MacBook Pro"); // legacy name-derived id
    const idUnderUuid = externalIdFor("11111111-2222-3333-4444-555555555555"); // minted UUID

    // Same content → same dedup key regardless of deviceId, so the desktop
    // content-dedup treats the post-migration re-send as a no-op (no dup rows).
    expect(idUnderName).toBe(idUnderUuid);
    expect(idUnderName).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });

  it("carries the deviceId only in metadata (not in the dedup identity)", () => {
    storeMessages(USER, "11111111-2222-3333-4444-555555555555", [MESSAGE]);
    const row = batchInsertMessages.mock.calls[0][0][0] as {
      metadata: string;
    };
    expect(JSON.parse(row.metadata).deviceId).toBe(
      "11111111-2222-3333-4444-555555555555"
    );
  });
});
