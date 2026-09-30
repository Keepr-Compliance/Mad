/**
 * BACKLOG-3619 — Control 4: re-sending the same chat creates no duplicates.
 *
 * The fake insert mirrors the real unique index exactly:
 *   UNIQUE (user_id, external_id) WHERE external_id IS NOT NULL
 *   (electron/database/schema.sql:1341), with INSERT OR IGNORE semantics
 *   (electron/services/db/syncDbService.ts batchInsertMessages).
 * The fake link mirrors transactionService.linkMessages' idempotence: one
 * communications row per (message, transaction) (idx_comm_msg_txn).
 */

import {
  importChat,
  mapChatToReactionRows,
  mapChatToRows,
  parseIncomingChat,
  type RcsImportDeps,
  type RcsIncomingChat,
  type RcsInsertRow,
  type RcsReactionRow,
} from "../rcsImportStore";

function makeFakeDb(userId: string) {
  const rows: RcsInsertRow[] = [];
  const reactionRows: RcsReactionRow[] = [];
  const links = new Set<string>();
  // transactions.message_count, as linkMessages bumps it (+1 per NEW link).
  const counts = { messageCount: 0 };
  const linkCalls: string[][] = [];
  const uncountedLinkCalls: string[][] = [];
  const deps: RcsImportDeps = {
    getTransactionUserId: async (txId) => (txId === "tx-1" ? userId : null),
    batchInsertMessages: (batch) => {
      let stored = 0;
      let skipped = 0;
      for (const r of batch) {
        const clash =
          r.externalId !== null &&
          rows.some((e) => e.userId === r.userId && e.externalId === r.externalId);
        if (clash) {
          skipped++;
        } else {
          rows.push(r);
          stored++;
        }
      }
      return { stored, skipped };
    },
    getMessageIdMap: (uid) => {
      const map = new Map<string, string>();
      for (const r of rows) if (r.userId === uid && r.externalId) map.set(r.externalId, r.id);
      for (const r of reactionRows) if (r.userId === uid) map.set(r.externalId, r.id);
      return map;
    },
    linkMessages: async (ids, txId) => {
      linkCalls.push([...ids]);
      for (const id of ids) {
        const key = `${id}|${txId}`;
        if (!links.has(key)) counts.messageCount += 1;
        links.add(key);
      }
    },
    // Same unique index as messages: (user_id, external_id), INSERT OR IGNORE.
    insertReactionRows: (batch) => {
      let stored = 0;
      let skipped = 0;
      for (const r of batch) {
        const clash =
          rows.some((e) => e.userId === r.userId && e.externalId === r.externalId) ||
          reactionRows.some((e) => e.userId === r.userId && e.externalId === r.externalId);
        if (clash) skipped++;
        else {
          reactionRows.push(r);
          stored++;
        }
      }
      return { stored, skipped };
    },
    linkWithoutCount: async (ids, txId) => {
      uncountedLinkCalls.push([...ids]);
      for (const id of ids) links.add(`${id}|${txId}`);
    },
  };
  return { rows, reactionRows, links, counts, linkCalls, uncountedLinkCalls, deps };
}

const CHAT: RcsIncomingChat = {
  conversationId: "aaaaaaaaaaaaaaaaaaa",
  title: "Test Contact A",
  messages: [
    { msgId: "m-1", direction: "inbound", sender: "Test Contact A", text: "one", sentAt: "2026-09-20T13:05:00.000Z", transport: "rcs" },
    { msgId: "m-2", direction: "outbound", sender: "me", text: "two", sentAt: "2026-09-20T13:06:00.000Z", transport: "sms" },
    { msgId: "m-3", direction: "inbound", sender: "Test Contact A", text: "three", sentAt: "2026-09-20T13:07:00.000Z", transport: null },
  ],
};

