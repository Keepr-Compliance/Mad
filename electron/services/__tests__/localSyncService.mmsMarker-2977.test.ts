/**
 * BACKLOG-2977 — nullable body, the identity fold, and the attachment marker.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE IS FOR
 * ---------------------------------------------------------------------------
 * An MMS photo with no caption is a real message with no text. Before this
 * item `SyncMessage.body` was a required string, so the only way to carry such
 * a message was to invent one — and the desktop's dedup key is
 * `SHA-256(sender|timestamp|body)`, so `""` makes two caption-less photos from
 * one person in the same millisecond hash IDENTICALLY. The second is dropped as
 * a duplicate that never existed, and an audit is silently short a message.
 *
 * The founder ruling (2026-09-02) was: make `body` nullable, and when there is
 * no body hash the message's OWN identity (`smsId`, namespaced `mms:<_id>`)
 * rather than inventing content. "The collision is the control."
 *
 * ---------------------------------------------------------------------------
 * THE MUTATIONS THAT MAKE EACH TEST RED
 * ---------------------------------------------------------------------------
 * Re-run these at adoption; a control nobody has seen fail proves nothing.
 *
 *   (a) collision           fold back to `""`  ->  both hash 56e46822…, the SET
 *                           assertion drops to one element
 *   (b) pre-change hash     apply the fold to non-null bodies too
 *   (d) legacy metadata     emit `bodyAbsence` unconditionally
 *   (e) absence kinds       collapse "unreadable" and "no_text_part" to one value
 *   (g) skip                fold `""` instead of skipping
 *   (h) empty string        treat `""` as absent (`!msg.body`)
 *   (i) captioned photo     derive hasAttachments from `body === null`
 *
 * The two remaining controls — attachment LINKAGE and the write-failure path —
 * need a real database and live in `localSyncService.mmsAttachmentLink-2977`.
 *
 * ---------------------------------------------------------------------------
 * THE HASH LITERALS ARE TRANSCRIBED, NOT INVENTED
 * ---------------------------------------------------------------------------
 * Every SHA-256 below was computed from the UNMODIFIED `generateExternalId` at
 * `52d4dfedd`, before any edit in this branch existed:
 *
 *   node -e 'const c=require("crypto");const h=(s,t,b)=>c.createHash("sha256")
 *     .update(`${s}|${t}|${b}`).digest("hex");console.log(h(...))'
 *
 * That matters most for BODIED_HASH: if it ever moves, every already-synced
 * message on every paired desktop re-hashes into a fresh duplicate.
 */

// Keep localSyncService importable under jest without touching the network.
jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: { getClient: () => ({ auth: { getUser: jest.fn() } }) },
}));

type InsertedRow = {
  id: string;
  externalId: string;
  bodyText: string | null;
  hasAttachments: number;
  messageType: string | null;
  metadata: string;
};

const batchInsertMessages = jest.fn((rows: InsertedRow[], _chunk?: number) => ({
  stored: rows.length,
  skipped: 0,
}));

/** Every attachment row the code under test tried to write. */
const insertAttachment = jest.fn();
/** Pairs already in the `attachments` table. Empty unless a test seeds it. */
let existingAttachmentRecords = new Set<string>();

/**
 * A caption-less photo necessarily carries `attachmentContentTypes`, which trips
 * the attachment gate — so this mock needs the three attachment helpers as well
 * as `batchInsertMessages`. Without them the first run would red on a missing
 * mock rather than on the behaviour under test.
 */
jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    batchInsertMessages: (rows: unknown, chunk?: number) =>
      batchInsertMessages(rows as InsertedRow[], chunk),
    // Resolve every external_id the batch just carried to a deterministic id, so
    // the marker path can run without a database.
    getMessageIdMap: () => {
      const map = new Map<string, string>();
      for (const call of batchInsertMessages.mock.calls) {
        for (const row of call[0]) map.set(row.externalId, `msg-for-${row.externalId.slice(0, 8)}`);
      }
      return map;
    },
    getExistingAttachmentRecords: () => existingAttachmentRecords,
    insertAttachment: (params: unknown) => insertAttachment(params),
  },
}));

