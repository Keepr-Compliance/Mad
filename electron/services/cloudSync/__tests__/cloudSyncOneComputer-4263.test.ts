/**
 * @jest-environment node
 *
 * BACKLOG-4263 P2 — one computer per account, desktop side (plan §2.5, §11.2, §13.1, §14 D1).
 *
 * Two computers are two databases on one fake server (one account). The server's answers for the one-computer rule
 * (state keys, claim, the writers' gate, the 4-argument turn-off) are transcribed from the merged migration
 * supabase/migrations/20261123100000_backlog_4263_one_computer.sql; see helpers/fakeServer.ts for each line.
 * `server.s1 = false` is a server without that migration (version skew). No network, no Electron.
 */
import { DRIVER, type TestDb } from "./helpers/sqlite";
import { dealId, dirty, freshDb, insertDeal, PROJECT, USER_A } from "./helpers/fixtures";
import { makeEngine, pass, startAndPass, DEVICE_1, type Engine } from "./helpers/engine";
import { FakeServer, READ_FUNCTIONS } from "./helpers/fakeServer";
import { enableForUser, ensureInstall, writeMovePending } from "../../db/cloudSyncDbService";
import { readTodoOutbox } from "../../db/cloudSyncTodoDbService";
import { INSERT_CHECKLIST_ITEM_SQL, INSERT_CHECKLIST_SQL, SET_CHECKLIST_ITEM_NOTE_SQL } from "../../db/checklistSql";

const T0 = Date.parse("2026-11-14T12:00:05.000Z");
const fid = (kind: number, n: number) => `00000000-0000-0000-${String(kind).padStart(4, "0")}-${String(n).padStart(12, "0")}`;

interface Computer {
  db: TestDb;
  e: Engine;
  deals: string[];
  item: string | null;
}

/** One shared fake server (one account) with a movable clock. */
function account(opts: { oneComputer?: boolean; s1?: boolean } = {}) {
  const server = new FakeServer(USER_A);
  server.s1 = opts.s1 ?? true;
  server.oneComputer = opts.oneComputer ?? false;
  const clock = { t: T0 };
  server.serverNow = () => clock.t;
  return { server, clock };
}

let itemSeq = 0;
/** A computer: its own database and engine on the shared server; `on` = Keepr Cloud turned on and confirmed here. */
function computer(server: FakeServer, opts: { on?: boolean; deals?: number; todo?: boolean } = {}): Computer {
  const db = freshDb();
  const deals = Array.from({ length: opts.deals ?? 1 }, () => dealId());
  for (const d of deals) insertDeal(db, d);
  let item: string | null = null;
  if (opts.todo) {
    const n = ++itemSeq;
    const cl = fid(31, n);
    item = fid(41, n);
    db.prepare(INSERT_CHECKLIST_SQL).run(cl, deals[0], "tpl-1", "Purchase", 0);
    db.prepare(INSERT_CHECKLIST_ITEM_SQL).run(item, cl, "Inspection", null, 1, "inspection", 0);
  }
  const e = makeEngine(db, { server });
  if (opts.on) {
    ensureInstall(db, PROJECT, DEVICE_1);
    enableForUser(db, PROJECT, USER_A, { noticeVersion: 1, acceptedAt: "2026-11-01T00:00:00.000Z" });
  }
  return { db, e, deals, item };
}

const installOf = (db: TestDb): string | null =>
  (db.prepare("SELECT install_id FROM cloud_sync_install WHERE project_ref = ?").get(PROJECT) as { install_id: string } | undefined)?.install_id ?? null;

const writesSince = (server: FakeServer, from: number) => server.calls.slice(from).filter((c) => !READ_FUNCTIONS.includes(c.fn));
const fnsSince = (server: FakeServer, from: number) => server.calls.slice(from).map((c) => c.fn);

const settings = (db: TestDb) =>
  db.prepare("SELECT enabled, turn_off_owed_at, local_confirmed_at FROM cloud_sync_settings WHERE project_ref = ? AND user_id = ?").get(PROJECT, USER_A) as
    | { enabled: number; turn_off_owed_at: string | null; local_confirmed_at: string | null }
    | undefined;

const stateRows = (db: TestDb) =>
  (db.prepare("SELECT entity, local_id FROM cloud_sync_state ORDER BY entity, local_id").all() as Array<{ entity: string; local_id: string }>).map(
    (r) => `${r.entity}:${r.local_id}`,
  );

