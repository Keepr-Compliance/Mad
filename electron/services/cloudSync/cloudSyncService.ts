/**
 * Keepr Cloud service (main process) — BACKLOG-4243 PR-1 + PR-2.
 *
 * The Settings section's state and actions, and the pass scheduler.
 *
 * Off by default and quiet: for a user who never turned Keepr Cloud on, the
 * engine reads one local table at start and makes no network call, starts no
 * timer and marks nothing (the triggers' WHEN gate). The Settings section reads
 * the server state only when Keepr Cloud is on here (or a turn-off is owed) or
 * the plan feature map already in memory carries a Keepr Cloud key.
 */
import type { CloudClient } from "./cloudClient";
import { CloudSyncRunner, type PassSummary, type RunnerLog } from "./runner";
import { isNoticeSupported } from "./notice";
import { parseState, type ServerState } from "./stateReader";
import type { SessionIdentity } from "./session";
import type { SqlDb } from "../db/cloudSyncSqlDb";
import * as store from "../db/cloudSyncDbService";
import type {
  CloudSyncPausedReason,
  CloudSyncResult,
  CloudSyncView,
} from "../../types/ipc/window-api-cloud-sync";

/** How often a pass runs while Keepr Cloud is on here. */
export const PASS_INTERVAL_MS = 60_000;

export interface CloudSyncServiceDeps {
  db: () => SqlDb;
  dbReady: () => boolean;
  client: CloudClient;
  identity: SessionIdentity;
  getAuthUserId: () => string | null;
  projectRef: string | null;
  deviceId: () => string;
  blockedReason: () => string | null;
  isOnline: () => boolean;
  /** The plan feature map already in memory carries a Keepr Cloud key for this user. */
  cloudFeatureAllowed: () => Promise<boolean>;
  /** Opens the portal AI apps page; false when no allowed address. */
  openAiApps: () => Promise<boolean>;
  aiAppsAvailable: () => boolean;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  now?: () => Date;
  log?: RunnerLog;
  reportFailure?: (code: string) => void;
}

export class CloudSyncService {
  readonly runner: CloudSyncRunner | null;
  private timer: unknown = null;
  private installId: string | null = null;
  private failedPasses = 0;
  engineInstalled = true;

