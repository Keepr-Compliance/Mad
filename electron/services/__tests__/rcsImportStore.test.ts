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
  importCacheChat,
  mapChatToReactionRows,
  mapChatToRows,
  parseIncomingChat,
  parseReplyTo,
  RCS_REPLY_SNIPPET_MAX,
  peopleFrom,
  rcsChatHash,
  samePeople,
  type RcsChatPeople,
  type RcsImportDeps,
  type RcsIncomingChat,
  type RcsInsertRow,
  type RcsReactionRow,
} from "../rcsImportStore";
import { getContactMergeKey } from "../../../src/utils/threadMergeUtils";

function makeFakeDb(userId: string) {
  const rows: RcsInsertRow[] = [];
  const reactionRows: RcsReactionRow[] = [];
  void userId;
  const deps: RcsImportDeps = {
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
  };
  return { rows, reactionRows, deps };
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

// BACKLOG-3630: the chat's Details numbers (invented, 555-01xx).
const NUM_A = "+15555550199";
const NUM_B = "+15555550142";
const PEOPLE: RcsChatPeople = { numbers: [NUM_A], names: [{ name: "Test Contact A", number: NUM_A }] };
const PEOPLE_B: RcsChatPeople = { numbers: [NUM_B], names: [{ name: "Test Contact B", number: NUM_B }] };
const H = rcsChatHash([NUM_A]);

// Founder (2026-10-05): the per-transaction Sync (importChat: link to a
// transaction, honour its removals) was removed; a chat is stored by the
// cache path only (importCacheChat), linked later by the phone auto-link.
describe("storing a chat (importCacheChat)", () => {
  it("stores every message once and links nothing", async () => {
    const db = makeFakeDb("user-1");
    const result = await importCacheChat(CHAT, "user-1", db.deps, PEOPLE);
    expect(result).toEqual({ received: 3, stored: 3, alreadyPresent: 0, linked: 0, reactions: 0, reactionsStored: 0, removedByUser: 0, sameContent: 0 });
    expect(db.rows).toHaveLength(3);
  });

  it("re-sending the same chat inserts nothing (msg-id dedup)", async () => {
    const db = makeFakeDb("user-1");
    await importCacheChat(CHAT, "user-1", db.deps, PEOPLE);
    const firstIds = db.rows.map((r) => r.id).sort();
    const again = await importCacheChat(CHAT, "user-1", db.deps, PEOPLE);
    expect(again).toMatchObject({ received: 3, stored: 0, alreadyPresent: 3 });
    expect(db.rows.map((r) => r.id).sort()).toEqual(firstIds);
  });

  it("a chat that grew since the last send adds only the new message", async () => {
    const db = makeFakeDb("user-1");
    await importCacheChat(CHAT, "user-1", db.deps, PEOPLE);
    const grown: RcsIncomingChat = {
      ...CHAT,
      messages: [
        ...CHAT.messages,
        { msgId: "m-4", direction: "outbound", sender: "me", text: "four", sentAt: "2026-09-20T13:08:00.000Z", transport: "rcs" },
      ],
    };
    const result = await importCacheChat(grown, "user-1", db.deps, PEOPLE);
    expect(result.stored).toBe(1);
    expect(db.rows.map((r) => r.externalId).sort()).toEqual([
      `gmweb2:${H}:m-1`,
      `gmweb2:${H}:m-2`,
      `gmweb2:${H}:m-3`,
      `gmweb2:${H}:m-4`,
    ]);
  });

  it("the same msg-id in a chat with DIFFERENT participants is a different message", async () => {
    const db = makeFakeDb("user-1");
    await importCacheChat(CHAT, "user-1", db.deps, PEOPLE);
    const other: RcsIncomingChat = { ...CHAT, conversationId: "bbbbbbbbbbbbbbbbbbb", title: "Test Contact B" };
    const result = await importCacheChat(other, "user-1", db.deps, PEOPLE_B);
    expect(result.stored).toBe(3);
    expect(db.rows).toHaveLength(6);
  });

  // BACKLOG-3630. Mutation: put the URL conversation id back into the key → red.
  it("a re-pair (NEW conversation id, same participants) stores nothing new", async () => {
    const db = makeFakeDb("user-1");
    await importCacheChat(CHAT, "user-1", db.deps, PEOPLE);
    const firstIds = db.rows.map((r) => r.id).sort();
    const repaired: RcsIncomingChat = { ...CHAT, conversationId: "CgiRepairedConversation" };
    const result = await importCacheChat(repaired, "user-1", db.deps, PEOPLE);
    expect(result.stored).toBe(0);
    expect(db.rows.map((r) => r.id).sort()).toEqual(firstIds);
    expect(new Set(db.rows.map((r) => r.threadId))).toEqual(new Set([`gmweb2-${H}`]));
  });
});

describe("mapChatToRows", () => {
  it("writes channel sms, the transport and source in metadata, and one thread per chat", () => {
    const rows = mapChatToRows(CHAT, "user-1", PEOPLE);
    expect(rows.map((r) => r.channel)).toEqual(["sms", "sms", "sms"]);
    expect(new Set(rows.map((r) => r.threadId))).toEqual(new Set([`gmweb2-${H}`]));
    const metas = rows.map((r) => JSON.parse(r.metadata ?? "{}") as Record<string, unknown>);
    expect(metas[0]).toMatchObject({ source: "google_messages_web", transport: "rcs", msgId: "m-1" });
    expect(metas.map((m) => m.transport)).toEqual(["rcs", "sms", null]);
    // BACKLOG-3630: numbers, as the Android path stores them, so auto-link matches.
    expect(JSON.parse(rows[0].participants)).toEqual({ from: NUM_A, to: ["me"] });
    expect(JSON.parse(rows[1].participants)).toEqual({ from: "me", to: [NUM_A] });
    expect(rows.map((r) => r.participantsFlat)).toEqual([NUM_A, NUM_A, NUM_A]);
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
    const rows = mapChatToRows(RICH, "user-1", PEOPLE);
    const reactions = mapChatToReactionRows(RICH, "user-1", PEOPLE);
    const parentByMsg = new Map(rows.map((r) => [JSON.parse(r.metadata ?? "{}").msgId as string, r.externalId]));
    expect(reactions.map((r) => r.associatedMessageGuid)).toEqual([
      parentByMsg.get("201"),
      parentByMsg.get("201"),
      parentByMsg.get("202"),
    ]);
    expect(reactions[0].associatedMessageGuid).toBe(`gmweb2:${H}:201`);
    // angry -> other (2006); heart WITH a variation selector -> Apple heart (2000); sad -> 2006
    expect(reactions.map((r) => r.associatedMessageType)).toEqual([2006, 2000, 2006]);
    // the stored emoji is what the pill renders
    expect(reactions.map((r) => r.bodyText)).toEqual(["\u{1F621}", "\u2764", "\u{1F622}"]);
    expect(reactions.map((r) => r.direction)).toEqual(["inbound", "outbound", "inbound"]);
    expect(JSON.parse(reactions[1].participants)).toEqual({ from: "me", to: [NUM_A] });
    expect(reactions[0].sentAt).toBe("2026-09-21T10:00:00.000Z");
  });

  it("re-sending a chat with reactions adds no reaction rows", async () => {
    const db = makeFakeDb("user-1");
    const first = await importCacheChat(RICH, "user-1", db.deps, PEOPLE);
    expect(first).toMatchObject({ received: 3, stored: 3, reactions: 3, reactionsStored: 3 });
    const again = await importCacheChat(RICH, "user-1", db.deps, PEOPLE);
    expect(again.reactionsStored).toBe(0);
    expect(db.reactionRows).toHaveLength(3);
  });
});

describe("image-only and file-only messages", () => {
  it("keeps an image-only message as attachment_only with has_attachments set", () => {
    const rows = mapChatToRows(RICH, "user-1", PEOPLE);
    const img = rows[1];
    expect(img.messageType).toBe("attachment_only");
    expect(img.hasAttachments).toBe(1);
    expect(img.bodyText).toBeNull();
    expect(JSON.parse(img.metadata ?? "{}")).toMatchObject({ images: 1 });
  });

  it("records a file it does not import by name and size only", () => {
    const rows = mapChatToRows(RICH, "user-1", PEOPLE);
    const file = rows[2];
    expect(file.messageType).toBe("attachment_only");
    expect(file.hasAttachments).toBe(0);
    expect(file.bodyText).toBe("[File not imported: contract.pdf (1.3 MB)]");
    expect(JSON.parse(file.metadata ?? "{}")).toMatchObject({
      filesNotImported: [{ name: "contract.pdf", size: "1.3 MB" }],
    });
  });
});

// ---------------------------------------------------------------------------
// BACKLOG-3642 / 3630 — the user's removals stick. Rows are still STORED
// (dedup), but a chat the user removed from the transaction is never linked
// again: by its gmweb2 thread id — stable across re-pairs — or a legacy
// gmweb-chat-<conversation id> removal.
//
// Mutations that turn these red: drop the thread-id check; drop the legacy
// check; drop the per-message check; link reactions of a removed chat.
// ---------------------------------------------------------------------------
// BACKLOG-3630 — the key, participants and the content guard.
// ---------------------------------------------------------------------------
describe("the stable key (BACKLOG-3630)", () => {
  // Mutation: unsorted or unnormalized numbers in the hash → red.
  it("the hash ignores order and formatting of the numbers", () => {
    expect(rcsChatHash(["(555) 555-0199", "+1 555 555 0142"])).toBe(rcsChatHash(["+15555550142", "+15555550199"]));
    expect(rcsChatHash([NUM_A])).not.toBe(rcsChatHash([NUM_B]));
    expect(rcsChatHash([NUM_A])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("peopleFrom: a job's numbers are the ones /match saw; the page only names them", () => {
    const fromPage = [
      { name: "Test Contact A", number: "(555) 555-0199" },
      { name: "Not In This Chat", number: "+1 555 555 0177" },
      { name: "Junk", number: "not a number" },
    ];
    expect(peopleFrom(fromPage, [NUM_A])).toEqual({ numbers: [NUM_A], names: [{ name: "Test Contact A", number: NUM_A }] });
    expect(peopleFrom(fromPage).numbers).toEqual(["+15555550177", NUM_A]);
    expect(peopleFrom("nope")).toEqual({ numbers: [], names: [] });
  });
});

describe("group chats (BACKLOG-3630)", () => {
  const NUM_C = "+15555550123";
  const GROUP: RcsChatPeople = {
    numbers: [NUM_B, NUM_C, NUM_A].sort(),
    names: [
      { name: "Test Contact A", number: NUM_A },
      { name: "Test Contact B", number: NUM_B },
      { name: "Test Contact Twin", number: NUM_C },
      { name: "Test Contact Twin", number: NUM_B },
    ],
  };
  const GROUP_CHAT: RcsIncomingChat = {
    conversationId: "groupgroupgroupgroup",
    title: "Test Contact A, Test Contact B and 1 other",
    messages: [
      { msgId: "g-1", direction: "inbound", sender: "Test Contact A", text: "hi all", sentAt: "2026-09-20T13:05:00.000Z", transport: "rcs" },
      { msgId: "g-2", direction: "inbound", sender: "Test Contact Twin", text: "same name twice", sentAt: "2026-09-20T13:06:00.000Z", transport: "rcs" },
      { msgId: "g-3", direction: "outbound", sender: "me", text: "hello", sentAt: "2026-09-20T13:07:00.000Z", transport: "rcs" },
    ],
  };

  // Mutations: resolve a name with two numbers to one of them; put only
  // ["me"] in a group message's "to" → red.
  it("a sender's name resolves to their number only when it maps to exactly one; a group never looks like a 1:1", () => {
    const rows = mapChatToRows(GROUP_CHAT, "user-1", GROUP);
    const members = { chat_members: GROUP.numbers };
    expect(JSON.parse(rows[0].participants)).toEqual({ from: NUM_A, to: ["me", ...GROUP.numbers.filter((n) => n !== NUM_A)], ...members });
    expect(JSON.parse(rows[1].participants)).toEqual({ from: "Test Contact Twin", to: ["me", ...GROUP.numbers], ...members });
    expect(JSON.parse(rows[2].participants)).toEqual({ from: "me", to: GROUP.numbers, ...members });
    expect(rows[0].participantsFlat).toBe(GROUP.numbers.join(", "));
  });

  // The conversation grouping (threadMergeUtils) must never fold a group into
  // the 1:1 chat of its first sender, even when only that sender ever wrote.
  it("a group with a single inbound sender is still a group for the thread merge; a 1:1 merges by its number", () => {
    const groupRows = mapChatToRows({ ...GROUP_CHAT, messages: [GROUP_CHAT.messages[0]] }, "user-1", GROUP);
    const asMessages = (rs: Array<{ participants: string; direction: string }>) =>
      rs.map((r) => ({ participants: r.participants, direction: r.direction })) as unknown as Parameters<typeof getContactMergeKey>[0];
    expect(getContactMergeKey(asMessages(groupRows), {})).toBeNull();
    const oneToOne = mapChatToRows(CHAT, "user-1", PEOPLE);
    expect(getContactMergeKey(asMessages(oneToOne), {})).toBe("phone:5555550199");
  });
});

describe("the content guard (BACKLOG-3630)", () => {
  // Mutation: ignore findContentDuplicates (insert anyway) → red.
  it("a message already stored under another gmweb2 key is not stored again", async () => {
    const db = makeFakeDb("user-1");
    db.deps.findContentDuplicates = (_uid, rows) => {
      const m = new Map<string, string>();
      for (const r of rows) if (r.bodyText === "two") m.set(r.externalId, "existing-row-id");
      return m;
    };
    const result = await importCacheChat(CHAT, "user-1", db.deps, PEOPLE);
    expect(db.rows.map((r) => r.bodyText)).toEqual(["one", "three"]);
    expect(result).toMatchObject({ stored: 2, sameContent: 1, alreadyPresent: 1 });
  });

  it("only rows that would be NEW are checked (a plain re-send is not)", async () => {
    const db = makeFakeDb("user-1");
    await importCacheChat(CHAT, "user-1", db.deps, PEOPLE);
    const asked: number[] = [];
    db.deps.findContentDuplicates = (_uid, rows) => {
      asked.push(rows.length);
      return new Map();
    };
    await importCacheChat(CHAT, "user-1", db.deps, PEOPLE);
    expect(asked).toEqual([]);
  });
});

// SR F1: the content guard's people check (pure). Mutation: return true
// whenever the bodies matched → red.
describe("samePeople (BACKLOG-3630, SR F1)", () => {
  const inbound = (from: string, flat: string) => ({ direction: "inbound", participants: JSON.stringify({ from, to: ["me"] }), participantsFlat: flat });
  const outbound = (flat: string) => ({ direction: "outbound", participants: JSON.stringify({ from: "me", to: flat.split(", ") }), participantsFlat: flat });
  it("inbound: the sender's number must be the old row's sender or one of its numbers", () => {
    expect(samePeople(inbound(NUM_A, NUM_A), { participants: JSON.stringify({ from: NUM_A }), participantsFlat: NUM_A })).toBe(true);
    expect(samePeople(inbound(NUM_A, NUM_A), { participants: JSON.stringify({ from: NUM_B }), participantsFlat: NUM_B })).toBe(false);
    expect(samePeople(inbound(NUM_A, NUM_A), { participants: "{}", participantsFlat: `${NUM_B}, ${NUM_A}` })).toBe(true);
    expect(samePeople(inbound("Test Contact Twin", NUM_A), { participants: JSON.stringify({ from: "Test Contact Twin" }), participantsFlat: NUM_A })).toBe(false);
  });
  it("outbound: at least one number in common", () => {
    expect(samePeople(outbound(`${NUM_A}, ${NUM_B}`), { participants: "{}", participantsFlat: NUM_B })).toBe(true);
    expect(samePeople(outbound(NUM_A), { participants: "{}", participantsFlat: NUM_B })).toBe(false);
    expect(samePeople(outbound(NUM_A), { participants: null, participantsFlat: null })).toBe(false);
  });
});

// BACKLOG-3658: a cache chat is stored for the job's user, tagged
// "gmweb-cache", and linked to nothing. Mutation: link it / keep the source → red.
describe("importCacheChat (BACKLOG-3658)", () => {
  it("stores the rows for the user, tagged gmweb-cache, and links nothing", async () => {
    const db = makeFakeDb("user-1");
    const result = await importCacheChat(CHAT, "user-1", db.deps, PEOPLE);
    expect(result).toMatchObject({ stored: 3, linked: 0 });
    expect(db.rows.every((r) => r.userId === "user-1")).toBe(true);
    expect(db.rows.map((r) => JSON.parse(r.metadata ?? "{}").source)).toEqual(["gmweb-cache", "gmweb-cache", "gmweb-cache"]);
  });

  it("a chat without a number is refused", async () => {
    const db = makeFakeDb("user-1");
    await expect(importCacheChat(CHAT, "user-1", db.deps, { numbers: [], names: [] })).rejects.toThrow("no phone number");
  });
});

// Founder (2026-10-02): reply-to captured now, shown later — in the row's
// metadata only, sanitized and capped. Mutations: replyTo dropped by the
// parser / not stored → red; no cap or no sanitizing → red; a bad msgId or
// sender kept → red.
describe("reply-to metadata", () => {
  const base = { msgId: "m-9", direction: "inbound", sender: "x", text: "Yes i am!!!", sentAt: "2026-09-20T13:05:00.000Z", transport: "rcs" };
  const parse = (replyTo: unknown) => parseIncomingChat({ conversationId: "c", title: "t", messages: [{ ...base, replyTo }] }) as RcsIncomingChat;

  it("by id (same chat) → reply_to_external_id; by snippet → reply_snippet + reply_sender", () => {
    const byId = parse({ msgId: "m-1" });
    expect(byId.messages[0].replyTo).toEqual({ msgId: "m-1" });
    const rows = mapChatToRows(byId, "user-1", PEOPLE);
    expect(JSON.parse(rows[0].metadata as string).reply_to_external_id).toBe(`gmweb2:${H}:m-1`);
    const bySnippet = parse({ snippet: "Are you still coming to the open house?", sender: "them" });
    const meta = JSON.parse(mapChatToRows(bySnippet, "user-1", PEOPLE)[0].metadata as string);
    expect(meta).toMatchObject({ reply_snippet: "Are you still coming to the open house?", reply_sender: "them" });
    expect(meta.reply_to_external_id).toBeUndefined();
  });

  it("sanitized and capped: control characters out, whitespace collapsed, 80 characters", () => {
    const long = parse({ snippet: "a\u0000b\n\n  c\t" + "x".repeat(200), sender: "me" });
    const s = (long.messages[0].replyTo as { snippet: string }).snippet;
    expect(s.length).toBe(RCS_REPLY_SNIPPET_MAX);
    expect(s.startsWith("a b c x")).toBe(true);
    expect(RCS_REPLY_SNIPPET_MAX).toBe(80);
  });

  it("anything else is dropped, never an error: bad ids, other senders, empty snippets", () => {
    expect(parseReplyTo({ msgId: "<script>" })).toBeUndefined();
    expect(parseReplyTo({ msgId: "x".repeat(65) })).toBeUndefined();
    expect(parseReplyTo({ snippet: "hi", sender: "Test Contact B" })).toBeUndefined();
    expect(parseReplyTo({ snippet: "   ", sender: "me" })).toBeUndefined();
    expect(parseReplyTo("nope")).toBeUndefined();
    expect(parse(undefined).messages[0].replyTo).toBeUndefined();
    expect(JSON.parse(mapChatToRows(parse(undefined), "user-1", PEOPLE)[0].metadata as string)).not.toHaveProperty("reply_snippet");
  });
});