/** Records of what was saved online that P5/P6 write (emails, texts, files) and the messages_upload sentinel (§12.2). */
function seedMessageRecords(db: TestDb, deal: string): void {
  const ins = db.prepare(
    `INSERT INTO cloud_sync_state (project_ref, owner_user_id, entity, local_id, transaction_id, cloud_id, cloud_version, removed, last_status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, '2026-11-14T11:00:00.000Z')`,
  );
  ins.run(PROJECT, USER_A, "message", `${deal}|email|e-1`, deal, fid(51, 1), 1, "saved");
  ins.run(PROJECT, USER_A, "file", `${deal}|f-1`, deal, fid(52, 1), 1, "saved");
  ins.run(PROJECT, USER_A, "switch", "messages_upload", "", null, 1, null);
}

/** No internet on this computer: its passes stop and its own calls fail in transport (the other computer is unaffected). */
function goOffline(c: Computer): void {
  c.e.online.value = false;
  const client = c.e.client as unknown as { call: (fn: string, args: Record<string, unknown>) => Promise<unknown>; realCall?: unknown };
  if (!client.realCall) {
    const real = client.call.bind(client);
    client.realCall = real;
    client.call = async (fn, args) => (c.e.online.value ? real(fn, args) : { kind: "transport", code: "network" });
  }
}
function goOnline(c: Computer): void {
  c.e.online.value = true;
}

/** B becomes the active computer through "Use this computer instead" (B was never on). */
async function moveTo(c: Computer, clock: { t: number }): Promise<void> {
  clock.t += 61_000;
  const r = await c.e.service.useThisComputer();
  expect(r).toEqual({ success: true });
  await c.e.service.runner!.whenIdle();
}

