/** @jest-environment node */
/**
 * BACKLOG-3052 — contact names, property addresses and the user's own connected
 * mailbox address leave this machine only while a support-access window is open.
 *
 * The mailbox address was added on 2026-09-19, by the founder's answer to "also
 * strip the user's own mailbox address?": **"yes (we just need to know the
 * user)"**. 498 rows carried it. `userId` is what identifies the row instead,
 * and is asserted below so that "we just need to know the user" stays true.
 *
 * ## What was wrong
 *
 * `syncToCloud()` ran unconditionally — its only guards were "already syncing"
 * and "services present". `sanitizeMetadata` redacts credential-shaped keys
 * (`password`, `token`, `secret`, …), so `name` and `propertyAddress` were
 * never touched. Measured on production on 2026-09-01: 818 rows carrying 468
 * contact names and 350 property addresses, from 28 users, 26 of whom had
 * never submitted anything to a broker. Newest row 2026-08-31.
 *
 * Every one of those came from a LOCAL action — creating a contact, deleting a
 * transaction, exporting to a folder on the user's own Mac.
 *
 * ## Why these assertions are shaped this way
 *
 * Each one asserts a record was PRODUCED before asserting what it does not
 * contain. `expect(metadata.name).toBeUndefined()` passes just as happily when
 * nothing was uploaded at all, which is the failure mode of the over-correction
 * ("strip everything, always") that would silently break support. So every test
 * pins the upload itself first: it happened, it carried this action, this user,
 * this resource — and it did not carry the name.
 *
 * The grant is the REAL `SupportAccessService` against a temp directory and an
 * injected clock, not a stand-in with a boolean. An expired window here expires
 * the way the shipped one does, by wall-clock against a persisted `expiresAt`.
 */

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

import {
  auditService,
  type AuditAction,
  type AuditLogEntry,
  type ResourceType,
} from "../auditService";
import { SupportAccessService } from "../supportAccess/supportAccessService";
import {
  SUPPORT_ACCESS_DISCLOSURE_ID,
  SUPPORT_ACCESS_DISCLOSURE_TEXT,
} from "../supportAccess/disclosure";

jest.mock("../logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockDatabaseService = {
  insertAuditLog: jest.fn(),
  getUnsyncedAuditLogs: jest.fn(),
  markAuditLogsSynced: jest.fn(),
  isInitialized: jest.fn(() => true),
};

const mockSupabaseService = {
  batchInsertAuditLogs: jest.fn(),
  // BACKLOG-3987: syncToCloud sends only the signed-in user's entries.
  getAuthSession: jest.fn(async () => ({ userId: "user-1" })),
};

/** A contact's name, as `contactHandlers` writes it on CONTACT_CREATE. */
const CONTACT_NAME = "Wilhelmina Quakenbush";
/** A property address, as `transactionExportHandlers` writes it on DATA_EXPORT. */
const PROPERTY_ADDRESS = "742 Evergreen Terrace, Springfield";
/**
 * The user's OWN connected mailbox address, in the metadata shape
 * `googleAuthHandlers` writes on MAILBOX_CONNECT: `{ provider, email }`.
 * `microsoftAuthHandlers` writes the same two keys; `sharedAuthHandlers` adds
 * `pending: true`. Those three are the only producers of this key.
 */
const MAILBOX_ADDRESS = "wilhelmina.quakenbush@example.com";

const T0 = Date.parse("2026-09-01T09:00:00.000Z");