import localSyncService from "../localSyncService";
import type { SyncMessage } from "../../types/localSync";

type StoreMessages = (
  userId: string,
  deviceId: string,
  messages: SyncMessage[]
) => { stored: number; attachmentsFailed: number; skippedMessages: number };

/** Access the private storeMessages, bound to the singleton (uses `this`). */
const storeMessages = (
  localSyncService as unknown as { storeMessages: StoreMessages }
).storeMessages.bind(localSyncService);

const USER = "user-2977";
// An invented, fixed device id so the metadata string in control (d) can be
// asserted literally. Same value as localSyncService.deviceUuid.test.ts, which
// is what makes (d) a real byte-for-byte comparison against today's behaviour.
const DEVICE = "11111111-2222-3333-4444-555555555555"; // pii-allow-uuid: invented, not from any live row

/** Reserved-range numbers only (+1 <area> 555-01xx). */
const BROKER_CONTACT = "+12065550101";
const LEGACY_SENDER = "+15555550112";

/** Two caption-less photos, same sender, same millisecond. */
const SAME_MS = 1_757_000_000_000;

const BODIED_HASH = "c672e6ce5d65459728ef7036a51bd52889128eda6743d2c4a732a82f95a0cb0f";
const PHOTO_41_HASH = "11585deee46bd30b154446f13cf39490bc6ca18a7b619b8915bc5958dbaf9dd5";
const PHOTO_42_HASH = "ce61c56f53a9d5e5be97385796a546d65a557b5124b6f18572cbd7b21d32d2ce";
/** What BOTH photos hash to if the body is folded to `""` — the defect. */
const COLLIDED_HASH = "56e46822639c298c6e31350b0b4c949abf78fba57a717a4649bc3671e7e002b0";

function captionlessPhoto(smsId: string): SyncMessage {
  return {
    sender: BROKER_CONTACT,
    body: null,
    timestamp: SAME_MS,
    direction: "inbound",
    smsId,
    attachmentContentTypes: ["image/jpeg"],
    bodyAbsence: "no_text_part",
  };
}

/** Rows from the most recent batchInsertMessages call. */
function lastRows(): InsertedRow[] {
  const calls = batchInsertMessages.mock.calls;
  return calls[calls.length - 1][0];
}

beforeEach(() => {
  jest.clearAllMocks();
  existingAttachmentRecords = new Set<string>();
});

describe("(a) the collision is the control — two caption-less photos survive", () => {
  it("gives two caption-less photos from one sender in one millisecond TWO external_ids", () => {
    const result = storeMessages(USER, DEVICE, [
      captionlessPhoto("mms:41"),
      captionlessPhoto("mms:42"),
    ]);

    // A SET, never a count: a duplicate and a miss cancel out in a count, which
    // is precisely the failure this item exists to prevent.
    const ids = new Set(lastRows().map((r) => r.externalId));
    expect(ids).toEqual(new Set([PHOTO_41_HASH, PHOTO_42_HASH]));
    expect(ids.size).toBe(2);
    expect(ids.has(COLLIDED_HASH)).toBe(false);
    expect(result.stored).toBe(2);
  });

  it("stores the absence as an absence — body_text is NULL, never a marker string", () => {
    storeMessages(USER, DEVICE, [captionlessPhoto("mms:41")]);

    const row = lastRows()[0];
    // The founder rejected "[no text]" because a reader cannot tell fabricated
    // text from something the sender typed, in the UI, in exports, and in an
    // audit package handed to a brokerage or a court.
    expect(row.bodyText).toBeNull();
    expect(row.messageType).toBe("attachment_only");
    expect(row.hasAttachments).toBe(1);
  });
});