describe(`Keepr Cloud one computer per account [${DRIVER}]`, () => {
  // ------------------------------------------------------------ switch off
  describe("switch off: the app behaves as today", () => {
    async function twoComputers(mode: "no_migration" | "switch_off") {
      const { server } = account({ s1: mode === "switch_off", oneComputer: false });
      const a = computer(server, { on: true });
      const b = computer(server, { on: true });
      await startAndPass(a.e);
      await startAndPass(b.e);
      const views = [(await a.e.service.getView()).status, (await b.e.service.getView()).status];
      const online = server.deals.map((d) => d.install).sort();
      const writes = server.calls.filter((c) => !READ_FUNCTIONS.includes(c.fn)).map((c) => c.fn);
      const off = await b.e.service.turnOff();
      return { server, a, b, views, online, writes, off, dealsAfterOff: server.deals.length };
    }

    it("two computers on one account both save, both show on, and either turns off the account; the only extra call is the first computer's claim", async () => {
      const before = await twoComputers("no_migration");
      const now = await twoComputers("switch_off");
      expect(before.views).toEqual(["on", "on"]);
      expect(now.views).toEqual(["on", "on"]);
      expect(now.online).toEqual([installOf(now.a.db), installOf(now.b.db)].sort());
      expect(before.online).toHaveLength(2);
      expect(now.writes.filter((f) => f !== "cloud_claim_install")).toEqual(before.writes);
      expect(now.writes.filter((f) => f === "cloud_claim_install")).toHaveLength(1);
      expect(before.writes).not.toContain("cloud_claim_install");
      expect(before.off).toEqual({ success: true });
      expect(now.off).toEqual({ success: true });
      expect(before.dealsAfterOff).toBe(0);
      expect(now.dealsAfterOff).toBe(0);
      expect(now.server.activeInstall).toBeNull();
    });
  });

  // ------------------------------------------------------------ refused computer
  describe("a computer that is not the account's active one", () => {
    it("makes no write, clears nothing local, and its local delete of a deal it saved earlier sends nothing (C-4b)", async () => {
      const { server, clock } = account({ oneComputer: true });
      const b = computer(server, { on: true, deals: 2 });
      await startAndPass(b.e);
      expect(server.activeInstall).toBe(installOf(b.db));
      expect(server.deals).toHaveLength(2);
      const a = computer(server, { deals: 1 });
      await moveTo(a, clock);
      expect(server.activeInstall).toBe(installOf(a.db));
      // B still thinks it is on: it deletes one of the deals it saved, and edits the other.
      b.db.prepare("DELETE FROM transactions WHERE id = ?").run(b.deals[0]);
      b.db.prepare("UPDATE transactions SET property_city = 'Elsewhere' WHERE id = ?").run(b.deals[1]);
      const from = server.calls.length;
      const s = await pass(b.e);
      expect(s.outcome).toBe("other_computer");
      expect(writesSince(server, from)).toEqual([]);
      expect(server.callsTo("cloud_delete_deal")).toHaveLength(0);
      expect(dirty(b.db).map((r) => r.transaction_id).sort()).toEqual([...b.deals].sort());
      expect(dirty(b.db).every((r) => r.next_attempt_at === null && r.attempts === 0)).toBe(true);
      expect(settings(b.db)).toMatchObject({ enabled: 1, turn_off_owed_at: null });
      expect(stateRows(b.db).filter((r) => r.startsWith("deal:"))).toHaveLength(2);
      expect(server.deals.filter((d) => d.install === installOf(b.db))).toHaveLength(2);
      expect((await b.e.service.getView()).status).toBe("other_computer");
    });

    it("computer_not_active from a deal write during a pass stops the pass without parking the deal", async () => {
      const { server, clock } = account({ oneComputer: true });
      const b = computer(server, { on: true });
      await startAndPass(b.e);
      const a = computer(server);
      await moveTo(a, clock);
      // B's state read is answered as if B were still active (the move commits after it): the deal write is refused.
      const mine = installOf(b.db);
      server.override = (fn, args) =>
        fn === "get_my_cloud_autosave_state"
          ? { data: { ...(server.respond(fn, args) as Record<string, unknown>), active_install_id: mine }, error: null, status: 200 }
          : undefined;
      b.db.prepare("UPDATE transactions SET property_city = 'Elsewhere' WHERE id = ?").run(b.deals[0]);
      const s = await pass(b.e);
      expect(s.outcome).toBe("other_computer");
      expect(server.callsTo("cloud_upsert_deal").at(-1)!.args.p_expected_user_id).toBe(USER_A);
      expect(dirty(b.db)).toEqual([expect.objectContaining({ transaction_id: b.deals[0], attempts: 0, next_attempt_at: null, last_error_code: null })]);
    });

    it("computer_not_active from a todo push during a pass stops the pass and keeps the queued change", async () => {
      const { server, clock } = account({ oneComputer: true });
      const b = computer(server, { on: true, todo: true });
      await startAndPass(b.e);
      expect(b.db.prepare("SELECT COUNT(*) AS n FROM cloud_sync_todo_outbox").get()).toEqual({ n: 0 });
      const a = computer(server);
      await moveTo(a, clock);
      const mine = installOf(b.db);
      server.override = (fn, args) =>
        fn === "get_my_cloud_autosave_state"
          ? { data: { ...(server.respond(fn, args) as Record<string, unknown>), active_install_id: mine }, error: null, status: 200 }
          : undefined;
      b.db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("refused", b.item);
      const pushes = server.callsTo("cloud_todo_push").length;
      const s = await pass(b.e);
      expect(server.callsTo("cloud_todo_push")).toHaveLength(pushes + 1);
      expect(s.outcome).toBe("other_computer");
      expect(b.db.prepare("SELECT COUNT(*) AS n FROM cloud_sync_todo_outbox").get()).toEqual({ n: 1 });
    });
  });

  // ------------------------------------------------------------ claim
  describe("claiming this computer", () => {
    it("the first pass on a server with the rule claims before any write; the account's active computer is then this one", async () => {
      const { server } = account({ oneComputer: true });
      const a = computer(server, { on: true });
      const s = await startAndPass(a.e);
      expect(s?.outcome).toBe("done");
      expect(writesSince(server, 0).map((c) => c.fn)).toEqual(["cloud_claim_install", "cloud_upsert_deal", "cloud_mark_deal_synced"]);
      expect(server.callsTo("cloud_claim_install")[0].args).toEqual({ p_expected_user_id: USER_A, p_source_install_id: installOf(a.db), p_replace: false });
      expect(server.activeInstall).toBe(installOf(a.db));
    });

    it("a claim during a pass that fails in transport ends the pass with no write", async () => {
      const { server } = account({ oneComputer: true });
      const a = computer(server, { on: true });
      server.override = (fn) => (fn === "cloud_claim_install" ? new Error("network down") : undefined);
      const s = await startAndPass(a.e);
      expect(s?.outcome).toBe("unknown_state");
      expect(writesSince(server, 0).map((c) => c.fn)).toEqual(["cloud_claim_install"]);
      expect(server.deals).toHaveLength(0);
    });

    it("turn on while another computer is active: the notice is accepted for the account, nothing is enabled here, and the screen offers Use this computer instead", async () => {
      const { server } = account({ oneComputer: true });
      const b = computer(server, { on: true });
      await startAndPass(b.e);
      const a = computer(server);
      const r = await a.e.service.turnOn(1);
      expect(r).toEqual({ success: false, error: "computer_not_active" });
      expect(settings(a.db)?.enabled ?? 0).toBe(0);
      expect(server.callsTo("cloud_claim_install").at(-1)!.args).toMatchObject({ p_source_install_id: installOf(a.db), p_replace: false });
      expect(server.activeInstall).toBe(installOf(b.db));
      expect((await a.e.service.getView()).status).toBe("other_computer");
    });

    it("turn on on a server whose state has the rule but whose claim function is missing: fails with nothing enabled here", async () => {
      const { server } = account({ oneComputer: false });
      const a = computer(server);
      server.enabled = false;
      server.override = (fn) => (fn === "cloud_claim_install" ? { data: null, error: { code: "PGRST202", status: 404 }, status: 404 } : undefined);
      const r = await a.e.service.turnOn(1);
      expect(r).toEqual({ success: false, error: "PGRST202" });
      expect(settings(a.db)?.enabled ?? 0).toBe(0);
      expect(a.e.timers).toHaveLength(0);
    });

    it("Save this computer's deals while another computer is active: refused, nothing enabled here", async () => {
      const { server } = account({ oneComputer: true });
      const b = computer(server, { on: true });
      await startAndPass(b.e);
      const a = computer(server);
      const r = await a.e.service.confirmComputer();
      expect(r).toEqual({ success: false, error: "computer_not_active" });
      expect(settings(a.db)?.enabled ?? 0).toBe(0);
    });
  });

  // ------------------------------------------------------------ version skew
  describe("a server without the one-computer migration", () => {
    it("turn on claims nothing; a pass claims nothing; the turn-off is the 3-argument call", async () => {
      const { server } = account({ s1: false });
      server.enabled = false;
      const a = computer(server);
      expect(await a.e.service.turnOn(1)).toEqual({ success: true });
      await a.e.service.runner!.whenIdle();
      expect(server.callsTo("cloud_claim_install")).toHaveLength(0);
      expect(server.deals).toHaveLength(1);
      expect(await a.e.service.turnOff()).toEqual({ success: true });
      expect(server.callsTo("set_my_cloud_autosave").at(-1)!.args).toEqual({ p_expected_user_id: USER_A, p_enabled: false, p_notice_version: null });
    });

    it("a turn-off before any state read this launch sends the install id; refused as a missing function it stays owed and the next pass settles it with 3 arguments", async () => {
      const { server } = account({ s1: false });
      const a = computer(server, { on: true });
      // No pass has run this launch (the schedule was never started), so nothing is known about the server.
      const r = await a.e.service.turnOff();
      expect(r).toMatchObject({ success: true, pendingOnline: true });
      expect(server.callsTo("set_my_cloud_autosave")[0].args).toHaveProperty("p_source_install_id", installOf(a.db));
      // The turn-off restarted the schedule (a turn-off is owed); its pass reads the state, then settles.
      await a.e.service.runner!.whenIdle();
      expect(server.callsTo("set_my_cloud_autosave")).toHaveLength(2);
      expect(server.callsTo("set_my_cloud_autosave").at(-1)!.args).not.toHaveProperty("p_source_install_id");
      expect(settings(a.db)?.turn_off_owed_at).toBeNull();
    });
  });

  // ------------------------------------------------------------ the move
  describe("Use this computer instead", () => {
    it("moving back: email, text and file records and the move marker go, deal and party records and the messages_upload sentinel stay, every deal is marked, and a todo change queued while refused is ready to send (D1)", async () => {
      const { server, clock } = account({ oneComputer: true });
      const a = computer(server, { on: true, deals: 3, todo: true });
      await startAndPass(a.e);
      seedMessageRecords(a.db, a.deals[0]);
      const b = computer(server);
      await moveTo(b, clock);
      expect((await pass(a.e)).outcome).toBe("other_computer");
      a.db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("queued while refused", a.item);
      // The erase job scrubs A's emails, texts and files while A is not active (P3 condition 6; modelled).
      server.runScrub([installOf(a.db) as string]);
      expect(server.scrubbedInstalls.has(installOf(a.db) as string)).toBe(true);
      const dealRecords = stateRows(a.db).filter((r) => r.startsWith("deal:"));
      expect(dealRecords).toHaveLength(3);

      clock.t += 61_000;
      const r = await a.e.service.useThisComputer();
      expect(r).toEqual({ success: true });
      expect(server.callsTo("cloud_claim_install").at(-1)!.args).toEqual({ p_expected_user_id: USER_A, p_source_install_id: installOf(a.db), p_replace: true });
      // Right after the move's local transaction, before any pass:
      const rows = stateRows(a.db);
      expect(rows.filter((x) => x.startsWith("message:") || x.startsWith("file:"))).toEqual([]);
      expect(rows).not.toContain("switch:move_pending");
      expect(rows).toContain("switch:messages_upload");
      expect(rows.filter((x) => x.startsWith("deal:"))).toEqual(dealRecords);
      expect(dirty(a.db).map((d) => d.transaction_id).sort()).toEqual([...a.deals].sort());
      const outbox = readTodoOutbox(a.db, PROJECT, USER_A);
      expect(outbox.waiting).toBe(0);
      expect(outbox.ready.map((x) => x.part)).toEqual(["note"]);
      // The pass that follows sends the todo change and ends done.
      await a.e.service.runner!.whenIdle();
      const s = await pass(a.e);
      expect(s.outcome).toBe("done");
      const note = server.todos.find((t) => t.entity === "item" && t.localId === a.item)!.parts.note?.value;
      expect(note).toBe("queued while refused");
      expect(server.activeInstall).toBe(installOf(a.db));
    });

    it("a computer that was never on here: the move enables it and its next pass saves its deals", async () => {
      const { server, clock } = account({ oneComputer: true });
      const a = computer(server, { on: true });
      await startAndPass(a.e);
      const b = computer(server, { deals: 2 });
      expect((await b.e.service.getView()).status).toBe("other_computer");
      await moveTo(b, clock);
      expect(settings(b.db)).toMatchObject({ enabled: 1 });
      expect(server.deals.filter((d) => d.install === installOf(b.db))).toHaveLength(2);
      expect((await b.e.service.getView()).status).toBe("on");
      expect((await a.e.service.getView()).status).toBe("other_computer");
    });

    it("a second move within a minute answers busy: the marker goes and nothing local changes", async () => {
      const { server, clock } = account({ oneComputer: true });
      const a = computer(server, { on: true });
      await startAndPass(a.e);
      const b = computer(server);
      await moveTo(b, clock);
      seedMessageRecords(a.db, a.deals[0]);
      await pass(a.e);
      a.db.prepare("DELETE FROM cloud_sync_dirty").run();
      const before = stateRows(a.db);
      clock.t += 10_000;
      const r = await a.e.service.useThisComputer();
      expect(r).toEqual({ success: false, error: "busy" });
      expect(stateRows(a.db)).toEqual(before);
      expect(dirty(a.db)).toEqual([]);
      expect(server.activeInstall).toBe(installOf(b.db));
    });

    it("refused before any call on the active computer, and with the switch off", async () => {
      const { server } = account({ oneComputer: true });
      const a = computer(server, { on: true });
      await startAndPass(a.e);
      expect(await a.e.service.useThisComputer()).toEqual({ success: false, error: "not_other_computer" });
      server.oneComputer = false;
      const b = computer(server);
      expect(await b.e.service.useThisComputer()).toEqual({ success: false, error: "not_other_computer" });
      expect(server.callsTo("cloud_claim_install").filter((c) => c.args.p_replace === true)).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------ move_pending heals a crash
  describe("the move marker heals a crash between the server claim and the local transaction", () => {
    async function refusedA() {
      const { server, clock } = account({ oneComputer: true });
      const a = computer(server, { on: true, deals: 2 });
      await startAndPass(a.e);
      const b = computer(server);
      await moveTo(b, clock);
      expect((await pass(a.e)).outcome).toBe("other_computer");
      seedMessageRecords(a.db, a.deals[0]);
      a.db.prepare("DELETE FROM cloud_sync_dirty").run();
      return { server, clock, a, b };
    }

    it("crash after the claim landed: the next pass sees this computer active and runs the move's local transaction", async () => {
      const { server, clock, a } = await refusedA();
      writeMovePending(a.db, PROJECT, USER_A);
      clock.t += 61_000;
      server.respond("cloud_claim_install", { p_expected_user_id: USER_A, p_source_install_id: installOf(a.db), p_replace: true });
      expect(server.activeInstall).toBe(installOf(a.db));
      const s = await pass(a.e);
      expect(s.outcome).toBe("done");
      const rows = stateRows(a.db);
      expect(rows.filter((x) => x.startsWith("message:") || x.startsWith("file:") || x === "switch:move_pending")).toEqual([]);
      expect(rows).toContain("switch:messages_upload");
      // Every deal was marked by the heal; the pass then cleared the marks (deal records kept: the shortcut).
      expect(server.callsTo("cloud_upsert_deal").filter((c) => (c.args.p_deal as Record<string, unknown>).source_install_id === installOf(a.db))).toHaveLength(2);
    });

    it("crash before the claim reached the server: the next pass drops the marker and changes nothing else", async () => {
      const { a } = await refusedA();
      writeMovePending(a.db, PROJECT, USER_A);
      const before = stateRows(a.db).filter((x) => x !== "switch:move_pending");
      const s = await pass(a.e);
      expect(s.outcome).toBe("other_computer");
      expect(stateRows(a.db)).toEqual(before);
      expect(dirty(a.db)).toEqual([]);
    });

    it("the claim's answer is lost in transport after it landed: the move reports failure, the marker stays, and the next pass completes it", async () => {
      const { server, clock, a } = await refusedA();
      clock.t += 61_000;
      server.override = (fn, args) => {
        if (fn !== "cloud_claim_install") return undefined;
        server.respond(fn, args);
        return new Error("connection reset");
      };
      const r = await a.e.service.useThisComputer();
      expect(r).toEqual({ success: false, error: "network" });
      expect(stateRows(a.db)).toContain("switch:move_pending");
      expect(stateRows(a.db).some((x) => x.startsWith("message:"))).toBe(true);
      server.override = null;
      const s = await pass(a.e);
      expect(s.outcome).toBe("done");
      expect(stateRows(a.db).filter((x) => x.startsWith("message:") || x.startsWith("file:") || x === "switch:move_pending")).toEqual([]);
    });
  });

  // ------------------------------------------------------------ turn-off
  describe("turning off", () => {
    it("an offline turn-off owed by a computer that is no longer active is dropped: no turn-off call, nothing online deleted, and the screen says so", async () => {
      const { server, clock } = account({ oneComputer: true });
      const a = computer(server, { on: true });
      await startAndPass(a.e);
      goOffline(a);
      expect(await a.e.service.turnOff()).toMatchObject({ success: true, pendingOnline: true });
      const offCalls = server.callsTo("set_my_cloud_autosave").length;
      const b = computer(server, { deals: 2 });
      await moveTo(b, clock);
      expect(server.deals.filter((d) => d.install === installOf(b.db))).toHaveLength(2);
      goOnline(a);
      const s = await pass(a.e);
      expect(s.outcome).toBe("other_computer");
      expect(server.callsTo("set_my_cloud_autosave")).toHaveLength(offCalls);
      expect(server.deals.filter((d) => d.install === installOf(b.db))).toHaveLength(2);
      expect(server.enabled).toBe(true);
      expect(settings(a.db)).toMatchObject({ enabled: 0, turn_off_owed_at: null });
      const view = await a.e.service.getView();
      expect(view.status).toBe("other_computer");
      expect(view.turnOffDropped).toBe(true);
    });

    it("the server refusing an owed turn-off (a move committed after the state read) drops it too", async () => {
      const { server, clock } = account({ oneComputer: true });
      const a = computer(server, { on: true });
      await startAndPass(a.e);
      goOffline(a);
      expect(await a.e.service.turnOff()).toMatchObject({ success: true, pendingOnline: true });
      const b = computer(server);
      await moveTo(b, clock);
      const mine = installOf(a.db);
      goOnline(a);
      server.override = (fn, args) =>
        fn === "get_my_cloud_autosave_state"
          ? { data: { ...(server.respond(fn, args) as Record<string, unknown>), active_install_id: mine }, error: null, status: 200 }
          : undefined;
      const s = await pass(a.e);
      expect(server.callsTo("set_my_cloud_autosave").at(-1)!.args).toMatchObject({ p_enabled: false, p_source_install_id: mine });
      expect(s.outcome).toBe("other_computer");
      expect(settings(a.db)).toMatchObject({ enabled: 0, turn_off_owed_at: null });
      expect(stateRows(a.db)).toEqual(["switch:turn_off_dropped"]);
      expect(server.deals.length).toBeGreaterThan(0);
    });

    it("turn off on a computer that lost its place since the screen was drawn: refused online, dropped here, nothing online deleted", async () => {
      const { server, clock } = account({ oneComputer: true });
      const a = computer(server, { on: true });
      await startAndPass(a.e);
      const b = computer(server);
      await moveTo(b, clock);
      const r = await a.e.service.turnOff();
      expect(r).toEqual({ success: false, error: "computer_not_active" });
      expect(settings(a.db)).toMatchObject({ enabled: 0, turn_off_owed_at: null });
      expect(server.enabled).toBe(true);
      expect(server.deals.filter((d) => d.install === installOf(b.db))).toHaveLength(1);
    });

    it("from the active computer: the turn-off carries its install id, deletes the online copy and frees the account", async () => {
      const { server } = account({ oneComputer: true });
      const a = computer(server, { on: true });
      await startAndPass(a.e);
      expect(await a.e.service.turnOff()).toEqual({ success: true });
      expect(server.callsTo("set_my_cloud_autosave").at(-1)!.args).toEqual({
        p_expected_user_id: USER_A,
        p_enabled: false,
        p_notice_version: null,
        p_source_install_id: installOf(a.db),
      });
      expect(server.deals).toHaveLength(0);
      expect(server.activeInstall).toBeNull();
    });
  });

  // ------------------------------------------------------------ Delete them (P1 review N5)
  describe("Delete them (deals saved from other computers)", () => {
    function seedOtherInstall(server: FakeServer, install: string, lastSyncedAt: string) {
      server.deals.push({ id: fid(61, server.deals.length + 1), owner: USER_A, install, localId: fid(62, server.deals.length + 1), hash: "h", version: 1, fullSyncAt: null, lastSyncedAt });
    }

    it("from a computer that is not active: refused before any call, even when an old third install exists", async () => {
      const { server, clock } = account({ oneComputer: true });
      const b = computer(server, { on: true });
      await startAndPass(b.e);
      const a = computer(server);
      await moveTo(a, clock);
      seedOtherInstall(server, fid(63, 1), "2026-09-01T00:00:00.000Z");
      const r = await b.e.service.deleteOldInstalls();
      expect(r).toEqual({ success: false, error: "computer_not_active" });
      expect(server.callsTo("cloud_delete_install")).toHaveLength(0);
      expect((await b.e.service.getView()).otherInstalls).toBeNull();
    });

    it("on the active computer with the rule on: every other install is listed, not only those idle for 30 days; with the switch off only idle ones (as today)", async () => {
      const { server } = account({ oneComputer: true });
      const a = computer(server, { on: true });
      await startAndPass(a.e);
      seedOtherInstall(server, fid(63, 2), "2026-11-14T11:00:00.000Z");
      expect((await a.e.service.getView()).otherInstalls).toEqual({ deals: 1, lastSavedAt: "2026-11-14T11:00:00.000Z" });
      server.oneComputer = false;
      expect((await a.e.service.getView()).otherInstalls).toBeNull();
    });
  });

  // ------------------------------------------------------------ views
  describe("what Settings shows", () => {
    it("active computer: on; refused computer on here: other_computer; never on here: other_computer; notice changed: off with the other-computer line; after the move: on", async () => {
      const { server, clock } = account({ oneComputer: true });
      const a = computer(server, { on: true });
      await startAndPass(a.e);
      const b = computer(server, { on: true });
      const c = computer(server);
      expect((await a.e.service.getView()).status).toBe("on");
      expect((await b.e.service.getView()).status).toBe("other_computer");
      expect((await c.e.service.getView()).status).toBe("other_computer");
      // The account's accepted notice is older than the current one (reason notice_outdated).
      server.noticeVersion = 0;
      expect(await b.e.service.getView()).toMatchObject({ status: "off", otherComputerActive: true });
      server.noticeVersion = 1;
      await moveTo(c, clock);
      expect((await c.e.service.getView()).status).toBe("on");
      expect((await a.e.service.getView()).status).toBe("other_computer");
    });
  });
});