  constructor(private readonly deps: CloudSyncServiceDeps) {
    const projectRef = deps.projectRef;
    this.runner = projectRef
      ? new CloudSyncRunner({
          db: deps.db,
          client: deps.client,
          identity: deps.identity,
          getAuthUserId: deps.getAuthUserId,
          projectRef,
          installId: () => this.ensureInstallId(),
          blockedReason: deps.blockedReason,
          isOnline: deps.isOnline,
          now: deps.now,
          log: deps.log,
          reportFailure: deps.reportFailure,
        })
      : null;
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private ensureInstallId(): string {
    if (!this.installId) {
      this.installId = store.ensureInstall(this.deps.db(), this.deps.projectRef as string, this.deps.deviceId(), this.now()).installId;
    }
    return this.installId;
  }

  // ------------------------------------------------------------ scheduler

  /** Local check only: starts the timer when Keepr Cloud is on here, stops it otherwise. */
  refreshSchedule(): void {
    const ref = this.deps.projectRef;
    const isActive = () => {
      try {
        return !!ref && this.deps.dbReady() && store.anyActiveSettings(this.deps.db(), ref);
      } catch {
        return false;
      }
    };
    let active = isActive();
    if (active) {
      // Bind the machine first (N1): a cloned database resets before any upload.
      this.ensureInstallId();
      active = isActive();
    }
    if (active && this.timer === null) {
      this.timer = this.deps.setInterval(() => void this.kick(), PASS_INTERVAL_MS);
      void this.kick();
    } else if (!active && this.timer !== null) {
      this.deps.clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Runs a pass when Keepr Cloud is on here; otherwise nothing. */
  async kick(): Promise<PassSummary | null> {
    if (!this.runner || this.timer === null) return null;
    const summary = await this.runner.runPass();
    if (summary.outcome !== "queued") {
      this.failedPasses = summary.failed > 0 ? this.failedPasses + 1 : summary.outcome === "done" ? 0 : this.failedPasses;
    }
    if (summary.outcome === "not_enabled") this.refreshSchedule();
    return summary;
  }

  stop(): void {
    if (this.timer !== null) this.deps.clearInterval(this.timer);
    this.timer = null;
  }

  // ------------------------------------------------------------ view

  async getView(): Promise<CloudSyncView> {
    const base: CloudSyncView = {
      engineInstalled: this.engineInstalled && this.runner !== null,
      status: "hidden",
      pausedReason: null,
      noticeVersion: null,
      pendingDeals: 0,
      lastSavedAt: null,
      aiAppsAvailable: this.deps.aiAppsAvailable(),
    };
    const ref = this.deps.projectRef;
    if (!ref || !this.deps.dbReady()) return base;
    const db = this.deps.db();
    const paused = (reason: CloudSyncPausedReason): CloudSyncView => ({ ...base, status: "paused", pausedReason: reason });

    const session = await this.deps.identity.current();
    if (!session) return base;
    const settings = store.getSettings(db, ref, session.userId);
    const locallyOn = settings?.enabled === 1;
    const owed = !!settings?.turn_off_owed_at;
    base.pendingDeals = this.pendingDeals(db, session.userId);
    base.lastSavedAt = this.lastSavedAt(db, ref);

    if (store.otherProjectInUse(db, ref)) return paused("other_project");
    if (owed) return { ...base, status: "turning_off" };
    if (this.deps.blockedReason()) return locallyOn ? paused("dev_blocked") : base;
    if (this.deps.getAuthUserId() !== session.userId) return locallyOn ? paused("identity") : base;
    if (!locallyOn && !(await this.deps.cloudFeatureAllowed())) return base;
    if (!this.deps.isOnline()) return locallyOn ? paused("offline") : base;

    const read = parseState(await this.deps.client.getState());
    if (read.kind !== "state" || read.state.userId !== session.userId) return locallyOn ? paused("unknown") : base;
    const state = read.state;
    return this.viewFor(base, state, locallyOn, !!settings?.local_confirmed_at);
  }

  private viewFor(base: CloudSyncView, state: ServerState, locallyOn: boolean, confirmed: boolean): CloudSyncView {
    const visible = state.licensed || locallyOn;
    if (!visible) return base;
    if (!isNoticeSupported(state.currentNoticeVersion)) return { ...base, status: "update_needed" };
    const withNotice = { ...base, noticeVersion: state.currentNoticeVersion };
    switch (state.reasonClass) {
      case "entitled":
        if (!locallyOn || !confirmed) return { ...withNotice, status: "needs_confirmation" };
        if (this.failedPasses >= 3) return { ...withNotice, status: "error" };
        return { ...withNotice, status: "on" };
      case "not_enabled":
      case "notice_outdated":
        return { ...withNotice, status: "off" };
      case "licence":
        return locallyOn ? { ...withNotice, status: "not_active", pausedReason: "not_active" } : base;
      default:
        return { ...withNotice, status: "paused", pausedReason: "unknown" };
    }
  }

  private pendingDeals(db: SqlDb, userId: string): number {
    try {
      return store.countPendingDeals(db, userId);
    } catch {
      return 0;
    }
  }

  private lastSavedAt(db: SqlDb, ref: string): string | null {
    try {
      return store.lastSavedAt(db, ref);
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------ actions

  /** A validated session user that the SDK agrees with, or null (C1.4). */
  private async actingUser(): Promise<string | null> {
    if (!this.deps.projectRef || !this.deps.dbReady()) return null;
    const session = await this.deps.identity.current();
    if (!session) return null;
    if (this.deps.getAuthUserId() !== session.userId) return null;
    return session.userId;
  }

  async turnOn(noticeVersion: number): Promise<CloudSyncResult> {
    const userId = await this.actingUser();
    if (!userId) return { success: false, error: "signed_out" };
    if (this.deps.blockedReason()) return { success: false, error: "blocked" };
    if (!isNoticeSupported(noticeVersion)) return { success: false, error: "update_needed" };
    const read = parseState(await this.deps.client.getState());
    if (read.kind !== "state" || read.state.userId !== userId) return { success: false, error: "unknown" };
    if (!read.state.licensed) return { success: false, error: "not_licensed" };
    if (read.state.currentNoticeVersion !== noticeVersion) return { success: false, error: "update_needed" };
    const res = await this.deps.client.setAutosave(userId, true, noticeVersion);
    if (res.kind !== "ok") return { success: false, error: res.code };
    const after = parseState(await this.deps.client.getState());
    const acceptedAt = after.kind === "state" && after.state.userId === userId ? after.state.acceptedAt : null;
    this.ensureInstallId();
    store.enableForUser(this.deps.db(), this.deps.projectRef as string, userId, { noticeVersion, acceptedAt }, this.now());
    this.refreshSchedule();
    void this.kick();
    return { success: true };
  }

  /** Keepr Cloud is on for the account: save this computer's deals too. */
  async confirmComputer(): Promise<CloudSyncResult> {
    const userId = await this.actingUser();
    if (!userId) return { success: false, error: "signed_out" };
    if (this.deps.blockedReason()) return { success: false, error: "blocked" };
    const read = parseState(await this.deps.client.getState());
    if (read.kind !== "state" || read.state.userId !== userId) return { success: false, error: "unknown" };
    if (read.state.reasonClass !== "entitled") return { success: false, error: "not_entitled" };
    this.ensureInstallId();
    store.enableForUser(
      this.deps.db(),
      this.deps.projectRef as string,
      userId,
      { noticeVersion: read.state.currentNoticeVersion, acceptedAt: read.state.acceptedAt },
      this.now(),
    );
    this.refreshSchedule();
    void this.kick();
    return { success: true };
  }

  /** Turn off: local at once (even offline), then the server deletes the online copy. */
  async turnOff(): Promise<CloudSyncResult> {
    const userId = await this.actingUser();
    if (!userId) return { success: false, error: "signed_out" };
    const db = this.deps.db();
    const ref = this.deps.projectRef as string;
    store.disableForUser(db, ref, userId, true, this.now());
    await this.waitForPass();
    const res = await (this.runner as CloudSyncRunner).settleOwedTurnOff(userId);
    if (res.kind === "ok") {
      this.refreshSchedule();
      return { success: true };
    }
    this.refreshSchedule();
    if (res.kind === "transport") return { success: true, pendingOnline: true };
    return { success: false, error: res.code, pendingOnline: true };
  }

  private async waitForPass(): Promise<void> {
    // Stop a running pass before its next call, and wait for it.
    if (this.runner) {
      this.runner.requestStop();
      await this.runner.whenIdle();
    }
  }

  /** Forgets the other Keepr Cloud's local rows. No call to either cloud. */
  async forgetOtherProject(): Promise<CloudSyncResult> {
    const userId = await this.actingUser();
    if (!userId) return { success: false, error: "signed_out" };
    store.forgetOtherProjects(this.deps.db(), this.deps.projectRef as string);
    this.refreshSchedule();
    return { success: true };
  }

  async retry(): Promise<CloudSyncResult> {
    const userId = await this.actingUser();
    if (!userId) return { success: false, error: "signed_out" };
    this.failedPasses = 0;
    this.refreshSchedule();
    await this.kick();
    return { success: true };
  }

  async openAiApps(): Promise<CloudSyncResult> {
    const ok = await this.deps.openAiApps();
    return ok ? { success: true } : { success: false, error: "portal_unavailable" };
  }
}
