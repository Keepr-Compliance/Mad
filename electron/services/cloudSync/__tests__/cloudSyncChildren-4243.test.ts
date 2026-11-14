/**
 * @jest-environment node
 *
 * BACKLOG-4243 PR-3 — people, checklists and items: DTO, triggers, upload,
 * tombstones, repairs, the daily reconcile, and the Settings online-copy lines.
 * Fake server envelopes: helpers/fakeServer.ts (transcribed from the contract SQL).
 */
import { DRIVER, type TestDb } from "./helpers/sqlite";
import {
  dealId,
  dirty,
  dirtyCount,
  enableUser,
  freshDb,
  insertChecklist,
  insertContact,
  insertDeal,
  insertEmail,
  insertItem,
  insertParty,
  insertPhone,
  insertSourceLink,
  PROJECT,
  USER_A,
  USER_B,
} from "./helpers/fixtures";
import { makeEngine, pass, startAndPass, type Engine } from "./helpers/engine";
import { buildChecklistDto, buildItemDto, buildPartyDto, CHECKLIST_SOURCE_COLUMNS, ITEM_SOURCE_COLUMNS, PARTY_CONTACT_COLUMNS, PARTY_ROW_COLUMNS, projectChild, type PartySource } from "../projection";
import { jcs } from "../jcs";
import { prepareRestoredFile } from "../../db/cloudSyncTriggers";
import type { RpcTransport } from "../cloudClient";

function states(db: TestDb, entity?: string) {
  return (
    db.prepare("SELECT entity, local_id, transaction_id, cloud_id, content_hash, removed, last_status FROM cloud_sync_state ORDER BY entity, local_id").all() as Array<{
      entity: string;
      local_id: string;
      transaction_id: string;
      cloud_id: string | null;
      content_hash: string | null;
      removed: number;
      last_status: string | null;
    }>
  ).filter((s) => !entity || s.entity === entity);
}

function setTransport(e: Engine, t: RpcTransport): void {
  (e.service as unknown as { deps: { client: { transport: RpcTransport } } }).deps.client.transport = t;
}

const fns = (e: Engine) => e.server.writeCalls().map((c) => c.fn);

/** One deal with two people (one from Google), one checklist and two items. */
function dealWithChildren(opts: { reconciled?: boolean } = {}) {
  const db = freshDb();
  enableUser(db, USER_A, PROJECT, opts.reconciled === false ? { reconciledAt: null } : {});
  const id = dealId();
  insertDeal(db, id);
  insertContact(db, "ct-1", USER_A, { display_name: "Pat Example", company: "Example Co" });
  insertEmail(db, "em-1", "ct-1", "pat@example.test", 1);
  insertPhone(db, "ph-1", "ct-1", "+15555550101", 1);
  insertContact(db, "ct-2", USER_A, { display_name: "Gee Example", source: "manual" });
  insertSourceLink(db, "sl-2", "ct-2", "google_contacts");
  insertEmail(db, "em-2", "ct-2", "gee@example.test");
  insertParty(db, "pt-1", id, "ct-1");
  insertParty(db, "pt-2", id, "ct-2", { role: "seller_agent", notes: "Typed on the deal" });
  insertChecklist(db, "cl-1", id);
  insertItem(db, "it-1", "cl-1", "Inspection");
  insertItem(db, "it-2", "cl-1", "Appraisal");
  return { db, id, e: makeEngine(db) };
}