describe("(b) a message WITH a body hashes exactly as it did before this item", () => {
  it("reproduces the pre-change SHA-256 byte for byte", () => {
    storeMessages(USER, DEVICE, [
      {
        sender: LEGACY_SENDER,
        body: "hello world",
        timestamp: 1_700_000_000_000,
        direction: "inbound",
      },
    ]);

    // Moving this value re-duplicates every already-synced message on every
    // paired desktop. localSyncService.deviceUuid.test.ts uses the identical
    // sender/timestamp/body, so this literal has a live cross-check.
    expect(lastRows()[0].externalId).toBe(BODIED_HASH);
  });

  it("ignores smsId entirely when a body is present", () => {
    storeMessages(USER, DEVICE, [
      {
        sender: LEGACY_SENDER,
        body: "hello world",
        timestamp: 1_700_000_000_000,
        direction: "inbound",
        smsId: "mms:999",
      },
    ]);

    expect(lastRows()[0].externalId).toBe(BODIED_HASH);
  });
});

describe("(d) an older companion's message stores byte-identically", () => {
  it("writes the exact metadata string today's code writes", () => {
    storeMessages(USER, DEVICE, [
      {
        sender: LEGACY_SENDER,
        body: "hello world",
        timestamp: 1_700_000_000_000,
        direction: "inbound",
      },
    ]);

    const row = lastRows()[0];
    expect(row.externalId).toBe(BODIED_HASH);
    expect(row.bodyText).toBe("hello world");
    expect(row.hasAttachments).toBe(0);
    expect(row.messageType).toBe("text");

    // `toBe` on the whole string, NOT toMatchObject: an extra key must red this.
    // That is what forces `bodyAbsence` to be spread conditionally instead of
    // emitted as null on every message.
    expect(row.metadata).toBe(
      `{"source":"android_wifi_sync","deviceId":"${DEVICE}","androidThreadId":null,"originalSender":"${LEGACY_SENDER}"}`
    );
  });

  it("writes no attachment row and never reads the attachment tables", () => {
    storeMessages(USER, DEVICE, [
      {
        sender: LEGACY_SENDER,
        body: "hello world",
        timestamp: 1_700_000_000_000,
        direction: "inbound",
      },
    ]);

    // The gate matters for cost as well as correctness: getMessageIdMap loads
    // every message for the user and getExistingAttachmentRecords scans the
    // whole attachments table, on every sync batch.
    expect(insertAttachment).not.toHaveBeenCalled();
  });
});

describe("(e) 'no caption' and 'could not read it' stay distinguishable", () => {
  it("stores both as NULL body_text but records WHICH absence in metadata", () => {
    storeMessages(USER, DEVICE, [
      { ...captionlessPhoto("mms:41"), bodyAbsence: "no_text_part" },
      {
        sender: BROKER_CONTACT,
        body: null,
        timestamp: SAME_MS + 1,
        direction: "inbound",
        smsId: "mms:43",
        bodyAbsence: "unreadable",
      },
    ]);

    const rows = lastRows();
    // Both are an absence in the column the audit reads...
    expect(rows.map((r) => r.bodyText)).toEqual([null, null]);
    // ...but "the sender wrote no caption" and "the sender wrote something we
    // could not read" are different facts, and the second is a READ FAILURE
    // that must never be reported as an empty message.
    expect(rows.map((r) => JSON.parse(r.metadata).bodyAbsence)).toEqual([
      "no_text_part",
      "unreadable",
    ]);
  });
});

describe("(g) a message with nothing safe to hash is skipped, not folded", () => {
  it("does not store it, and does not report it as a duplicate", () => {
    const result = storeMessages(USER, DEVICE, [
      { sender: BROKER_CONTACT, body: null, timestamp: SAME_MS, direction: "inbound" },
      {
        sender: LEGACY_SENDER,
        body: "hello world",
        timestamp: 1_700_000_000_000,
        direction: "inbound",
      },
    ]);

    // Folding "" here would store it under a hash shared with every other
    // body-less message from this sender in this millisecond.
    expect(lastRows()).toHaveLength(1);
    expect(lastRows()[0].externalId).toBe(BODIED_HASH);
    // The count the caller's log subtracts, so an unhashable message is not
    // reported to the operator as a duplicate — it was never stored at all.
    expect(result.skippedMessages).toBe(1);
    expect(result.stored).toBe(1);
  });

  it("keeps a skipped message out of the attachment path entirely", () => {
    storeMessages(USER, DEVICE, [
      {
        sender: BROKER_CONTACT,
        body: null,
        timestamp: SAME_MS,
        direction: "inbound",
        attachmentContentTypes: ["image/jpeg"],
      },
    ]);

    // It has no external_id to key on and no message row to hang a marker off.
    expect(insertAttachment).not.toHaveBeenCalled();
  });
});