describe("importChat", () => {
  it("stores every message once and attaches all of them to the transaction", async () => {
    const db = makeFakeDb("user-1");
    const result = await importChat(CHAT, "tx-1", db.deps);
    expect(result).toEqual({ received: 3, stored: 3, alreadyPresent: 0, linked: 3, reactions: 0, reactionsStored: 0 });
    expect(db.rows).toHaveLength(3);
    expect(db.links.size).toBe(3);
  });

  it("re-sending the same chat inserts nothing and links the ORIGINAL rows (msg-id dedup)", async () => {
    const db = makeFakeDb("user-1");
    await importChat(CHAT, "tx-1", db.deps);
    const firstIds = db.rows.map((r) => r.id).sort();

    const again = await importChat(CHAT, "tx-1", db.deps);
    expect(again).toEqual({ received: 3, stored: 0, alreadyPresent: 3, linked: 3, reactions: 0, reactionsStored: 0 });
    expect(db.rows).toHaveLength(3);
    expect(db.rows.map((r) => r.id).sort()).toEqual(firstIds);
    expect(db.links.size).toBe(3);
  });

  it("a chat that grew since the last send adds only the new message", async () => {
    const db = makeFakeDb("user-1");
    await importChat(CHAT, "tx-1", db.deps);
    const grown: RcsIncomingChat = {
      ...CHAT,
      messages: [
        ...CHAT.messages,
        { msgId: "m-4", direction: "outbound", sender: "me", text: "four", sentAt: "2026-09-20T13:08:00.000Z", transport: "rcs" },
      ],
    };
    const result = await importChat(grown, "tx-1", db.deps);
    expect(result.stored).toBe(1);
    expect(db.rows.map((r) => r.externalId).sort()).toEqual([
      "gmweb:aaaaaaaaaaaaaaaaaaa:m-1",
      "gmweb:aaaaaaaaaaaaaaaaaaa:m-2",
      "gmweb:aaaaaaaaaaaaaaaaaaa:m-3",
      "gmweb:aaaaaaaaaaaaaaaaaaa:m-4",
    ]);
  });

  it("the same msg-id in a DIFFERENT conversation is a different message", async () => {
    const db = makeFakeDb("user-1");
    await importChat(CHAT, "tx-1", db.deps);
    const other: RcsIncomingChat = { ...CHAT, conversationId: "bbbbbbbbbbbbbbbbbbb", title: "Test Contact B" };
    const result = await importChat(other, "tx-1", db.deps);
    expect(result.stored).toBe(3);
    expect(db.rows).toHaveLength(6);
  });

  it("refuses an unknown transaction without writing", async () => {
    const db = makeFakeDb("user-1");
    await expect(importChat(CHAT, "tx-missing", db.deps)).rejects.toThrow("Transaction not found");
    expect(db.rows).toHaveLength(0);
  });
});

describe("mapChatToRows", () => {
  it("writes channel sms, the transport and source in metadata, and one thread per chat", () => {
    const rows = mapChatToRows(CHAT, "user-1");
    expect(rows.map((r) => r.channel)).toEqual(["sms", "sms", "sms"]);
    expect(new Set(rows.map((r) => r.threadId))).toEqual(new Set(["gmweb-chat-aaaaaaaaaaaaaaaaaaa"]));
    const metas = rows.map((r) => JSON.parse(r.metadata ?? "{}") as Record<string, unknown>);
    expect(metas[0]).toMatchObject({ source: "google_messages_web", transport: "rcs", msgId: "m-1" });
    expect(metas.map((m) => m.transport)).toEqual(["rcs", "sms", null]);
    expect(JSON.parse(rows[0].participants)).toEqual({ from: "Test Contact A", to: ["me"] });
    expect(JSON.parse(rows[1].participants)).toEqual({ from: "me", to: ["Test Contact A"] });
  });
});

describe("parseIncomingChat", () => {
  it("accepts a well-formed chat", () => {
    expect(parseIncomingChat(CHAT)).toEqual({
      ...CHAT,
      messages: CHAT.messages.map((m) => ({ ...m, images: 0, files: [], reactions: [] })),
    });
  });

  it("accepts an image-only message and refuses a message with nothing in it", () => {
    const imageOnly = { ...CHAT, messages: [{ ...CHAT.messages[0], text: "", images: 1 }] };
    expect(typeof parseIncomingChat(imageOnly)).toBe("object");
    const empty = { ...CHAT, messages: [{ ...CHAT.messages[0], text: "" }] };
    expect(parseIncomingChat(empty)).toBe("message.text is empty and the message has no images or files");
  });

  it.each([
    [null, "Body must be a JSON object"],
    [{ ...CHAT, messages: "x" }, "messages must be an array"],
    [{ ...CHAT, messages: [{ ...CHAT.messages[0], msgId: "" }] }, "message.msgId is required"],
    [{ ...CHAT, messages: [{ ...CHAT.messages[0], sentAt: "nope" }] }, "message.sentAt must be an ISO date"],
    [{ ...CHAT, conversationId: null }, "conversationId is required"],
    [{ ...CHAT, messages: [{ ...CHAT.messages[0], transport: "mms" }] }, "message.transport must be rcs, sms or null"],
  ])("rejects %#", (body, error) => {
    expect(parseIncomingChat(body)).toBe(error);
  });
});

// ---------------------------------------------------------------------------
// BACKLOG-3620: images, files, reactions
// ---------------------------------------------------------------------------

