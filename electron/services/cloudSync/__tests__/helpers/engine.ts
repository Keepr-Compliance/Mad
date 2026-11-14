/**
 * Builds a CloudSyncService over a test database and the fake server
 * (BACKLOG-4243 tests). No Electron, no network: the transport is the fake.
 */
import { CloudClient } from "../../cloudClient";
import { CloudSyncService } from "../../cloudSyncService";
import { SessionIdentity } from "../../session";
import { FakeServer } from "./fakeServer";
import { PROJECT, USER_A } from "./fixtures";
import type { TestDb } from "./sqlite";

export const DEVICE_1 = "device-one-4243";
export const DEVICE_2 = "device-two-4243";

export interface Engine {
  service: CloudSyncService;
  server: FakeServer;
  identity: SessionIdentity;
  session: { userId: string | null; token: string; lastActivity: number | null; expired: boolean };
  authUser: { id: string | null; reads: number; sequence: Array<string | null> | null };
  emit: (kind: "saved" | "cleared", userId: string | null) => void;
  logs: Array<{ level: string; message: string; meta?: Record<string, unknown> }>;
  reports: string[];
  timers: Array<{ fn: () => void; ms: number; cleared: boolean }>;
  online: { value: boolean };
  device: { id: string };
  feature: { allowed: boolean; reads: number };
  blocked: { reason: string | null };
  clock: { now: Date };
}

export function makeEngine(db: TestDb, opts: { user?: string; projectRef?: string | null; server?: FakeServer } = {}): Engine {
  const user = opts.user ?? USER_A;
  const server = opts.server ?? new FakeServer(user);
  const session = { userId: user as string | null, token: "tok-1", lastActivity: 1 as number | null, expired: false };
  const authUser = { id: user as string | null, reads: 0, sequence: null as Array<string | null> | null };
  const listeners = new Set<(c: { kind: "saved" | "cleared"; userId: string | null }) => void>();
  const identity = new SessionIdentity({
    loadSession: async () =>
      session.expired || !session.userId ? null : { user: { id: session.userId }, sessionToken: session.token },
    getLastActivity: () => session.lastActivity,
    onSessionChanged: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  });
  const logs: Engine["logs"] = [];
  const reports: string[] = [];
  const timers: Engine["timers"] = [];
  const online = { value: true };
  const device = { id: DEVICE_1 };
  const feature = { allowed: true, reads: 0 };
  const blocked = { reason: null as string | null };
  const clock = { now: new Date("2026-11-14T12:00:00.000Z") };
  const service = new CloudSyncService({
    db: () => db,
    dbReady: () => true,
    client: new CloudClient(server.transport, 5_000),
    identity,
    getAuthUserId: () => {
      authUser.reads++;
      if (authUser.sequence && authUser.sequence.length > 0) return authUser.sequence.shift() as string | null;
      return authUser.id;
    },
    projectRef: opts.projectRef === undefined ? PROJECT : opts.projectRef,
    deviceId: () => device.id,
    blockedReason: () => blocked.reason,
    isOnline: () => online.value,
    cloudFeatureAllowed: async () => {
      feature.reads++;
      return feature.allowed;
    },
    openAiApps: async () => true,
    aiAppsAvailable: () => true,
    setInterval: (fn, ms) => {
      timers.push({ fn, ms, cleared: false });
      return timers.length;
    },
    clearInterval: (handle) => {
      const t = timers[(handle as number) - 1];
      if (t) t.cleared = true;
    },
    now: () => clock.now,
    log: {
      info: (message, meta) => logs.push({ level: "info", message, meta }),
      warn: (message, meta) => logs.push({ level: "warn", message, meta }),
    },
    reportFailure: (code) => reports.push(code),
  });
  return {
    service,
    server,
    identity,
    session,
    authUser,
    emit: (kind, userId) => listeners.forEach((l) => l({ kind, userId })),
    logs,
    reports,
    timers,
    online,
    device,
    feature,
    blocked,
    clock,
  };
}

/** Starts the schedule (as main does after the database opens) and runs one pass. */
export async function startAndPass(e: Engine) {
  e.service.refreshSchedule();
  await e.service.runner!.whenIdle();
  return e.service.runner!.lastSummary;
}

export async function pass(e: Engine) {
  const s = await e.service.runner!.runPass();
  return s;
}
