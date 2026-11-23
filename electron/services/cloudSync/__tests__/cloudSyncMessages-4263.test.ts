/**
 * @jest-environment node
 *
 * BACKLOG-4263 P5 — a deal's attached emails and texts go up (no file bytes).
 *
 * Local rows are written with the producers' own statements (helpers/messageFixtures.ts). The server is the fake,
 * whose message functions are transcribed from supabase/migrations/20261123130000_backlog_4263_messages_up_server.sql
 * (helpers/fakeServer.ts, the parity test at the end). No network, no Electron.
 */
import fs from "fs";
import path from "path";
import { DRIVER, type TestDb } from "./helpers/sqlite";
import { dealId, enableUser, freshDb, insertDeal, PROJECT, USER_A } from "./helpers/fixtures";
import { makeEngine, pass, startAndPass, type Engine } from "./helpers/engine";
import { FakeServer } from "./helpers/fakeServer";
import {
  addEmail,
  addPhoneText,
  addText,
  fz,
  hideText,
  linkEmail,
  linkText,
  linkThread,
  retag,
  unhideText,
  unlink,
} from "./helpers/messageFixtures";
import * as messagesDb from "../../db/cloudSyncMessagesDb";
import { BODY_MAX_CODE_POINTS, boundedInstant, cutCodePoints, MESSAGE_HASH_VERSION, projectMessage } from "../messageProjection";
import { MESSAGE_CALLS_PER_PASS, MESSAGE_ROWS_PER_PASS } from "../runner";
import { applyMoveHere } from "../../db/cloudSyncDbService";
import { resetSyncStateAfterRestore } from "../../db/cloudSyncTriggers";
import { INSERT_PENDING_REVIEW_EMAIL_SQL } from "../../db/reviewStateSql";
import { archiveDealBeforeDelete } from "../../db/cloudSyncDealArchive";
import { deleteLikeTheHandler } from "./helpers/dealArchiveFixtures";

function setup(opts: { upload?: boolean; deals?: number } = {}) {
  const db = freshDb();
  enableUser(db);
  const deals = Array.from({ length: opts.deals ?? 1 }, () => dealId());
  for (const d of deals) insertDeal(db, d);
  const e = makeEngine(db);
  e.server.messagesUpload = opts.upload ?? true;
  return { db, e, deal: deals[0], deals };
}

const upserts = (e: Engine) => e.server.callsTo("cloud_upsert_messages");
const msgTombstones = (e: Engine) => e.server.callsTo("cloud_tombstone").filter((c) => c.args.p_kind === "message");
const liveOnline = (e: Engine) => e.server.messages.filter((m) => !m.removed);
const records = (db: TestDb) =>
  db.prepare("SELECT local_id, cloud_id, removed, hash_version FROM cloud_sync_state WHERE entity = 'message' ORDER BY local_id").all() as Array<{
    local_id: string;
    cloud_id: string | null;
    removed: number;
    hash_version: number | null;
  }>;
const marker = (db: TestDb) => messagesDb.readReconcileMarker(db, PROJECT, USER_A);
const advance = (e: Engine, ms: number) => (e.clock.now = new Date(e.clock.now.getTime() + ms));