const RICH: RcsIncomingChat = {
  conversationId: "ccccccccccccccccccc",
  title: "Test Contact C",
  messages: [
    {
      msgId: "201", direction: "inbound", sender: "Test Contact C", text: "look at this",
      sentAt: "2026-09-21T10:00:00.000Z", transport: "sms",
      reactions: [
        { emoji: "\u{1F621}", reactor: "Test Contact C", word: "angry" },
        { emoji: "\u2764\uFE0F", reactor: "me", word: "love" },
      ],
    },
    {
      msgId: "202", direction: "inbound", sender: "Test Contact C", text: "",
      sentAt: "2026-09-21T10:01:00.000Z", transport: "sms", images: 1,
      reactions: [{ emoji: "\u{1F622}", reactor: "Test Contact C", word: "sad" }],
    },
    {
      msgId: "203", direction: "outbound", sender: "me", text: "",
      sentAt: "2026-09-21T10:02:00.000Z", transport: "sms",
      files: [{ name: "contract.pdf", size: "1.3 MB" }],
    },
  ],
};

describe("reactions (controls 6 and 7)", () => {
  it("control 7: each reaction row points at its parent's external_id, with the Apple code or 2006", () => {
    const rows = mapChatToRows(RICH, "user-1");
    const reactions = mapChatToReactionRows(RICH, "user-1");
    const parentByMsg = new Map(rows.map((r) => [JSON.parse(r.metadata ?? "{}").msgId as string, r.externalId]));
    expect(reactions.map((r) => r.associatedMessageGuid)).toEqual([
      parentByMsg.get("201"),
      parentByMsg.get("201"),
      parentByMsg.get("202"),
    ]);
    expect(reactions[0].associatedMessageGuid).toBe("gmweb:ccccccccccccccccccc:201");
    // angry -> other (2006); heart WITH a variation selector -> Apple heart (2000); sad -> 2006
    expect(reactions.map((r) => r.associatedMessageType)).toEqual([2006, 2000, 2006]);
    // the stored emoji is what the pill renders
    expect(reactions.map((r) => r.bodyText)).toEqual(["\u{1F621}", "\u2764", "\u{1F622}"]);
    expect(reactions.map((r) => r.direction)).toEqual(["inbound", "outbound", "inbound"]);
    expect(JSON.parse(reactions[1].participants)).toEqual({ from: "me", to: ["Test Contact C"] });
    expect(reactions[0].sentAt).toBe("2026-09-21T10:00:00.000Z");
  });

  it("control 6: reactions are linked but never counted in message_count", async () => {
    const db = makeFakeDb("user-1");
    const result = await importChat(RICH, "tx-1", db.deps);
    expect(result).toMatchObject({ received: 3, stored: 3, linked: 3, reactions: 3, reactionsStored: 3 });
    // N messages -> +N, whatever R is
    expect(db.counts.messageCount).toBe(3);
    const reactionIds = new Set(db.reactionRows.map((r) => r.id));
    expect(db.linkCalls.flat().filter((id) => reactionIds.has(id))).toEqual([]);
    expect(new Set(db.uncountedLinkCalls.flat())).toEqual(reactionIds);
    // every row, reaction or not, is attached to the transaction
    expect(db.links.size).toBe(6);
  });

  it("re-sending a chat with reactions adds no reaction rows", async () => {
    const db = makeFakeDb("user-1");
    await importChat(RICH, "tx-1", db.deps);
    const again = await importChat(RICH, "tx-1", db.deps);
    expect(again.reactionsStored).toBe(0);
    expect(db.reactionRows).toHaveLength(3);
    expect(db.counts.messageCount).toBe(3);
  });
});

describe("image-only and file-only messages", () => {
  it("keeps an image-only message as attachment_only with has_attachments set", () => {
    const rows = mapChatToRows(RICH, "user-1");
    const img = rows[1];
    expect(img.messageType).toBe("attachment_only");
    expect(img.hasAttachments).toBe(1);
    expect(img.bodyText).toBeNull();
    expect(JSON.parse(img.metadata ?? "{}")).toMatchObject({ images: 1 });
  });

  it("records a file it does not import by name and size only", () => {
    const rows = mapChatToRows(RICH, "user-1");
    const file = rows[2];
    expect(file.messageType).toBe("attachment_only");
    expect(file.hasAttachments).toBe(0);
    expect(file.bodyText).toBe("[File not imported: contract.pdf (1.3 MB)]");
    expect(JSON.parse(file.metadata ?? "{}")).toMatchObject({
      filesNotImported: [{ name: "contract.pdf", size: "1.3 MB" }],
    });
  });
});