describe(`Keepr Cloud children [${DRIVER}]`, () => {
  // ================================================================ DTO
  describe("party DTO (P3-1..P3-4)", () => {
    const base: PartySource = {
      row: { id: "pt", contact_id: "ct", role: "buyer", role_category: "client", specific_role: null, is_primary: 1, notes: "n" },
      contact: { id: "ct", display_name: "Pat", company: "Co", source: "manual", removed_at: null, removed_reason: null },
      emails: [{ id: "e2", contact_id: "ct", email: "B@example.test", is_primary: 0, label: null }, { id: "e1", contact_id: "ct", email: "a@example.test", is_primary: 1, label: "work" }],
      phones: [{ id: "p1", contact_id: "ct", phone_e164: "+15555550101", phone_display: "(555) 555-0101", is_primary: 0, label: null }],
      sourceTypes: [],
    };

    it("details_withheld is always present and hashed; false when not from Google", () => {
      const dto = buildPartyDto(base);
      expect(dto.details_withheld).toBe(false);
      expect(dto.display_name).toBe("Pat");
      expect(dto.emails).toEqual([
        { email: "a@example.test", is_primary: true, label: "work" },
        { email: "B@example.test", is_primary: false, label: null },
      ]);
      expect(dto.local_contact_id).toBe("ct");
    });

    it("withheld (contact source google_contacts OR a google_contacts link): blanked BEFORE hashing, the flag alone changes the hash", () => {
      const viaLink = buildPartyDto({ ...base, sourceTypes: ["google_contacts"] });
      const viaSource = buildPartyDto({ ...base, contact: { ...base.contact!, source: "google_contacts" } });
      for (const dto of [viaLink, viaSource]) {
        expect(dto).toMatchObject({ details_withheld: true, display_name: null, company: null, emails: [], phones: [], notes: "n", role: "buyer", local_contact_id: "ct" });
      }
      expect(viaSource.contact_source).toBe("google_contacts");
      expect(viaLink.contact_source).toBe("manual");
      // Flipping only the flag (same blanked fields) changes the hash.
      const blankedNotWithheld = { ...viaLink, details_withheld: false };
      expect(jcs(viaLink)).not.toBe(jcs(blankedNotWithheld));
      expect(projectChild("party", "pt", viaLink).hash).not.toBe(projectChild("party", "pt", blankedNotWithheld).hash);
      // What is sent is exactly what is hashed.
      const p = projectChild("party", "pt", viaLink);
      const { local_id: _l, content_hash: _h, ...sent } = p.payload;
      expect(jcs(sent)).toBe(jcs(viaLink));
    });

    it("§3.2 order: emails by primary, then lower(email), then id; phones by primary, then e164, then id", () => {
      const dto = buildPartyDto({
        ...base,
        emails: [
          { id: "e-a", contact_id: "ct", email: "zed@example.test", is_primary: 0, label: null },
          { id: "e-b", contact_id: "ct", email: "Amy@example.test", is_primary: 0, label: null },
          { id: "e-c", contact_id: "ct", email: "amy@example.test", is_primary: 0, label: null },
        ],
        phones: [
          { id: "p-a", contact_id: "ct", phone_e164: "+15555550199", phone_display: null, is_primary: 0, label: null },
          { id: "p-b", contact_id: "ct", phone_e164: "+15555550100", phone_display: null, is_primary: 0, label: null },
        ],
      });
      expect((dto.emails as Array<{ email: string }>).map((e) => e.email)).toEqual(["Amy@example.test", "amy@example.test", "zed@example.test"]);
      expect((dto.phones as Array<{ e164: string }>).map((p) => p.e164)).toEqual(["+15555550100", "+15555550199"]);
    });

    it("a deleted contact: contact_deleted true, local_contact_id still sent", () => {
      const dto = buildPartyDto({ ...base, contact: null, emails: [], phones: [] });
      expect(dto).toMatchObject({ contact_deleted: true, local_contact_id: "ct", display_name: null });
    });

    it("party vector (desktop-defined; the prebuild vector predates details_withheld)", () => {
      expect(projectChild("party", "pt", buildPartyDto(base)).hash).toBe("64987b1ff7c2e8111db35ccbb9a672659092f355fd39a0ebf565b72f4681e22c");
      expect(jcs(buildPartyDto(base))).toBe(
        '{"company":"Co","contact_deleted":false,"contact_source":"manual","details_withheld":false,"display_name":"Pat","emails":[{"email":"a@example.test","is_primary":true,"label":"work"},{"email":"B@example.test","is_primary":false,"label":null}],"is_primary":true,"local_contact_id":"ct","notes":"n","phones":[{"display":"(555) 555-0101","e164":"+15555550101","is_primary":false,"label":null}],"removed_reason":null,"role":"buyer","role_category":"client","specific_role":null}',
      );
    });

    it("drift: every column the child projections read is in their trigger source lists", () => {
      const reads = (fn: (r: Record<string, unknown>) => unknown, row: Record<string, unknown>) => {
        const seen = new Set<string>();
        fn(new Proxy(row, { get: (t, k) => (typeof k === "string" && seen.add(k), t[k as string]) }));
        return seen;
      };
      for (const k of reads((r) => buildChecklistDto(r), { template_id: "t" })) expect(CHECKLIST_SOURCE_COLUMNS as readonly string[]).toContain(k);
      for (const k of reads((r) => buildItemDto(r), {})) expect(ITEM_SOURCE_COLUMNS as readonly string[]).toContain(k);
      for (const k of reads((r) => buildPartyDto({ ...base, row: r }), {})) expect(PARTY_ROW_COLUMNS as readonly string[]).toContain(k);
      for (const k of reads((c) => buildPartyDto({ ...base, contact: c }), {})) expect([...PARTY_CONTACT_COLUMNS, "id"]).toContain(k);
    });
  });

  // ================================================================ triggers
  describe("child triggers", () => {
    function markedAfter(db: TestDb, id: string, write: () => void): boolean {
      db.exec("DELETE FROM cloud_sync_dirty");
      write();
      return dirty(db).some((d) => d.transaction_id === id);
    }
    it("every writer of a person or a child row marks the deal; a no-op source rewrite does not", () => {
      const { db, id } = dealWithChildren();
      expect(markedAfter(db, id, () => db.prepare("UPDATE contacts SET display_name = 'Renamed' WHERE id = 'ct-1'").run())).toBe(true);
      expect(markedAfter(db, id, () => db.prepare("UPDATE contacts SET company = 'X' WHERE id = 'ct-1'").run())).toBe(true);
      expect(markedAfter(db, id, () => db.prepare("UPDATE contacts SET source = 'contacts_app' WHERE id = 'ct-1'").run())).toBe(true);
      expect(markedAfter(db, id, () => db.prepare("UPDATE contacts SET source = 'contacts_app' WHERE id = 'ct-1'").run())).toBe(false);
      expect(markedAfter(db, id, () => db.prepare("UPDATE contacts SET title = 'Unused' WHERE id = 'ct-1'").run())).toBe(false);
      expect(markedAfter(db, id, () => insertEmail(db, "em-9", "ct-1", "new@example.test"))).toBe(true);
      expect(markedAfter(db, id, () => db.prepare("UPDATE contact_emails SET label = 'home' WHERE id = 'em-9'").run())).toBe(true);
      expect(markedAfter(db, id, () => db.prepare("DELETE FROM contact_emails WHERE id = 'em-9'").run())).toBe(true);
      expect(markedAfter(db, id, () => insertPhone(db, "ph-9", "ct-1", "+15555550199"))).toBe(true);
      expect(markedAfter(db, id, () => db.prepare("DELETE FROM contact_phones WHERE id = 'ph-9'").run())).toBe(true);
      expect(markedAfter(db, id, () => insertSourceLink(db, "sl-9", "ct-1", "google_contacts"))).toBe(true);
      expect(markedAfter(db, id, () => db.prepare("DELETE FROM contact_source_links WHERE id = 'sl-9'").run())).toBe(true);
      expect(markedAfter(db, id, () => db.prepare("UPDATE transaction_contacts SET notes = 'x' WHERE id = 'pt-1'").run())).toBe(true);
      expect(markedAfter(db, id, () => db.prepare("UPDATE transaction_checklist_items SET note = 'x' WHERE id = 'it-1'").run())).toBe(true);
      expect(markedAfter(db, id, () => db.prepare("UPDATE transaction_checklists SET template_name = 'y' WHERE id = 'cl-1'").run())).toBe(true);
    });

    it("a person moved between deals marks both deals", () => {
      const { db, id } = dealWithChildren();
      const other = dealId();
      insertDeal(db, other);
      db.exec("DELETE FROM cloud_sync_dirty");
      db.prepare("UPDATE transaction_contacts SET transaction_id = ? WHERE id = 'pt-1'").run(other);
      expect(dirty(db).map((d) => d.transaction_id).sort()).toEqual([id, other].sort());
    });

    it("Cloud never enabled: no child or contact write marks anything", () => {
      const db = freshDb();
      const id = dealId();
      insertDeal(db, id);
      insertContact(db, "ct-1");
      insertParty(db, "pt-1", id, "ct-1");
      insertEmail(db, "em-1", "ct-1", "a@example.test");
      insertSourceLink(db, "sl-1", "ct-1", "google_contacts");
      db.prepare("UPDATE contacts SET display_name = 'Z' WHERE id = 'ct-1'").run();
      insertChecklist(db, "cl-1", id);
      insertItem(db, "it-1", "cl-1");
      expect(dirtyCount(db)).toBe(0);
    });
  });

  // ================================================================ upload
  describe("upload", () => {
    it("one pass: header, people, checklists, items, then the mark call last; every row recorded", async () => {
      const { db, e, id } = dealWithChildren();
      await startAndPass(e);
      expect(fns(e)).toEqual(["cloud_upsert_deal", "cloud_upsert_parties", "cloud_upsert_checklists", "cloud_upsert_checklist_items", "cloud_mark_deal_synced"]);
      const parties = e.server.children.filter((c) => c.kind === "party");
      expect(parties).toHaveLength(2);
      const google = parties.find((p) => p.localId === "pt-2")!;
      expect(google.withheld).toBe(true);
      expect(google.row).toMatchObject({ display_name: null, company: null, emails: [], phones: [], notes: "Typed on the deal", details_withheld: true });
      expect(parties.find((p) => p.localId === "pt-1")!.row).toMatchObject({ display_name: "Pat Example", details_withheld: false });
      expect(states(db).map((s) => `${s.entity}:${s.local_id}:${s.last_status}`)).toEqual([
        "checklist:cl-1:saved",
        "checklist_item:it-1:saved",
        "checklist_item:it-2:saved",
        `deal:${id}:synced`,
        "party:pt-1:saved",
        "party:pt-2:saved",
      ]);
      expect(dirtyCount(db)).toBe(0);
    });

    it("a child change after a full save sends only that child and the mark call; the header is not resent", async () => {
      const { db, e } = dealWithChildren();
      await startAndPass(e);
      const before = e.server.writeCalls().length;
      db.prepare("UPDATE transaction_checklist_items SET note = 'Booked' WHERE id = 'it-2'").run();
      await pass(e);
      const sent = e.server.writeCalls().slice(before);
      expect(sent.map((c) => c.fn)).toEqual(["cloud_upsert_checklist_items", "cloud_mark_deal_synced"]);
      expect((sent[0].args.p_rows as Array<{ local_id: string }>).map((r) => r.local_id)).toEqual(["it-2"]);
    });

    it("R3: a rejected person keeps the deal not saved: no mark call, accepted rows recorded, the deal counted as not saved", async () => {
      const { db, e, id } = dealWithChildren();
      const real = e.server.transport;
      setTransport(e, async (f, a, s) => {
        const r = await real(f, a, s);
        if (f !== "cloud_upsert_parties") return r;
        const body = r.data as { ok: boolean; results: Array<Record<string, unknown>> };
        body.results = body.results.map((x) => (x.local_id === "pt-1" ? { local_id: "pt-1", status: "rejected", reason: "invalid_value" } : x));
        return r;
      });
      await startAndPass(e);
      expect(e.server.callsTo("cloud_mark_deal_synced")).toHaveLength(0);
      expect(states(db, "party").map((s) => s.local_id)).toEqual(["pt-2"]);
      expect(states(db, "deal")[0].last_status).toBe("saved");
      expect(dirty(db)[0]).toMatchObject({ transaction_id: id, last_error_code: "row_not_saved" });
      expect((await e.service.getView()).notSavedDeals).toBe(1);
    });

    it("R2 for children: a child answer with a different hash is not saved and no mark call is made", async () => {
      const { db, e } = dealWithChildren();
      const real = e.server.transport;
      setTransport(e, async (f, a, s) => {
        const r = await real(f, a, s);
        if (f !== "cloud_upsert_checklists") return r;
        const body = r.data as { results: Array<Record<string, unknown>> };
        body.results = body.results.map((x) => ({ ...x, content_hash: "0".repeat(64) }));
        return r;
      });
      await startAndPass(e);
      expect(states(db, "checklist")).toHaveLength(0);
      expect(e.server.callsTo("cloud_mark_deal_synced")).toHaveLength(0);
    });

    it("§8.4b: an item whose checklist is missing online is repaired by sending the checklist again", async () => {
      const { db, e } = dealWithChildren();
      await startAndPass(e);
      // The checklist disappears online (another computer), items stay referenced locally.
      e.server.children = e.server.children.filter((c) => c.kind !== "checklist");
      db.prepare("UPDATE transaction_checklist_items SET note = 'Again' WHERE id = 'it-1'").run();
      const before = e.server.writeCalls().length;
      await pass(e);
      expect(e.server.writeCalls().slice(before).map((c) => c.fn)).toEqual([
        "cloud_upsert_checklist_items",
        "cloud_upsert_checklists",
        "cloud_upsert_checklist_items",
        "cloud_mark_deal_synced",
      ]);
      expect(dirtyCount(db)).toBe(0);
    });

    it("tombstones: a removed person, a deleted checklist (its items with it) are removed online exactly once", async () => {
      const { db, e } = dealWithChildren();
      await startAndPass(e);
      db.prepare("UPDATE transaction_contacts SET removed_at = CURRENT_TIMESTAMP WHERE id = 'pt-1'").run();
      db.prepare("DELETE FROM transaction_checklists WHERE id = 'cl-1'").run();
      await pass(e);
      const tomb = e.server.callsTo("cloud_tombstone").map((c) => `${c.args.p_kind}:${(c.args.p_cloud_ids as string[]).length}`);
      expect(tomb).toEqual(["checklist_item:2", "checklist:1", "party:1"]);
      expect(e.server.children.filter((c) => c.removed).map((c) => c.localId).sort()).toEqual(["cl-1", "it-1", "it-2", "pt-1"]);
      expect(states(db).filter((s) => s.removed === 1).map((s) => s.local_id).sort()).toEqual(["cl-1", "it-1", "it-2", "pt-1"]);
      const v = e.server.children.find((c) => c.localId === "pt-1")!.version;
      await pass(e);
      db.prepare("INSERT INTO cloud_sync_dirty (transaction_id, generation, marked_at) SELECT id, 1, 'x' FROM transactions").run();
      await pass(e);
      expect(e.server.callsTo("cloud_tombstone")).toHaveLength(3);
      expect(e.server.children.find((c) => c.localId === "pt-1")!.version).toBe(v);
    });

    it("tombstone committed online, process dies before the local record: the next pass repairs it once", async () => {
      const { db, e } = dealWithChildren();
      await startAndPass(e);
      db.prepare("UPDATE transaction_contacts SET removed_at = CURRENT_TIMESTAMP WHERE id = 'pt-1'").run();
      const real = e.server.transport;
      let died = false;
      setTransport(e, async (f, a, s) => {
        if (f === "cloud_tombstone" && !died) {
          died = true;
          await real(f, a, s);
          throw new Error("process died");
        }
        return real(f, a, s);
      });
      await pass(e);
      expect(states(db, "party").find((s) => s.local_id === "pt-1")!.removed).toBe(0);
      db.prepare("UPDATE cloud_sync_dirty SET next_attempt_at = NULL").run();
      await pass(e);
      expect(states(db, "party").find((s) => s.local_id === "pt-1")!.removed).toBe(1);
      expect(e.server.children.find((c) => c.localId === "pt-1")!.version).toBe(2);
      expect(dirtyCount(db)).toBe(0);
    });

    it("a person moved to another deal: the old online copy is tombstoned before the new deal's upsert (new deal processed first)", async () => {
      const { db, e, id } = dealWithChildren();
      const other = dealId();
      insertDeal(db, other);
      await startAndPass(e);
      const oldCloud = states(db, "party").find((s) => s.local_id === "pt-1")!.cloud_id!;
      db.prepare("UPDATE transaction_contacts SET transaction_id = ? WHERE id = 'pt-1'").run(other);
      // Process the new deal first.
      db.prepare("UPDATE cloud_sync_dirty SET marked_at = CASE WHEN transaction_id = ? THEN '1' ELSE '2' END").run(other);
      const before = e.server.writeCalls().length;
      await pass(e);
      const seq = e.server.writeCalls().slice(before).map((c) => `${c.fn}${c.args.p_kind ? `:${c.args.p_kind}` : ""}`);
      expect(seq.indexOf("cloud_tombstone:party")).toBeLessThan(seq.indexOf("cloud_upsert_parties"));
      expect(e.server.children.find((c) => c.id === oldCloud)!.removed).toBe(true);
      const now = e.server.children.filter((c) => c.localId === "pt-1" && !c.removed);
      expect(now).toHaveLength(1);
      expect(e.server.deals.find((d) => d.id === now[0].dealId)!.localId).toBe(other);
      expect(states(db, "party").find((s) => s.local_id === "pt-1")!.transaction_id).toBe(other);
      expect(dirty(db).map((d) => d.transaction_id)).not.toContain(id);
    });

    it("D-2: an integrity error (SQLSTATE 23514) on a people call is parked after one call; no second call in three passes", async () => {
      const { db, e } = dealWithChildren();
      e.server.override = (fn) => (fn === "cloud_upsert_parties" ? { data: null, error: { code: "23514" }, status: 400 } : undefined);
      await startAndPass(e);
      for (let i = 0; i < 3; i++) await pass(e);
      expect(e.server.callsTo("cloud_upsert_parties")).toHaveLength(1);
      expect(dirty(db)[0].last_error_code).toBe("23514");
      expect((await e.service.getView()).notSavedDeals).toBe(1);
    });

    it("D-2 control: a transient code (40001) is retried with back-off, not parked", async () => {
      const { db, e } = dealWithChildren();
      e.server.override = (fn) => (fn === "cloud_upsert_parties" ? { data: null, error: { code: "40001" }, status: 500 } : undefined);
      await startAndPass(e);
      expect(dirty(db)[0].next_attempt_at).toBe("2026-11-14T12:01:00.000Z");
    });
  });

  // ================================================================ reconcile
  describe("daily reconcile", () => {
    it("reads only through cloud_list_install_rows, then a deal deleted online elsewhere is uploaded again (hash forgotten, not only marked)", async () => {
      const { db, e } = dealWithChildren();
      await startAndPass(e);
      e.server.deals = [];
      e.server.children = [];
      db.prepare("UPDATE cloud_sync_settings SET last_state_at = NULL").run();
      await pass(e);
      const reads = e.server.calls.filter((c) => c.fn.startsWith("cloud_list"));
      expect([...new Set(reads.map((c) => c.fn))]).toEqual(["cloud_list_install_rows"]);
      expect(reads.map((c) => c.args.p_kind)).toEqual(["deal", "party", "checklist", "checklist_item"]);
      expect(e.server.deals).toHaveLength(1);
      expect(e.server.children).toHaveLength(5);
      expect(states(db, "deal")[0].last_status).toBe("synced");
    });

    it("a person removed online elsewhere is sent again", async () => {
      const { db, e } = dealWithChildren();
      await startAndPass(e);
      e.server.children.find((c) => c.localId === "pt-1")!.removed = true;
      db.prepare("UPDATE cloud_sync_settings SET last_state_at = NULL").run();
      await pass(e);
      expect(e.server.children.find((c) => c.localId === "pt-1")!.removed).toBe(false);
    });

    it("a deal synced before people and checklists were uploaded (header only) gets its children", async () => {
      const { db, e, id } = dealWithChildren();
      // A PR-2 era record: the header synced, no child records, no mark.
      e.server.override = (fn) => (fn.startsWith("cloud_upsert_") && fn !== "cloud_upsert_deal" ? { data: { ok: true, results: [] }, error: null } : undefined);
      await startAndPass(e);
      e.server.override = null;
      db.exec("DELETE FROM cloud_sync_state WHERE entity <> 'deal'");
      db.prepare("UPDATE cloud_sync_state SET last_status = 'synced'").run();
      db.exec("DELETE FROM cloud_sync_dirty");
      db.prepare("UPDATE cloud_sync_settings SET last_state_at = NULL").run();
      await pass(e);
      expect(e.server.children.filter((c) => c.dealId === e.server.deals[0].id && !c.removed)).toHaveLength(5);
      expect(dirty(db).map((d) => d.transaction_id)).not.toContain(id);
    });

    it("an online deal with no local record is never deleted automatically; it is shown, and deleted only on the user's click", async () => {
      const { db, e } = dealWithChildren();
      await startAndPass(e);
      const install = (e.server.deals[0]).install;
      e.server.deals.push({ id: "cloud-orphan-1", owner: USER_A, install, localId: "gone-local", hash: "h", version: 1, fullSyncAt: null });
      db.prepare("UPDATE cloud_sync_settings SET last_state_at = NULL").run();
      await pass(e);
      expect(e.server.deals.map((d) => d.id)).toContain("cloud-orphan-1");
      expect(e.server.callsTo("cloud_delete_deal")).toHaveLength(0);
      expect((await e.service.getView()).onlineNotHereDeals).toBe(1);
      expect(await e.service.deleteOnlineNotHere()).toEqual({ success: true });
      expect(e.server.deals.map((d) => d.id)).not.toContain("cloud-orphan-1");
      expect(e.server.deals).toHaveLength(1);
      expect((await e.service.getView()).onlineNotHereDeals).toBe(0);
    });

    function withUploadedDeals(n: number) {
      const db = freshDb();
      enableUser(db);
      const ids = Array.from({ length: n }, () => dealId());
      ids.forEach((i) => insertDeal(db, i));
      return { db, ids, e: makeEngine(db) };
    }

    it("a deal deleted locally without a mark is deleted online by the next reconcile (it has a local record)", async () => {
      const { db, ids, e } = withUploadedDeals(2);
      await startAndPass(e);
      db.prepare("UPDATE cloud_sync_settings SET enabled = 0").run();
      db.prepare("DELETE FROM transactions WHERE id = ?").run(ids[0]);
      db.prepare("UPDATE cloud_sync_settings SET enabled = 1, last_state_at = NULL").run();
      expect(dirtyCount(db)).toBe(0);
      const next = makeEngine(db, { server: e.server }); // a later launch
      await startAndPass(next);
      expect(e.server.deals.map((d) => d.localId)).toEqual([ids[1]]);
    });

    it("guards: no reconcile delete when every local deal is gone but the server holds some", async () => {
      const { db, ids, e } = withUploadedDeals(2);
      await startAndPass(e);
      db.prepare("UPDATE cloud_sync_settings SET enabled = 0").run();
      for (const i of ids) db.prepare("DELETE FROM transactions WHERE id = ?").run(i);
      db.prepare("UPDATE cloud_sync_settings SET enabled = 1, last_state_at = NULL").run();
      await startAndPass(makeEngine(db, { server: e.server }));
      expect(e.server.deals).toHaveLength(2);
    });

    it("guards: no reconcile delete in a launch that created the install row", async () => {
      const { db, ids, e } = withUploadedDeals(2);
      await startAndPass(e);
      db.prepare("UPDATE cloud_sync_settings SET enabled = 0").run();
      db.prepare("DELETE FROM transactions WHERE id = ?").run(ids[0]);
      db.prepare("UPDATE cloud_sync_settings SET enabled = 1, last_state_at = NULL").run();
      (e.service as unknown as { installCreatedThisLaunch: boolean }).installCreatedThisLaunch = true;
      await pass(e);
      expect(e.server.deals).toHaveLength(2);
    });

    it("cap: 30 deletes found, at most max(10, 10%) per run, the rest the next day", async () => {
      const { db, ids, e } = withUploadedDeals(40);
      await startAndPass(e);
      db.prepare("UPDATE cloud_sync_settings SET enabled = 0").run();
      for (const i of ids.slice(0, 30)) db.prepare("DELETE FROM transactions WHERE id = ?").run(i);
      db.prepare("UPDATE cloud_sync_settings SET enabled = 1, last_state_at = NULL").run();
      const next = makeEngine(db, { server: e.server });
      await startAndPass(next);
      expect(e.server.deals).toHaveLength(30);
      expect(next.logs.some((l) => l.message.includes("deletes deferred") && l.meta?.deferred === 20)).toBe(true);
    });

    it("parked deals are retried after the reconcile", async () => {
      const { db, e } = dealWithChildren();
      e.server.override = (fn) => (fn === "cloud_upsert_parties" ? { data: { ok: false, error: "zz_future" }, error: null } : undefined);
      await startAndPass(e);
      expect((await e.service.getView()).notSavedDeals).toBe(1);
      e.server.override = null;
      db.prepare("UPDATE cloud_sync_settings SET last_state_at = NULL").run();
      await pass(e);
      expect(dirtyCount(db)).toBe(0);
      expect(e.server.callsTo("cloud_mark_deal_synced")).toHaveLength(1);
    });

    it("kill point: a list call fails part-way → no local write; the next run completes", async () => {
      const { db, e } = dealWithChildren();
      await startAndPass(e);
      e.server.deals = [];
      e.server.children = [];
      db.prepare("UPDATE cloud_sync_settings SET last_state_at = NULL").run();
      let n = 0;
      e.server.override = (fn) => (fn === "cloud_list_install_rows" && ++n === 2 ? new Error("network") : undefined);
      const stateBefore = JSON.stringify(states(db));
      await pass(e);
      expect(JSON.stringify(states(db))).toBe(stateBefore);
      expect(dirtyCount(db)).toBe(0);
      e.server.override = null;
      e.clock.now = new Date("2026-11-14T12:20:00.000Z");
      await pass(e);
      expect(e.server.deals).toHaveLength(1);
    });

    it("kill point: the process dies after the reconcile's local transaction → the marks are there and the next pass sends", async () => {
      const { db, e } = dealWithChildren();
      await startAndPass(e);
      e.server.deals = [];
      e.server.children = [];
      db.prepare("UPDATE cloud_sync_settings SET last_state_at = NULL").run();
      const runner = e.service.runner as unknown as { reconcile: (...a: unknown[]) => Promise<unknown> };
      const realReconcile = runner.reconcile.bind(e.service.runner);
      runner.reconcile = async (...a: unknown[]) => {
        await realReconcile(...a);
        throw new Error("process died");
      };
      await e.service.kick().catch(() => undefined);
      expect(dirtyCount(db)).toBe(1);
      expect(states(db, "deal")[0].content_hash).toBeNull();
      runner.reconcile = realReconcile;
      await pass(e);
      expect(e.server.deals).toHaveLength(1);
    });

    it("single-flight: the user's delete waits for a running pass", async () => {
      const { e } = dealWithChildren();
      const real = e.server.transport;
      let release: () => void = () => undefined;
      const gate = new Promise<void>((r) => (release = r));
      let held = false;
      setTransport(e, async (f, a, s) => {
        if (f === "cloud_mark_deal_synced" && !held) {
          held = true;
          await gate;
        }
        return real(f, a, s);
      });
      e.service.refreshSchedule();
      for (let i = 0; i < 50 && !held; i++) await new Promise((r) => setImmediate(r));
      const del = e.service.deleteOnlineNotHere();
      await new Promise((r) => setImmediate(r));
      expect(e.server.calls.filter((c) => c.fn === "cloud_list_install_rows")).toHaveLength(0);
      release();
      await del;
      const order = e.server.calls.map((c) => c.fn);
      expect(order.indexOf("cloud_mark_deal_synced")).toBeLessThan(order.lastIndexOf("cloud_list_install_rows"));
    });
  });

  // ================================================================ settings, nits
  describe("Settings lines and nits", () => {
    it("other installs idle 30+ days are summed; Delete them removes them (main lists them again)", async () => {
      const { e } = dealWithChildren();
      await startAndPass(e);
      e.server.deals.push(
        { id: "old-1", owner: USER_A, install: "install-old", localId: "x1", hash: "h", version: 1, fullSyncAt: null, lastSyncedAt: "2026-09-01T00:00:00.000Z" },
        { id: "old-2", owner: USER_A, install: "install-old", localId: "x2", hash: "h", version: 1, fullSyncAt: null, lastSyncedAt: "2026-09-03T00:00:00.000Z" },
        { id: "recent", owner: USER_A, install: "install-recent", localId: "x3", hash: "h", version: 1, fullSyncAt: null, lastSyncedAt: "2026-11-10T00:00:00.000Z" },
      );
      expect((await e.service.getView()).otherInstalls).toEqual({ deals: 2, lastSavedAt: "2026-09-03T00:00:00.000Z" });
      expect(await e.service.deleteOldInstalls()).toEqual({ success: true });
      expect(e.server.deals.map((d) => d.id).sort()).toEqual([e.server.deals.find((d) => d.localId !== "x3")!.id, "recent"].sort());
      expect((await e.service.getView()).otherInstalls).toBeNull();
    });

    it("D1: turn-on is refused while a turn-off is still owed", async () => {
      const db = freshDb();
      const e = makeEngine(db);
      db.prepare("INSERT INTO cloud_sync_settings (project_ref, user_id, enabled, turn_off_owed_at) VALUES (?, ?, 0, 'x')").run(PROJECT, USER_A);
      expect(await e.service.turnOn(1)).toEqual({ success: false, error: "turn_off_pending" });
      expect(e.server.callsTo("set_my_cloud_autosave")).toHaveLength(0);
    });

    it("D2: after a restore the install id is read again from the restored file", async () => {
      const { db, e } = dealWithChildren();
      await startAndPass(e);
      db.prepare("UPDATE cloud_sync_install SET install_id = 'restored-install-id'").run();
      prepareRestoredFile(db);
      await pass(e);
      const last = e.server.callsTo("cloud_upsert_deal").at(-1)!;
      expect((last.args.p_deal as Record<string, unknown>).source_install_id).toBe("restored-install-id");
    });

    it("another user's people on a shared profile never block or get sent by this user's pass", async () => {
      const { db, e } = dealWithChildren();
      enableUser(db, USER_B);
      const b = dealId();
      insertDeal(db, b, USER_B);
      insertContact(db, "ct-b", USER_B);
      insertParty(db, "pt-b", b, "ct-b");
      await startAndPass(e);
      expect(e.server.children.map((c) => c.localId)).not.toContain("pt-b");
      expect(dirty(db).map((d) => d.transaction_id)).toEqual([b]);
    });
  });
});