describe("auditService — third-party PII is gated on support access (BACKLOG-3052)", () => {
  let baseDir: string;
  let now: number;

  beforeEach(async () => {
    jest.clearAllMocks();
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "keepr-3052-"));
    now = T0;

    (auditService as any).pendingSyncQueue = [];
    (auditService as any).syncInProgress = false;
    (auditService as any).currentSync = null;
    (auditService as any).initialized = false;
    (auditService as any).databaseService = null;
    (auditService as any).supabaseService = null;
    (auditService as any).pendingLocalWrites = [];
    (auditService as any).flushingPendingWrites = false;
    auditService.setSupportAccessGate(null);
    auditService.stopSyncInterval();

    mockDatabaseService.isInitialized.mockReturnValue(true);
    mockSupabaseService.batchInsertAuditLogs.mockResolvedValue(undefined);
    // BACKLOG-3987: the table fallback is live; default it to empty.
    mockDatabaseService.getUnsyncedAuditLogs.mockReset();
    mockDatabaseService.getUnsyncedAuditLogs.mockResolvedValue([]);

    auditService.initialize(
      mockDatabaseService as any,
      mockSupabaseService as any,
    );
  });

  afterEach(async () => {
    auditService.stopSyncInterval();
    auditService.setSupportAccessGate(null);
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  /** The real service, with an injected clock, against a throwaway directory. */
  const makeSupportAccess = async (): Promise<SupportAccessService> => {
    const service = new SupportAccessService({
      now: () => now,
      baseDir,
      appVersion: () => "2.33.0",
    });
    await service.load();
    return service;
  };

  const wireGate = (service: SupportAccessService): void => {
    auditService.setSupportAccessGate({ isActive: () => service.isActive() });
  };

  const grant7d = async (): Promise<SupportAccessService> => {
    const service = await makeSupportAccess();
    await service.grant({
      durationId: "7d",
      disclosureId: SUPPORT_ACCESS_DISCLOSURE_ID,
      disclosureText: SUPPORT_ACCESS_DISCLOSURE_TEXT,
    });
    return service;
  };

  const logContactCreate = async (): Promise<void> => {
    await auditService.log({
      userId: "user-1",
      sessionId: "session-1",
      action: "CONTACT_CREATE" as AuditAction,
      resourceType: "CONTACT" as ResourceType,
      resourceId: "contact-1",
      metadata: { name: CONTACT_NAME, source: "manual" },
      success: true,
    });
    await auditService.syncToCloud();
  };

  const logDataExport = async (): Promise<void> => {
    await auditService.log({
      userId: "user-1",
      action: "DATA_EXPORT" as AuditAction,
      resourceType: "EXPORT" as ResourceType,
      resourceId: "txn-1",
      metadata: { propertyAddress: PROPERTY_ADDRESS, format: "pdf" },
      success: true,
    });
    await auditService.syncToCloud();
  };

  const logMailboxConnect = async (): Promise<void> => {
    await auditService.log({
      userId: "user-1",
      action: "MAILBOX_CONNECT" as AuditAction,
      resourceType: "MAILBOX" as ResourceType,
      metadata: { provider: "google", email: MAILBOX_ADDRESS },
      success: true,
    });
    await auditService.syncToCloud();
  };

  /**
   * The single uploaded batch. Fails loudly rather than returning undefined —
   * "no upload happened" must not read as "the name was absent".
   */
  const uploadedEntries = (): AuditLogEntry[] => {
    const calls = mockSupabaseService.batchInsertAuditLogs.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const entries = calls[0][0] as AuditLogEntry[];
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
    return entries;
  };

  // -----------------------------------------------------------------------
  // Control 1 — the whole item.
  // -----------------------------------------------------------------------
  describe("with no support-access grant", () => {
    it("uploads the CONTACT_CREATE row but not the contact's name", async () => {
      await logContactCreate();

      const [entry] = uploadedEntries();

      // The record exists, and is still an audit record.
      expect(entry.action).toBe("CONTACT_CREATE");
      expect(entry.userId).toBe("user-1");
      expect(entry.resourceId).toBe("contact-1");
      expect(entry.resourceType).toBe("CONTACT");
      expect(entry.timestamp).toBeInstanceOf(Date);

      // And it does not carry the name.
      expect(entry.metadata).toBeDefined();
      expect(entry.metadata).not.toHaveProperty("name");
      expect(JSON.stringify(entry)).not.toContain(CONTACT_NAME);
    });

    it("uploads the DATA_EXPORT row but not the property address", async () => {
      await logDataExport();

      const [entry] = uploadedEntries();

      expect(entry.action).toBe("DATA_EXPORT");
      expect(entry.resourceId).toBe("txn-1");
      expect(entry.metadata).not.toHaveProperty("propertyAddress");
      expect(JSON.stringify(entry)).not.toContain(PROPERTY_ADDRESS);
    });

    // Control 5 — the over-correction guard. Stripping the whole payload would
    // satisfy every "does not contain" assertion above and destroy the log.
    it("keeps every non-PII metadata field", async () => {
      await logContactCreate();

      const [entry] = uploadedEntries();

      expect(entry.metadata).toEqual({ source: "manual" });
    });

    it("keeps `updatedFields`, which names columns rather than values", async () => {
      await auditService.log({
        userId: "user-1",
        action: "CONTACT_UPDATE" as AuditAction,
        resourceType: "CONTACT" as ResourceType,
        resourceId: "contact-1",
        metadata: {
          updatedFields: ["name", "phone", "property_address"],
          name: CONTACT_NAME,
        },
        success: true,
      });
      await auditService.syncToCloud();

      const [entry] = uploadedEntries();

      expect(entry.metadata).toEqual({
        updatedFields: ["name", "phone", "property_address"],
      });
    });

    // Added 2026-09-19 with the mailbox address. Two assertions, not one: the
    // row must still say WHO connected a mailbox (`userId`) and WHICH provider,
    // because that is the whole of what the founder's "we just need to know the
    // user" keeps. An assertion that only checked the address was gone would
    // pass just as happily if the entire record stopped being uploaded.
    it("uploads the MAILBOX_CONNECT row but not the user's own mailbox address", async () => {
      await logMailboxConnect();

      const [entry] = uploadedEntries();

      expect(entry.action).toBe("MAILBOX_CONNECT");
      expect(entry.resourceType).toBe("MAILBOX");
      expect(entry.userId).toBe("user-1");
      expect(entry.metadata).toEqual({ provider: "google" });
      expect(JSON.stringify(entry)).not.toContain(MAILBOX_ADDRESS);
    });

    // The control for the most likely WRONG fix: adding "email" to
    // `sanitizeMetadata`'s credential list, which runs on `log()` and would
    // therefore strip the address from the LOCAL row too. That passes every
    // upload-side assertion above and quietly destroys the user's own record of
    // which mailbox they connected — on their own machine, where no support
    // grant is involved and nothing left the building.
    it("keeps the mailbox address in the local audit record", async () => {
      await logMailboxConnect();

      const localEntry = mockDatabaseService.insertAuditLog.mock
        .calls[0][0] as AuditLogEntry;

      expect(localEntry.metadata).toEqual({
        provider: "google",
        email: MAILBOX_ADDRESS,
      });
    });

    it("still marks the rows synced, so they are not uploaded again", async () => {
      await logContactCreate();

      expect(mockDatabaseService.markAuditLogsSynced).toHaveBeenCalledTimes(1);
      expect(auditService.getPendingSyncCount()).toBe(0);
    });

    // The local row is the user's own audit trail on their own machine. The
    // problem is the upload, so the strip must not reach back into it.
    it("does not mutate the entry written to the local database", async () => {
      await logContactCreate();

      const localEntry = mockDatabaseService.insertAuditLog.mock
        .calls[0][0] as AuditLogEntry;

      expect(localEntry.metadata).toEqual({
        name: CONTACT_NAME,
        source: "manual",
      });
    });
  });

  // -----------------------------------------------------------------------
  // Control 2 — the over-correction guard, from the other side.
  // -----------------------------------------------------------------------
  describe("with a live support-access grant", () => {
    it("uploads the contact's name", async () => {
      wireGate(await grant7d());

      await logContactCreate();

      const [entry] = uploadedEntries();

      expect(entry.action).toBe("CONTACT_CREATE");
      expect(entry.metadata).toEqual({
        name: CONTACT_NAME,
        source: "manual",
      });
    });

    it("uploads the property address", async () => {
      wireGate(await grant7d());

      await logDataExport();

      const [entry] = uploadedEntries();

      expect(entry.metadata).toEqual({
        propertyAddress: PROPERTY_ADDRESS,
        format: "pdf",
      });
    });

    it("uploads the user's own mailbox address", async () => {
      wireGate(await grant7d());

      await logMailboxConnect();

      const [entry] = uploadedEntries();

      expect(entry.action).toBe("MAILBOX_CONNECT");
      expect(entry.metadata).toEqual({
        provider: "google",
        email: MAILBOX_ADDRESS,
      });
    });
  });

  // -----------------------------------------------------------------------
  // Control 3 — an expired window is not a live one.
  // -----------------------------------------------------------------------
  describe("with an expired support-access grant", () => {
    it("strips the name once the wall clock passes expiresAt", async () => {
      const service = await grant7d();
      wireGate(service);

      // Same service instance, same persisted grant. Only the clock moves.
      expect(service.isActive()).toBe(true);
      now = T0 + 7 * 24 * 60 * 60 * 1000 + 1;
      expect(service.isActive()).toBe(false);

      await logContactCreate();

      const [entry] = uploadedEntries();

      expect(entry.action).toBe("CONTACT_CREATE");
      expect(entry.metadata).not.toHaveProperty("name");
      expect(JSON.stringify(entry)).not.toContain(CONTACT_NAME);
    });

    it("strips the name after the grant is revoked, before it would expire", async () => {
      const service = await grant7d();
      wireGate(service);
      await service.revoke();

      await logContactCreate();

      const [entry] = uploadedEntries();

      expect(entry.metadata).not.toHaveProperty("name");
      expect(JSON.stringify(entry)).not.toContain(CONTACT_NAME);
    });
  });

  // -----------------------------------------------------------------------
  // The gate has to cover every route to `batchInsertAuditLogs`. There are
  // two: the in-memory queue, and the fallback to `getUnsyncedAuditLogs()`
  // for rows written on an earlier run.
  //
  // Until BACKLOG-3987 the fallback was dead: `syncToCloud` returned early on
  // an empty queue, so the `else` never ran (this block used to pin that).
  // BACKLOG-3987 made it live, so rows recovered from the table now reach the
  // upload and must be stripped exactly like queued ones.
  // -----------------------------------------------------------------------
  describe("the database fallback in syncToCloud", () => {
    it("strips third-party PII from rows recovered from the table (BACKLOG-3987)", async () => {
      mockDatabaseService.getUnsyncedAuditLogs.mockResolvedValue([
        {
          id: "audit-recovered-1",
          timestamp: new Date(T0),
          userId: "user-1",
          action: "CONTACT_CREATE" as AuditAction,
          resourceType: "CONTACT" as ResourceType,
          resourceId: "contact-9",
          metadata: { name: CONTACT_NAME, source: "manual" },
          success: true,
        } satisfies AuditLogEntry,
      ]);

      // Nothing queued — the restart state the fallback exists for.
      expect(auditService.getPendingSyncCount()).toBe(0);

      await auditService.syncToCloud();

      expect(mockDatabaseService.getUnsyncedAuditLogs).toHaveBeenCalledTimes(1);
      expect(mockSupabaseService.batchInsertAuditLogs).toHaveBeenCalledTimes(1);
      const [uploaded] = mockSupabaseService.batchInsertAuditLogs.mock.calls[0][0];
      expect(uploaded.id).toBe("audit-recovered-1");
      expect(uploaded.metadata).toEqual({ source: "manual" });
      expect(JSON.stringify(uploaded)).not.toContain(CONTACT_NAME);
    });
  });

  // -----------------------------------------------------------------------
  // BACKLOG-3339: raw free text (error_message, and metadata.error) does not
  // leave the machine outside a support window — live sends and the 3987
  // table backfill alike. The real-driver backfill control is in
  // db/__tests__/auditCloudStrip-3339.test.ts (S2).
  // -----------------------------------------------------------------------
  describe("free-text fields (BACKLOG-3339)", () => {
    /** A raw error message of the shape a failed contact write produces. */
    const RAW_ERROR = `Contact "${CONTACT_NAME}" at ${PROPERTY_ADDRESS} could not be saved`;

    const logFailedLogin = async (): Promise<void> => {
      await auditService.log({
        userId: "user-1",
        action: "LOGIN_FAILED" as AuditAction,
        resourceType: "SESSION" as ResourceType,
        metadata: { provider: "microsoft", error: RAW_ERROR },
        success: false,
        errorMessage: RAW_ERROR,
      });
      await auditService.syncToCloud();
    };

    it("live send: uploads the failed entry without error_message or metadata.error", async () => {
      await logFailedLogin();
      const [uploaded] = uploadedEntries();
      expect(uploaded.action).toBe("LOGIN_FAILED");
      expect(uploaded.userId).toBe("user-1");
      expect(uploaded.success).toBe(false);
      expect(uploaded.errorMessage).toBeUndefined();
      expect(uploaded.metadata).toEqual({ provider: "microsoft" });
      expect(JSON.stringify(uploaded)).not.toContain(CONTACT_NAME);
    });

    it("keeps error_message in the local audit record", async () => {
      await logFailedLogin();
      const local = mockDatabaseService.insertAuditLog.mock.calls[0][0] as AuditLogEntry;
      expect(local.errorMessage).toBe(RAW_ERROR);
      expect(local.metadata).toEqual({ provider: "microsoft", error: RAW_ERROR });
    });

    it("backfill: strips error_message from rows recovered from the table", async () => {
      mockDatabaseService.getUnsyncedAuditLogs.mockResolvedValue([
        {
          id: "audit-recovered-err",
          timestamp: new Date(T0),
          userId: "user-1",
          action: "CONTACT_CREATE" as AuditAction,
          resourceType: "CONTACT" as ResourceType,
          success: false,
          errorMessage: RAW_ERROR,
          ipAddress: "203.0.113.7",
          userAgent: "fixture-agent",
        } satisfies AuditLogEntry,
      ]);
      expect(auditService.getPendingSyncCount()).toBe(0);

      await auditService.syncToCloud();

      const [uploaded] = uploadedEntries();
      expect(uploaded.id).toBe("audit-recovered-err");
      expect(uploaded.success).toBe(false);
      expect(uploaded.errorMessage).toBeUndefined();
      expect(uploaded.ipAddress).toBeUndefined();
      expect(uploaded.userAgent).toBeUndefined();
      expect(JSON.stringify(uploaded)).not.toContain(CONTACT_NAME);
    });

    it("uploads error_message while a support-access window is open", async () => {
      wireGate(await grant7d());
      await logFailedLogin();
      const [uploaded] = uploadedEntries();
      expect(uploaded.errorMessage).toBe(RAW_ERROR);
    });
  });

  // -----------------------------------------------------------------------
  // Fails closed, in both directions.
  // -----------------------------------------------------------------------
  describe("when the gate cannot answer", () => {
    it("strips when no gate has been wired at all", async () => {
      // Nothing calls setSupportAccessGate — the wiring in
      // authHandlers.initializeDatabase has been deleted or has not run yet.
      await logContactCreate();

      const [entry] = uploadedEntries();

      expect(entry.metadata).not.toHaveProperty("name");
      expect(JSON.stringify(entry)).not.toContain(CONTACT_NAME);
    });

    it("strips, and still uploads, when the gate throws", async () => {
      auditService.setSupportAccessGate({
        isActive: () => {
          throw new Error("support access singleton could not be built");
        },
      });

      await logContactCreate();

      const [entry] = uploadedEntries();

      // The batch was not stranded by the throw…
      expect(entry.action).toBe("CONTACT_CREATE");
      expect(mockDatabaseService.markAuditLogsSynced).toHaveBeenCalledTimes(1);
      // …and it did not carry the name.
      expect(entry.metadata).not.toHaveProperty("name");
    });
  });
});