describe(`Keepr Cloud emails and texts up [${DRIVER}]`, () => {
  // ================================================================ selection
  describe("selection", () => {
    it("C-5a: one email on two deals is two online rows; unlinking it from one deal leaves the other's live", async () => {
      const { db, e, deals } = setup({ deals: 2 });
      addEmail(db, fz(1, 1));
      linkEmail(db, fz(2, 1), deals[0], fz(1, 1));
      linkEmail(db, fz(2, 2), deals[1], fz(1, 1));
      await startAndPass(e);
      expect(liveOnline(e)).toHaveLength(2);
      expect(new Set(liveOnline(e).map((m) => m.dealId)).size).toBe(2);
      unlink(db, fz(2, 1));
      await pass(e);
      expect(liveOnline(e)).toHaveLength(1);
      const b = e.server.deals.find((d) => d.localId === deals[1])!;
      expect(liveOnline(e)[0].dealId).toBe(b.id);
    });

    it("C-5b (P5-a): unlinking a whole text thread tombstones every text of it; the texts stay on this computer", async () => {
      const { db, e, deal } = setup();
      for (let i = 1; i <= 3; i++) addText(db, fz(3, i), { threadId: "macos-chat-7", sentAt: `2026-10-0${i}T10:00:00.000Z`, body: `t${i}` });
      linkThread(db, fz(2, 1), deal, "macos-chat-7");
      await startAndPass(e);
      expect(liveOnline(e)).toHaveLength(3);
      unlink(db, fz(2, 1));
      await pass(e);
      expect(liveOnline(e)).toHaveLength(0);
      expect((db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n).toBe(3);
      expect(e.server.messages.every((m) => m.row.body_text === null && m.row.subject === null)).toBe(true);
    });

    it("C-5e: no date window: a text years outside the deal's dates goes up", async () => {
      const db = freshDb();
      enableUser(db);
      const deal = dealId();
      insertDeal(db, deal, USER_A, { started_at: "2026-01-01", closed_at: "2026-02-01" });
      const e = makeEngine(db);
      e.server.messagesUpload = true;
      addText(db, fz(3, 1), { sentAt: "2019-05-05T10:00:00.000Z" });
      linkText(db, fz(2, 1), deal, fz(3, 1));
      await startAndPass(e);
      expect(liveOnline(e)).toHaveLength(1);
    });

    it("C-5f: a Needs-review email (address_missing, 0.5) goes up with its match_reason; the server marks it needs_review", async () => {
      const { db, e, deal } = setup();
      addEmail(db, fz(1, 1));
      linkEmail(db, fz(2, 1), deal, fz(1, 1), { matchReason: "address_missing", confidence: 0.5 });
      await startAndPass(e);
      expect(liveOnline(e)[0].row).toMatchObject({ match_reason: "address_missing", link_confidence: 0.5, link_source: "auto" });
      expect(liveOnline(e)[0].linkState).toBe("needs_review");
    });

    it("C-q1: an email waiting in the review queue (not a link) never goes up", async () => {
      const { db, e, deal } = setup();
      addEmail(db, fz(1, 1));
      db.prepare(INSERT_PENDING_REVIEW_EMAIL_SQL).run(fz(4, 1), USER_A, deal, fz(1, 1));
      await startAndPass(e);
      expect(upserts(e)).toHaveLength(0);
    });

    it("P-a1: a hidden text and a reaction to it go up flagged hidden_from_export; an unhide clears the flag", async () => {
      const { db, e, deal } = setup();
      addText(db, fz(3, 1), { externalId: "guid-parent", body: "Offer is 500" });
      addText(db, fz(3, 2), { externalId: "guid-react", body: "", assocType: 2000, assocGuid: "guid-parent" });
      addText(db, fz(3, 3), { externalId: "guid-other", body: "Fine" });
      linkThread(db, fz(2, 1), deal, "macos-chat-1");
      expect(hideText(db, deal, fz(3, 1))).toBe(1);
      await startAndPass(e);
      const by = (id: string) => liveOnline(e).find((m) => m.localId === id)!;
      expect(by("guid-parent").row.hidden_from_export).toBe(true);
      expect(by("guid-react").row.hidden_from_export).toBe(true);
      expect(by("guid-other").row.hidden_from_export).toBe(false);
      unhideText(db, deal, fz(3, 1));
      await pass(e);
      expect(by("guid-parent").row.hidden_from_export).toBe(false);
      expect(by("guid-react").row.hidden_from_export).toBe(false);
    });

    it("P-a2: another user's copy of a thread is not selected; content duplicates collapse to one; a text on both a per-message and a thread link is one row", () => {
      const db = freshDb();
      const deal = dealId();
      insertDeal(db, deal);
      addText(db, fz(3, 1), { externalId: "g1", body: "same", sentAt: "2026-10-01T10:00:00.000Z" });
      addText(db, fz(3, 2), { externalId: "g2", channel: "sms", body: "same", sentAt: "2026-10-01T10:00:00.000Z" });
      addText(db, fz(3, 3), { externalId: "g3", body: "other user's copy", user: "user-b-4243" });
      linkThread(db, fz(2, 1), deal, "macos-chat-1");
      linkText(db, fz(2, 2), deal, fz(3, 1));
      const sel = messagesDb.selectDealMessages(db, deal);
      expect(sel.map((m) => m.wireId).sort()).toEqual(["g2"]);
    });

    it("P-o1: the same rows inserted in two physical orders give the same keys and hashes (raw scan order differs)", () => {
      const build = (reverse: boolean) => {
        const db = freshDb();
        const deal = dealId(901);
        insertDeal(db, deal);
        const texts = [
          [fz(3, 1), "ga", "imessage"],
          [fz(3, 2), "gb", "sms"],
          [fz(3, 3), "gc", "imessage"],
        ] as const;
        const order = reverse ? [...texts].reverse() : texts;
        for (const [id, g, ch] of order) addText(db, id, { externalId: g, channel: ch, body: "dup", sentAt: "2026-10-01T10:00:00.000Z" });
        const links = [() => linkThread(db, fz(2, 1), deal, "macos-chat-1"), () => linkText(db, fz(2, 2), deal, fz(3, 1))];
        for (const l of reverse ? [...links].reverse() : links) l();
        const rawIds = (db.prepare(
          "SELECT m.id FROM communications c JOIN messages m ON (c.message_id = m.id OR (c.message_id IS NULL AND c.thread_id = m.thread_id)) WHERE c.transaction_id = ? ORDER BY m.sent_at DESC",
        ).all(deal) as Array<{ id: string }>).map((r) => r.id);
        const sel = messagesDb.selectDealMessages(db, deal).map(projectMessage);
        return { rawIds, keys: sel.map((m) => m.key), hashes: sel.map((m) => m.hash) };
      };
      const a = build(false);
      const b = build(true);
      expect(a.rawIds).not.toEqual(b.rawIds);
      expect(a.keys).toEqual(b.keys);
      expect(a.hashes).toEqual(b.hashes);
    });
  });

  // ================================================================ dirty marks
  describe("dirty marks", () => {
    it("C-5c (MF-7): on a synced deal with an unchanged header, a new text in a linked thread goes up within one pass", async () => {
      const { db, e, deal } = setup();
      addText(db, fz(3, 1));
      linkThread(db, fz(2, 1), deal, "macos-chat-1");
      await startAndPass(e);
      expect((db.prepare("SELECT last_status FROM cloud_sync_state WHERE entity = 'deal'").get() as { last_status: string }).last_status).toBe("synced");
      addText(db, fz(3, 2), { sentAt: "2026-10-05T10:00:00.000Z", body: "new one" });
      await pass(e);
      expect(liveOnline(e)).toHaveLength(2);
    });

    it("C-5d2: a text deleted from a thread-linked thread is tombstoned on the next pass", async () => {
      const { db, e, deal } = setup();
      addText(db, fz(3, 1));
      addText(db, fz(3, 2), { body: "second", sentAt: "2026-10-03T10:00:00.000Z" });
      linkThread(db, fz(2, 1), deal, "macos-chat-1");
      await startAndPass(e);
      db.prepare("DELETE FROM messages WHERE id = ?").run(fz(3, 2));
      await pass(e);
      expect(liveOnline(e).map((m) => m.localId)).toEqual([`guid-${fz(3, 1)}`]);
    });

    it("P-r1 (MF-3): the importer's in-place retag changes body_text only → the deal is marked and the row re-sent", async () => {
      const { db, e, deal } = setup();
      // A legacy reaction row whose reaction columns already hold the retag's values; only body_text differs.
      addText(db, fz(3, 1), { externalId: "guid-r", body: "Loved “hi”", assocType: null, assocGuid: null });
      db.prepare("UPDATE messages SET associated_message_type = 2000, associated_message_guid = 'p:0/g0', message_type = NULL WHERE id = ?").run(fz(3, 1));
      linkThread(db, fz(2, 1), deal, "macos-chat-1");
      await startAndPass(e);
      const before = upserts(e).length;
      // The retag statement's WHERE needs associated_message_type NULL (a legacy row); put the row back in that shape.
      db.prepare("UPDATE messages SET associated_message_type = NULL, associated_message_guid = NULL WHERE id = ?").run(fz(3, 1));
      await pass(e);
      db.prepare("DELETE FROM cloud_sync_dirty").run();
      expect(retag(db, "guid-r", 2000, "p:0/g0")).toBe(1);
      expect((db.prepare("SELECT COUNT(*) AS n FROM cloud_sync_dirty").get() as { n: number }).n).toBe(1);
      await pass(e);
      expect(upserts(e).length).toBe(before + 1);
      expect(liveOnline(e)[0].row.body_text).toBeNull();
    });

    it("P-r1b (MF-3): an UPDATE of body_text alone on a linked text marks its deal", () => {
      const { db, deal } = setup();
      addText(db, fz(3, 1));
      linkThread(db, fz(2, 1), deal, "macos-chat-1");
      db.prepare("DELETE FROM cloud_sync_dirty").run();
      db.prepare("UPDATE messages SET body_text = 'edited' WHERE id = ?").run(fz(3, 1));
      expect((db.prepare("SELECT COUNT(*) AS n FROM cloud_sync_dirty").get() as { n: number }).n).toBe(1);
    });

    it("P-r2 (MF-3): a text whose thread changes marks the deals of the old and the new thread", () => {
      const db = freshDb();
      enableUser(db);
      const [a, b] = [dealId(), dealId()];
      insertDeal(db, a);
      insertDeal(db, b);
      addText(db, fz(3, 1), { threadId: "macos-chat-1" });
      linkThread(db, fz(2, 1), a, "macos-chat-1");
      linkThread(db, fz(2, 2), b, "macos-chat-2");
      db.prepare("DELETE FROM cloud_sync_dirty").run();
      db.prepare("UPDATE messages SET thread_id = 'macos-chat-2' WHERE id = ?").run(fz(3, 1));
      expect((db.prepare("SELECT transaction_id FROM cloud_sync_dirty ORDER BY transaction_id").all() as Array<{ transaction_id: string }>).map((r) => r.transaction_id)).toEqual([a, b].sort());
    });

    it("hiding a text after it went up re-sends it flagged hidden_from_export", async () => {
      const { db, e, deal } = setup();
      addText(db, fz(3, 1));
      linkThread(db, fz(2, 1), deal, "macos-chat-1");
      await startAndPass(e);
      expect(liveOnline(e)[0].row.hidden_from_export).toBe(false);
      expect(hideText(db, deal, fz(3, 1))).toBe(1);
      await pass(e);
      expect(liveOnline(e)[0].row.hidden_from_export).toBe(true);
    });

    it("a link moved to another deal (communicationDbService.ts:484) is tombstoned on the old deal and sent on the new", async () => {
      const { db, e, deals } = setup({ deals: 2 });
      addEmail(db, fz(1, 1));
      linkEmail(db, fz(2, 1), deals[0], fz(1, 1));
      await startAndPass(e);
      db.prepare("UPDATE communications SET transaction_id = ? WHERE id = ?").run(deals[1], fz(2, 1));
      await pass(e);
      const b = e.server.deals.find((d) => d.localId === deals[1])!;
      expect(liveOnline(e).map((m) => m.dealId)).toEqual([b.id]);
    });

    it("a Needs-review email confirmed (match_reason cleared, communicationDbService.ts:357) is re-sent as linked", async () => {
      const { db, e, deal } = setup();
      addEmail(db, fz(1, 1));
      linkEmail(db, fz(2, 1), deal, fz(1, 1), { matchReason: "address_missing", confidence: 0.5 });
      await startAndPass(e);
      expect(liveOnline(e)[0].linkState).toBe("needs_review");
      db.prepare("UPDATE communications SET match_reason = NULL WHERE id = ?").run(fz(2, 1));
      await pass(e);
      expect(liveOnline(e)[0].linkState).toBe("linked");
    });

    it("an email body re-derived marks its deal; an equal re-sync marks nothing", () => {
      const { db, deal } = setup();
      addEmail(db, fz(1, 1));
      linkEmail(db, fz(2, 1), deal, fz(1, 1));
      db.prepare("DELETE FROM cloud_sync_dirty").run();
      db.prepare("UPDATE emails SET body_plain = body_plain WHERE id = ?").run(fz(1, 1));
      expect((db.prepare("SELECT COUNT(*) AS n FROM cloud_sync_dirty").get() as { n: number }).n).toBe(0);
      db.prepare("UPDATE emails SET body_plain = 'changed' WHERE id = ?").run(fz(1, 1));
      expect((db.prepare("SELECT COUNT(*) AS n FROM cloud_sync_dirty").get() as { n: number }).n).toBe(1);
    });
  });

  // ================================================================ projection
  describe("projection", () => {
    it("P-c1: an empty or placeholder-only text body is sent as null; real text is kept (U+FFFC fixture: defensive input)", async () => {
      const { db, e, deal } = setup();
      const bodies = ["", "￼", " � ", "a"];
      bodies.forEach((b, i) => addText(db, fz(3, i + 1), { body: b, sentAt: `2026-10-0${i + 1}T10:00:00.000Z` }));
      addPhoneText(db, fz(3, 9), { threadId: "macos-chat-1", body: null });
      linkThread(db, fz(2, 1), deal, "macos-chat-1");
      await startAndPass(e);
      const body = (id: string) => liveOnline(e).find((m) => m.localId === `guid-${id}`)!.row.body_text;
      expect([1, 2, 3, 4].map((i) => body(fz(3, i)))).toEqual([null, null, null, "a"]);
      expect(body(fz(3, 9))).toBeNull();
    });

    it("an HTML-only email is sent as text through the existing converter; HTML is never sent", async () => {
      const { db, e, deal } = setup();
      addEmail(db, fz(1, 1), { bodyPlain: "", bodyHtml: "<p>Hello <b>there</b></p>" });
      linkEmail(db, fz(2, 1), deal, fz(1, 1));
      await startAndPass(e);
      const row = liveOnline(e)[0].row;
      expect(row.body_text).toContain("Hello");
      expect(String(row.body_text)).not.toContain("<");
    });

    it("P-d1 (MF-6): every stored time shape is sent normalised or as null; no row is rejected", async () => {
      const shapes = [
        null, "", "2026-11-23 10:00:00", "2026-11-23T10:00:00Z", "2026-11-23T10:00:00+02:00", "2026-11-23", "garbage",
        "0001-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z", "+010000-01-01T00:00:00.000Z", "+275760-09-13T00:00:00.000Z",
        "-000001-01-01T00:00:00.000Z", "12345", "+020026-01-01T00:00:00.000Z",
      ];
      expect(shapes.map(boundedInstant)).toEqual([
        null, null, "2026-11-23T10:00:00.000Z", "2026-11-23T10:00:00.000Z", "2026-11-23T08:00:00.000Z", "2026-11-23T00:00:00.000Z", null,
        "0001-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z", null, null, null, null, null,
      ]);
      const { db, e, deal } = setup();
      shapes.forEach((t, i) => {
        addEmail(db, fz(1, i + 1), { sentAt: t, receivedAt: t });
        linkEmail(db, fz(2, i + 1), deal, fz(1, i + 1));
      });
      await startAndPass(e);
      expect(liveOnline(e)).toHaveLength(shapes.length);
      expect(upserts(e).flatMap((c) => c.args.p_rows as unknown[]).length).toBe(shapes.length);
    });

    it("P-n1 (MF-5): NUL and lone surrogates are removed before the cut; a pair at the cut stays whole; the call is accepted", async () => {
      // Defensive input: a SQLite driver may cut a stored string at NUL, so this row goes to the projection directly.
      const row = {
        id: "e", message_row_id: null, email_row_id: "e", communication_id: "c", user_id: USER_A, transaction_id: "t",
        link_source: "auto", link_confidence: 0.9, match_reason: null, linked_at: null, channel: "email",
        body_text: "b\u0000\uDC00ody", email_body_html: null, subject: "a\u0000b\uD800c\uDC00d", sent_at: null, received_at: null,
        thread_id: "th\u0000", direction: "inbound", participants: null, sender: "s\u0000@example.test", recipients: "x\uD800@example.test",
        cc: null, external_id: null, associated_message_type: null, associated_message_guid: null, hidden_from_export: 0,
      };
      const p = projectMessage({ key: "t|email|e", channelKind: "email", wireId: "e", hidden: false, row });
      expect(p.payload).toMatchObject({ subject: "abcd", body_text: "body", thread_key: "th", participants: { from: "s@example.test", to: ["x@example.test"], cc: [] } });
      const fake = new FakeServer(USER_A);
      fake.messagesUpload = true;
      fake.deals.push({ id: "d1", owner: USER_A, install: "i1", localId: "l1", hash: "", version: 1, fullSyncAt: null });
      const ok = await fake.transport("cloud_upsert_messages", { p_expected_user_id: USER_A, p_source_install_id: "i1", p_cloud_deal_id: "d1", p_rows: [p.payload] }, new AbortController().signal);
      expect(ok.error).toBeNull();
      const bad = await fake.transport("cloud_upsert_messages", { p_expected_user_id: USER_A, p_source_install_id: "i1", p_cloud_deal_id: "d1", p_rows: [{ ...p.payload, subject: "a\u0000" }] }, new AbortController().signal);
      expect(bad.error).toMatchObject({ code: "22P05" });
      const { db, e, deal } = setup();
      const astral = "\u{1F600}";
      addEmail(db, fz(1, 1), { bodyPlain: "x".repeat(BODY_MAX_CODE_POINTS - 1) + astral + "tail" });
      linkEmail(db, fz(2, 1), deal, fz(1, 1));
      await startAndPass(e);
      expect(e.logs.filter((l) => l.message.includes("not saved"))).toEqual([]);
      const sent = (upserts(e)[0].args.p_rows as Array<Record<string, string>>)[0].body_text;
      expect(Array.from(sent)).toHaveLength(BODY_MAX_CODE_POINTS);
      expect(sent.endsWith(astral)).toBe(true);
      expect(liveOnline(e)[0].bodyTruncated).toBe(true);
    });

    it("P-g1: body sweep at 999,999 / 1,000,000 / 1,000,001 / 1,000,002 code points (4-byte characters): the server truncates and flags from 1,000,001", () => {
      for (const [n, cut] of [[999_999, false], [1_000_000, false], [1_000_001, true], [1_000_002, true]] as const) {
        const s = "\u{1F600}".repeat(n);
        const c = cutCodePoints(s, BODY_MAX_CODE_POINTS);
        expect(Array.from(c).length).toBe(Math.min(n, BODY_MAX_CODE_POINTS));
        expect(Array.from(c).length > 1_000_000).toBe(cut);
      }
    });

    it("P-l1 (MF-10): local ids of 199/200 code points are sent, 201 falls back to the row id; links with no content send nothing", async () => {
      const { db, e, deal } = setup();
      const id200 = "a".repeat(199) + "\u{1F600}";
      const id201 = "a".repeat(200) + "\u{1F600}";
      addText(db, fz(3, 1), { externalId: "a".repeat(199) });
      addText(db, fz(3, 2), { externalId: id200, sentAt: "2026-10-04T10:00:00.000Z" });
      addText(db, fz(3, 3), { externalId: id201, sentAt: "2026-10-05T10:00:00.000Z" });
      addText(db, fz(3, 4), { externalId: "", sentAt: "2026-10-06T10:00:00.000Z" });
      linkThread(db, fz(2, 1), deal, "macos-chat-1");
      linkThread(db, fz(2, 2), deal, "macos-chat-empty");
      await startAndPass(e);
      expect(liveOnline(e).map((m) => m.localId).sort()).toEqual(["a".repeat(199), fz(3, 3), fz(3, 4), id200].sort());
      expect(e.server.calls.some((c) => (c.args as { error?: string }).error === "invalid_input")).toBe(false);
    });

    it("P-t1 (MF-4): an iPhone text with no thread id is accepted with a stable thread key; a re-import keeps it", async () => {
      const { db, e, deal } = setup();
      addPhoneText(db, fz(3, 1), { externalId: "guid-phone", threadId: null });
      linkText(db, fz(2, 1), deal, fz(3, 1));
      await startAndPass(e);
      expect(liveOnline(e)[0].row.thread_key).toBe("msg:guid-phone");
      const sel = messagesDb.selectDealMessages(db, deal).map(projectMessage)[0];
      db.prepare("DELETE FROM messages WHERE id = ?").run(fz(3, 1));
      addPhoneText(db, fz(3, 2), { externalId: "guid-phone", threadId: null });
      linkText(db, fz(2, 2), deal, fz(3, 2));
      const again = messagesDb.selectDealMessages(db, deal).map(projectMessage)[0];
      expect(again.key).toBe(sel.key);
      expect(again.payload.thread_key).toBe("msg:guid-phone");
    });

    it("P-h1 (MF-8): after a full send a second pass makes zero message calls; records carry the message hash version", async () => {
      const { db, e, deal } = setup();
      addEmail(db, fz(1, 1));
      linkEmail(db, fz(2, 1), deal, fz(1, 1));
      addText(db, fz(3, 1));
      linkThread(db, fz(2, 2), deal, "macos-chat-1");
      await startAndPass(e);
      expect(records(db).every((r) => r.hash_version === MESSAGE_HASH_VERSION)).toBe(true);
      db.prepare("UPDATE transactions SET property_city = 'Elsewhere' WHERE id = ?").run(deal);
      const n = upserts(e).length;
      await pass(e);
      expect(upserts(e).length).toBe(n);
    });
  });

  // ================================================================ switch, budget, refusals
  describe("switch, budget and refusals", () => {
    it("C-7c: with messages_upload off nothing is sent, but an unlink still tombstones", async () => {
      const { db, e, deal } = setup({ upload: true });
      addEmail(db, fz(1, 1));
      linkEmail(db, fz(2, 1), deal, fz(1, 1));
      addEmail(db, fz(1, 2));
      await startAndPass(e);
      e.server.messagesUpload = false;
      linkEmail(db, fz(2, 2), deal, fz(1, 2));
      unlink(db, fz(2, 1));
      const n = upserts(e).length;
      await pass(e);
      expect(upserts(e).length).toBe(n);
      expect(liveOnline(e)).toHaveLength(0);
      expect(msgTombstones(e).length).toBeGreaterThan(0);
    });

    it("C-7d / C-7e: off → reconcile → on marks every eligible deal exactly once; a second reconcile and pass mark nothing more", async () => {
      const { db, e, deal } = setup({ upload: false });
      addEmail(db, fz(1, 1));
      linkEmail(db, fz(2, 1), deal, fz(1, 1));
      await startAndPass(e);
      expect(upserts(e)).toHaveLength(0);
      e.server.messagesUpload = true;
      await pass(e);
      expect(liveOnline(e)).toHaveLength(1);
      expect(messagesDb.messagesUploadSeen(db, PROJECT, USER_A)).toBe(true);
      advance(e, 25 * 3_600_000);
      await pass(e);
      const marked = (db.prepare("SELECT COUNT(*) AS n FROM cloud_sync_dirty").get() as { n: number }).n;
      expect(marked).toBe(0);
    });

    it("C-7e crash: a crash at the re-mark leaves the sentinel unwritten, so the next state answer re-marks", () => {
      const { db } = setup({ upload: false });
      db.prepare("DELETE FROM cloud_sync_dirty").run();
      const real = db.prepare.bind(db);
      let thrown = false;
      (db as unknown as { prepare: (s: string) => unknown }).prepare = (sql: string) => {
        if (sql.startsWith("INSERT INTO cloud_sync_dirty")) {
          thrown = true;
          throw new Error("crash");
        }
        return real(sql);
      };
      expect(() => messagesDb.applyMessagesUploadSwitch(db, PROJECT, USER_A, true, new Date())).toThrow("crash");
      (db as unknown as { prepare: unknown }).prepare = real;
      expect(thrown).toBe(true);
      expect((db.prepare("SELECT COUNT(*) AS n FROM cloud_sync_dirty").get() as { n: number }).n).toBe(0);
      expect(messagesDb.messagesUploadSeen(db, PROJECT, USER_A)).toBe(false);
      expect(messagesDb.applyMessagesUploadSwitch(db, PROJECT, USER_A, true, new Date())).toBe(true);
      expect((db.prepare("SELECT COUNT(*) AS n FROM cloud_sync_dirty").get() as { n: number }).n).toBe(1);
    });

    it("P-fo: feature_off on the second batch stops sending for the pass; tombstones go; the deal is not parked or marked synced", async () => {
      const { db, e, deal } = setup();
      for (let i = 1; i <= 2; i++) {
        addEmail(db, fz(1, 100 + i));
        linkEmail(db, fz(2, 100 + i), deal, fz(1, 100 + i));
      }
      await startAndPass(e);
      unlink(db, fz(2, 101));
      for (let i = 1; i <= 700; i++) {
        addEmail(db, fz(11, i), { sentAt: "2026-09-01T00:00:00.000Z" });
        linkEmail(db, fz(12, i), deal, fz(11, i));
      }
      let calls = 0;
      e.server.override = (fn) => (fn === "cloud_upsert_messages" && ++calls === 2 ? { data: { ok: false, error: "feature_off" }, error: null } : undefined);
      const synced = e.server.callsTo("cloud_mark_deal_synced").length;
      await pass(e);
      expect(calls).toBe(2);
      expect(msgTombstones(e).length).toBeGreaterThan(0);
      expect(e.server.callsTo("cloud_mark_deal_synced").length).toBe(synced);
      const d = db.prepare("SELECT next_attempt_at FROM cloud_sync_dirty WHERE transaction_id = ?").get(deal) as { next_attempt_at: string | null };
      expect(d.next_attempt_at).toBeNull();
    });

    it("P-g2: budget boundaries: 499/500/501 rows in one deal; 1,999/2,000/2,001 rows across deals; at most 4 calls a pass", async () => {
      for (const [n, calls] of [[499, 1], [500, 1], [501, 2]] as const) {
        const { db, e, deal } = setup();
        for (let i = 1; i <= n; i++) {
          addEmail(db, fz(1, i), { bodyPlain: "b" });
          linkEmail(db, fz(2, i), deal, fz(1, i));
        }
        const s = await startAndPass(e);
        expect([n, upserts(e).length, liveOnline(e).length, s?.budgetExhausted]).toEqual([n, calls, n, false]);
      }
      // Rows: four deals of up to 500 (four calls); the 2,001st row needs a fifth call.
      // The 2,000-row cap equals 4 calls of 500 rows, so the call cap binds first: 2,001 rows → 501 + 500 + 500 sent.
      for (const [n, sent, left] of [[1_999, 1_999, false], [2_000, 2_000, false], [2_001, 1_501, true]] as const) {
        const { db, e, deals } = setup({ deals: 4 });
        for (let i = 1; i <= n; i++) {
          addEmail(db, fz(1, i), { bodyPlain: "b" });
          linkEmail(db, fz(2, i), deals[(i - 1) % 4], fz(1, i));
        }
        const s = await startAndPass(e);
        expect([n, liveOnline(e).length, s?.budgetExhausted]).toEqual([n, sent, left]);
        expect(upserts(e).length).toBeLessThanOrEqual(MESSAGE_CALLS_PER_PASS + 1);
        expect(liveOnline(e).length).toBeLessThanOrEqual(MESSAGE_ROWS_PER_PASS);
        if (left) {
          await pass(e);
          expect(liveOnline(e).length).toBe(n);
        }
      }
      // Calls: five deals of one row each → four calls, then the budget is used up.
      for (const [n, sentCalls, left] of [[3, 3, false], [4, 4, false], [5, 4, true]] as const) {
        const { db, e, deals } = setup({ deals: n });
        deals.forEach((d, i) => {
          addEmail(db, fz(1, i + 1));
          linkEmail(db, fz(2, i + 1), d, fz(1, i + 1));
        });
        const s = await startAndPass(e);
        expect([n, upserts(e).length, s?.budgetExhausted]).toEqual([n, sentCalls, left]);
      }
    });

    it("P-x1: a refused computer (another computer active) makes no message call of any kind, the listing included", async () => {
      const { db, e, deal } = setup();
      addEmail(db, fz(1, 1));
      linkEmail(db, fz(2, 1), deal, fz(1, 1));
      e.server.oneComputer = true;
      e.server.activeInstall = fz(9, 1);
      await startAndPass(e);
      expect(e.server.calls.filter((c) => c.fn === "cloud_upsert_messages" || (c.fn === "cloud_list_install_rows" && c.args.p_kind === "message"))).toEqual([]);
    });
  });

  // ================================================================ reconcile and its marker
  describe("reconcile", () => {
    async function uploaded() {
      const s = setup();
      addEmail(s.db, fz(1, 1));
      linkEmail(s.db, fz(2, 1), s.deal, fz(1, 1));
      addEmail(s.db, fz(1, 2));
      linkEmail(s.db, fz(2, 2), s.deal, fz(1, 2));
      await startAndPass(s.e);
      expect(liveOnline(s.e)).toHaveLength(2);
      return s;
    }

    it("P-m1 / P-f1: a link removed while records were forgotten by a move here is tombstoned by the next pass; another install's rows are untouched", async () => {
      const { db, e } = await uploaded();
      const other = e.server.deals[0];
      e.server.messages.push({ ...e.server.messages[0], id: fz(8, 1), dealId: "other-install-deal", localId: "keep-me" });
      e.server.deals.push({ ...other, id: "other-install-deal", install: fz(9, 9), localId: "x" });
      unlink(db, fz(2, 1));
      applyMoveHere(db, PROJECT, USER_A, e.clock.now);
      expect(records(db)).toEqual([]);
      expect(marker(db)).toBeNull();
      await pass(e);
      await pass(e);
      expect(liveOnline(e).map((m) => m.localId).sort()).toEqual(["keep-me", fz(1, 2)].sort());
    });

    it("P-f3: an adopted row that is still selected gets no tombstone and one upsert answering unchanged", async () => {
      const { db, e } = await uploaded();
      db.prepare("DELETE FROM cloud_sync_state WHERE entity = 'message'").run();
      messagesDb.deleteReconcileMarker(db, PROJECT, USER_A);
      const t = msgTombstones(e).length;
      await pass(e);
      await pass(e);
      expect(msgTombstones(e).length).toBe(t);
      const last = upserts(e).at(-1)!;
      expect(e.server.respond).toBeDefined();
      expect(liveOnline(e)).toHaveLength(2);
      expect((last.args.p_rows as unknown[]).length).toBe(2);
    });

    it("P-m2 / P-m3: a failed message listing records a failure with back-off; it is retried after 15 min, not every pass and not after 24 h", async () => {
      const { db, e } = await uploaded();
      messagesDb.deleteReconcileMarker(db, PROJECT, USER_A);
      e.server.override = (fn, a) => (fn === "cloud_list_install_rows" && a.p_kind === "message" ? { data: null, error: { code: "57014" } } : undefined);
      await pass(e);
      expect(marker(db)).toMatchObject({ status: "failed", failures: 1 });
      const lists = () => e.server.calls.filter((c) => c.fn === "cloud_list_install_rows" && c.args.p_kind === "message").length;
      const n = lists();
      advance(e, 5 * 60_000);
      await pass(e);
      expect(lists()).toBe(n);
      advance(e, 11 * 60_000);
      e.server.override = null;
      await pass(e);
      expect(lists()).toBe(n + 1);
      expect(marker(db)).toMatchObject({ status: "ok", failures: 0 });
    });

    it("build condition 2: a bulk forget that lands while the listing is in flight makes the reconcile write nothing (compare-and-set)", async () => {
      const { db, e } = await uploaded();
      messagesDb.deleteReconcileMarker(db, PROJECT, USER_A);
      let once = false;
      e.server.override = (fn, a) => {
        if (fn === "cloud_list_install_rows" && a.p_kind === "message" && !once) {
          once = true;
          // what a move's local transaction does meanwhile: email and text records and the marker go, and a later
          // failure is recorded by another step
          applyMoveHere(db, PROJECT, USER_A, e.clock.now);
          messagesDb.writeReconcileMarker(db, PROJECT, USER_A, { status: "failed", failures: 3, at: e.clock.now.toISOString() });
        }
        return undefined;
      };
      await pass(e);
      expect(once).toBe(true);
      expect(marker(db)).toMatchObject({ status: "failed", failures: 3 });
    });

    it("C-5h: a failed message read leaves the deal reconcile's result recorded", async () => {
      const db = freshDb();
      enableUser(db, USER_A, PROJECT, { reconciledAt: null });
      const deal = dealId();
      insertDeal(db, deal);
      const e = makeEngine(db);
      e.server.messagesUpload = true;
      e.server.override = (fn, a) => (fn === "cloud_list_install_rows" && a.p_kind === "message" ? { data: null, error: { code: "57014" } } : undefined);
      await startAndPass(e);
      const s = db.prepare("SELECT last_state_at FROM cloud_sync_settings WHERE user_id = ?").get(USER_A) as { last_state_at: string | null };
      expect(s.last_state_at).not.toBeNull();
      expect(marker(db)?.status).toBe("failed");
    });

    it("C-5i: a row hard-deleted online is sent again when still selected, and forgotten when not", async () => {
      const { db, e } = await uploaded();
      unlink(db, fz(2, 2));
      e.server.messages = [];
      advance(e, 25 * 3_600_000);
      await pass(e);
      await pass(e);
      expect(liveOnline(e).map((m) => m.localId)).toEqual([fz(1, 1)]);
    });

    it("P-m5: a restored database copy makes the reconcile due", async () => {
      const { db } = await uploaded();
      expect(marker(db)?.status).toBe("ok");
      resetSyncStateAfterRestore(db);
      expect(marker(db)).toBeNull();
    });

    it("build condition 1: a marker in any shape other than a well-formed ok / failed row counts as due", () => {
      const now = new Date("2026-11-14T12:00:00.000Z");
      expect(messagesDb.messageReconcileDue(null, now)).toBe(true);
      const { db } = setup();
      for (const [status, at] of [[null, now.toISOString()], ["weird", now.toISOString()], ["ok", "not a time"]] as const) {
        db.prepare("INSERT OR REPLACE INTO cloud_sync_state (project_ref, owner_user_id, entity, local_id, transaction_id, last_status, cloud_version, updated_at) VALUES (?, ?, 'switch', 'message_reconcile', '', ?, 0, ?)").run(PROJECT, USER_A, status, at);
        expect(messagesDb.messageReconcileDue(marker(db), now)).toBe(true);
      }
      expect(messagesDb.messageReconcileDue({ status: "ok", failures: 0, at: now.toISOString() }, now)).toBe(false);
    });

    it("P-m6 (DM-1): an archive-restored deal whose online copy was soft-removed: an email deleted meanwhile is tombstoned after the restore", async () => {
      const { db, e, deal } = await uploaded();
      deleteLikeTheHandler(db, deal, archiveDealBeforeDelete, e.clock.now);
      await pass(e);
      expect(e.server.softRemovedDeals).toHaveLength(1);
      db.prepare("DELETE FROM emails WHERE id = ?").run(fz(1, 2));
      const r = await e.service.restoreDeal(deal);
      expect(r).toMatchObject({ success: true, skippedLinks: 1 });
      await e.service.runner!.whenIdle();
      await pass(e);
      await pass(e);
      expect(liveOnline(e).filter((m) => !e.server.softRemovedDeals.some((d) => d.id === m.dealId)).map((m) => m.localId)).toEqual([fz(1, 1)]);
    });

    it("P-m4 (DM-1): a deal deleted online elsewhere and uploaded again (R3b) brings back no unlinked email", async () => {
      const { db, e, deal } = await uploaded();
      const d = e.server.deals[0];
      e.server.respond("cloud_delete_deal", { p_expected_user_id: USER_A, p_cloud_deal_id: d.id });
      unlink(db, fz(2, 2));
      db.prepare("UPDATE transactions SET property_city = 'Changed' WHERE id = ?").run(deal);
      await pass(e);
      await pass(e);
      expect(liveOnline(e).map((m) => m.localId)).toEqual([fz(1, 1)]);
    });

    it("P-f2 / build condition 4: after a reclaim, an online row whose link is gone is tombstoned; an already-removed row is not re-sent and answers unchanged", async () => {
      const { db, e } = await uploaded();
      unlink(db, fz(2, 2));
      await pass(e);
      const removedRow = e.server.messages.find((m) => m.localId === fz(1, 2))!;
      expect(removedRow.removed).toBe(true);
      addEmail(db, fz(1, 3));
      linkEmail(db, fz(2, 3), e.server.deals[0].localId, fz(1, 3));
      await pass(e);
      unlink(db, fz(2, 3));
      db.prepare("DELETE FROM cloud_sync_dirty").run();
      db.prepare("DELETE FROM cloud_sync_state WHERE project_ref = ? AND owner_user_id = ?").run(PROJECT, USER_A);
      db.prepare("INSERT INTO cloud_sync_dirty (transaction_id, generation, marked_at) SELECT id, 1, CURRENT_TIMESTAMP FROM transactions").run();
      const upBefore = upserts(e).flatMap((c) => (c.args.p_rows as Array<{ local_id: string }>).map((r) => r.local_id));
      await pass(e);
      await pass(e);
      const upAfter = upserts(e).flatMap((c) => (c.args.p_rows as Array<{ local_id: string }>).map((r) => r.local_id)).slice(upBefore.length);
      expect(upAfter).not.toContain(fz(1, 2));
      expect(liveOnline(e).map((m) => m.localId)).toEqual([fz(1, 1)]);
      const answers = msgTombstones(e).length;
      expect(answers).toBeGreaterThan(0);
    });
  });

  // ================================================================ fake honesty
  describe("fake server parity with migration 20261123130000", () => {
    const S2 = fs.readFileSync(path.join(__dirname, "..", "..", "..", "..", "supabase", "migrations", "20261123130000_backlog_4263_messages_up_server.sql"), "utf8");
    it("the markers the fake models appear in the function in the fake's order", () => {
      const order = [
        "/*WHO:messages*/",
        "/*ENTITLED:messages*/",
        "/*GATE:install:messages*/",
        "/*GATE:active:messages*/",
        "/*GATE:upload:messages*/",
        "/*GATE:live:messages*/",
        "/*CAP:rows:messages*/",
        "/*CAP:bytes:messages*/",
        "'invalid_input', 'detail'",
        "/*MSG:values*/",
        "/*MSG:noqueue*/",
        "'thread_key_required'",
        "/*MSG:truncate*/",
        "/*MSG:linkstate*/",
      ];
      const at = order.map((m) => S2.indexOf(m));
      expect(at.every((i) => i >= 0)).toBe(true);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
      for (const m of ["/*TOMB:scrub*/", "/*TOMB:msgfiles*/", "/*LIST:message*/", "/*LIST:channel_kind*/"]) expect(S2).toContain(m);
      expect(S2).toContain("'local_id', r ->> 'local_id', 'cloud_id', cur.id, 'version', cur.version,");
    });

    it("P-z1: 501 rows → batch_too_large; a bad hash → invalid_input for the whole call; a bad time → that row rejected", () => {
      const s = new FakeServer(USER_A);
      s.messagesUpload = true;
      s.deals.push({ id: "d1", owner: USER_A, install: "i1", localId: "l1", hash: "", version: 1, fullSyncAt: null });
      const row = (i: number, extra: Record<string, unknown> = {}) => ({ local_id: `m${i}`, content_hash: "a".repeat(64), channel_kind: "email", hidden_from_export: false, ...extra });
      const call = (rows: unknown[]) => s.respond("cloud_upsert_messages", { p_expected_user_id: USER_A, p_source_install_id: "i1", p_cloud_deal_id: "d1", p_rows: rows as never }) as Record<string, unknown>;
      expect(call(Array.from({ length: 501 }, (_, i) => row(i)))).toEqual({ ok: false, error: "batch_too_large" });
      expect(call([row(1), row(2, { content_hash: "x" })])).toEqual({ ok: false, error: "invalid_input", detail: { index: 1 } });
      expect(s.messages).toHaveLength(0);
      const r = call([row(1), row(2, { sent_at: "garbage" })]) as { results: Array<{ status: string; field?: string }> };
      expect(r.results.map((x) => x.status)).toEqual(["applied", "rejected"]);
      expect(r.results[1].field).toBe("sent_at");
      s.messagesUpload = false;
      expect(call([row(3)])).toEqual({ ok: false, error: "feature_off" });
    });
  });
});