describe("(h) an empty body is an observation, not an absence", () => {
  it("stores \"\" as \"\" and hashes it as it always has", () => {
    storeMessages(USER, DEVICE, [
      {
        sender: BROKER_CONTACT,
        body: "",
        timestamp: SAME_MS,
        direction: "inbound",
        smsId: "mms:41",
      },
    ]);

    const row = lastRows()[0];
    // The provider said the text is empty. That is something we observed, not
    // something missing — so it must not become NULL and must not acquire a
    // bodyAbsence key.
    expect(row.bodyText).toBe("");
    expect(row.externalId).toBe(COLLIDED_HASH);
    expect(JSON.parse(row.metadata).bodyAbsence).toBeUndefined();
    expect(row.messageType).toBe("text");
  });
});

describe("(i) a photo WITH a caption keeps its caption and its marker", () => {
  it("records both the text and the attachment", () => {
    storeMessages(USER, DEVICE, [
      {
        sender: BROKER_CONTACT,
        body: "here is the roof damage",
        timestamp: SAME_MS,
        direction: "inbound",
        smsId: "mms:44",
        attachmentContentTypes: ["image/jpeg"],
      },
    ]);

    const row = lastRows()[0];
    expect(row.bodyText).toBe("here is the roof damage");
    expect(row.hasAttachments).toBe(1);
    // Not attachment_only: the sender wrote something, so the message is text
    // that happens to carry an attachment.
    expect(row.messageType).toBe("text");
    expect(insertAttachment).toHaveBeenCalledTimes(1);
    expect(insertAttachment.mock.calls[0][0]).toMatchObject({
      mimeType: "image/jpeg",
      storagePath: null,
      fileSizeBytes: null,
    });
  });
});

describe("attachment marker filenames are order-free", () => {
  it("names the same slots regardless of the order the phone listed them in", () => {
    const forward: SyncMessage = {
      sender: BROKER_CONTACT,
      body: null,
      timestamp: SAME_MS,
      direction: "inbound",
      smsId: "mms:45",
      attachmentContentTypes: ["image/jpeg", "image/png"],
    };
    storeMessages(USER, DEVICE, [forward]);
    const forwardNames = insertAttachment.mock.calls.map(
      (c) => (c[0] as { filename: string }).filename
    );

    insertAttachment.mockClear();
    existingAttachmentRecords = new Set<string>();
    storeMessages(USER, DEVICE, [
      { ...forward, attachmentContentTypes: ["image/png", "image/jpeg"] },
    ]);
    const reversedNames = insertAttachment.mock.calls.map(
      (c) => (c[0] as { filename: string }).filename
    );

    // The phone builds this list unsorted, so an index into it would rename a
    // row between syncs and slip past the duplicate guard.
    expect(forwardNames).toEqual(["mms-part-0.jpeg", "mms-part-1.png"]);
    expect(reversedNames).toEqual(forwardNames);
  });

  it("falls back to .bin for a content type with no usable subtype", () => {
    storeMessages(USER, DEVICE, [
      {
        sender: BROKER_CONTACT,
        body: null,
        timestamp: SAME_MS,
        direction: "inbound",
        smsId: "mms:46",
        attachmentContentTypes: ["application"],
      },
    ]);

    expect((insertAttachment.mock.calls[0][0] as { filename: string }).filename).toBe(
      "mms-part-0.bin"
    );
  });
});
