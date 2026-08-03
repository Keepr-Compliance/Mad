/**
 * Supabase transport for support reports (BACKLOG-2393)
 *
 * Reuses the mediated write path that already exists: the desktop client holds
 * only the anon key, RLS lets a requester write objects under their own ticket
 * prefix, and the `support_ticket_attachments` row is inserted by a
 * SECURITY DEFINER RPC. No client-side insert policy is added, and no
 * service-role key comes near the desktop app.
 *
 * One ticket per grant, so a support window reads as a single conversation
 * rather than N unrelated tickets with one attachment each.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import * as Sentry from "@sentry/electron/main";
import type { SupabaseClient } from "@supabase/supabase-js";
import { redactId, redactLocalPaths } from "../../utils/redactSensitive";
import type {
  SupportReportUpload,
  SupportRemoteRef,
  SupportUploadResult,
  SupportUploadTransport,
} from "./types";

const BUCKET = "support-attachments";
const TICKET_MAP_FILENAME = "tickets.json";

export interface SupportRequester {
  email: string;
  name: string;
}

export interface SupabaseSupportTransportDeps {
  getClient: () => SupabaseClient;
  getRequester: () => Promise<SupportRequester | null>;
  /** Directory holding support-access state; the ticket map lives here. */
  baseDir: string;
  /** Consent id -> human label, used for the ticket subject. */
  describeGrant?: (consentId: string) => string;
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

export class SupabaseSupportTransport implements SupportUploadTransport {
  private deps: SupabaseSupportTransportDeps;
  private ticketMap: Record<string, string> | null = null;

  constructor(deps: SupabaseSupportTransportDeps) {
    this.deps = deps;
  }

  private get ticketMapPath(): string {
    return path.join(this.deps.baseDir, TICKET_MAP_FILENAME);
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    this.deps.log?.(level, message);
  }

  /**
   * BACKLOG-2431: report a transport failure to Sentry.
   *
   * Until this existed, `grep Sentry electron/services/supportAccess/` returned
   * nothing. A user could grant support access for seven days, have every
   * upload fail, and nobody here would know — the exact silence BACKLOG-2430
   * was filed to end, one layer further out. The scheduled path is the one that
   * matters: `flush()` catches this throw, calls `queue.markFailed`, and logs
   * locally, so it never reaches the `wrapHandler` IPC net that captures
   * everything else.
   *
   * WHAT IS SENT: the failure class and reason only. Not the report body (it is
   * sealed client diagnostics — real client names and phone numbers, PII
   * scrubbing still pending under BACKLOG-2397), not the requester's email or
   * name, not `baseDir`, and not the object's file name. Sizes and content type
   * are safe and are what distinguish a quota failure from a MIME rejection.
   *
   * The reason string is run through `redactLocalPaths` because a storage SDK
   * error can echo back an I/O path. This must happen HERE: the `beforeSend`
   * hook in main.ts only scrubs events tagged `component: "auto-updater"`.
   */
  private reportFailure(
    operation: "ensure-ticket" | "upload" | "register-attachment",
    reason: string,
    context: Record<string, string | number | boolean | undefined>,
  ): void {
    try {
      const safeReason = redactLocalPaths(reason);
      Sentry.captureException(
        new Error(`[SupportAccess] ${operation} failed: ${safeReason}`),
        {
          tags: {
            component: "support-access",
            operation,
            transport: "supabase",
          },
          extra: { reason: safeReason, ...context },
        },
      );
    } catch {
      // Telemetry must never be the reason an upload path changes behaviour.
    }
  }

  private async loadTicketMap(): Promise<Record<string, string>> {
    if (this.ticketMap) return this.ticketMap;
    try {
      const raw = await fs.readFile(this.ticketMapPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      this.ticketMap =
        parsed && typeof parsed === "object"
          ? (parsed as Record<string, string>)
          : {};
    } catch {
      this.ticketMap = {};
    }
    return this.ticketMap;
  }

  private async saveTicketMap(): Promise<void> {
    const target = this.ticketMapPath;
    const tmp = `${target}.tmp`;
    await fs.mkdir(this.deps.baseDir, { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(this.ticketMap ?? {}, null, 2), "utf8");
    await fs.rename(tmp, target);
  }

  private async ensureTicket(consentId: string): Promise<string> {
    const map = await this.loadTicketMap();
    const existing = map[consentId];
    if (existing) return existing;

    const requester = await this.deps.getRequester();
    if (!requester?.email) {
      throw new Error(
        "Cannot send a support report while signed out — sign in and it will send on the next attempt",
      );
    }

    const grantLabel =
      this.deps.describeGrant?.(consentId) ?? "Support access window";
    const client = this.deps.getClient();
    const { data, error } = await client.rpc("support_create_ticket", {
      p_subject: `Support access — ${grantLabel}`,
      p_description: [
        "This ticket was opened automatically because support access was granted from the Keepr desktop app.",
        "",
        "Diagnostic reports captured during the access window are attached to it. They are deleted automatically when their retention period ends, and the person who granted access can delete any of them at any time from Settings.",
      ].join("\n"),
      p_priority: "normal",
      p_category_id: null,
      p_subcategory_id: null,
      p_requester_email: requester.email,
      p_requester_name: requester.name || requester.email,
      p_source_channel: "in_app_redirect",
    });
    if (error) {
      // Deliberately no requester email/name in the payload — this is the one
      // failure path that has them in scope, and they are the user's identity,
      // not diagnostic detail.
      this.reportFailure("ensure-ticket", error.message, {
        consentId: redactId(consentId),
      });
      throw new Error(`Could not open a support ticket: ${error.message}`);
    }
    const ticket = data as { id?: string } | null;
    if (!ticket?.id) {
      throw new Error("Support ticket creation returned no ticket id");
    }

    map[consentId] = ticket.id;
    await this.saveTicketMap();
    return ticket.id;
  }

  async upload(upload: SupportReportUpload): Promise<SupportUploadResult> {
    const client = this.deps.getClient();
    const ticketId = await this.ensureTicket(upload.meta.consentId);
    const objectId = randomUUID();
    const storagePath = `${ticketId}/${objectId}/${upload.fileName}`;

    const { error: uploadError } = await client.storage
      .from(BUCKET)
      .upload(storagePath, upload.body, {
        contentType: upload.contentType,
        upsert: false,
      });
    if (uploadError) {
      this.reportFailure("upload", uploadError.message, {
        ticketId: redactId(ticketId),
        contentType: upload.contentType,
        bodyBytes: upload.body.length,
        captureReason: upload.meta.reason,
        retentionDays: upload.retentionDays,
      });
      throw new Error(`Storage upload failed: ${uploadError.message}`);
    }

    const { data, error } = await client.rpc(
      "support_add_diagnostic_attachment",
      {
        p_ticket_id: ticketId,
        p_file_name: upload.fileName,
        p_file_size: upload.body.length,
        p_file_type: upload.contentType,
        p_storage_path: storagePath,
        p_retention_days: upload.retentionDays,
      },
    );

    if (error) {
      // The object landed but the row did not, which would leave a copy on the
      // server that the user can neither see in the list nor delete. Remove it.
      // If the cleanup itself fails we say so in the thrown message rather than
      // pretending the upload simply failed.
      const cleanup = await client.storage.from(BUCKET).remove([storagePath]);
      const orphaned = Boolean(cleanup.error);
      if (orphaned) {
        this.log(
          "error",
          `Orphaned support attachment left at ${storagePath}: ${cleanup.error?.message}`,
        );
      }
      this.reportFailure("register-attachment", error.message, {
        ticketId: redactId(ticketId),
        // An orphan is a copy of client diagnostics stranded on the server that
        // the user can neither see nor delete. Tagged so it can be alerted on.
        orphanedObject: orphaned,
        cleanupError: orphaned
          ? redactLocalPaths(cleanup.error?.message ?? "unknown")
          : undefined,
        contentType: upload.contentType,
        bodyBytes: upload.body.length,
      });
      throw new Error(
        `Attachment registration failed: ${error.message}${
          orphaned
            ? " (a copy could not be removed from storage; contact support to have it deleted)"
            : ""
        }`,
      );
    }

    const row = data as
      | { id?: string; storage_path?: string; expires_at?: string }
      | null;
    if (!row?.id) {
      throw new Error("Attachment registration returned no attachment id");
    }

    return {
      remote: {
        ticketId,
        attachmentId: row.id,
        storagePath: row.storage_path ?? storagePath,
      },
      expiresAt:
        row.expires_at ??
        new Date(
          Date.now() + upload.retentionDays * 24 * 60 * 60 * 1000,
        ).toISOString(),
    };
  }

  /**
   * Delete the stored object *and* the attachment row.
   *
   * Order is deliberate. The object goes first, through the Storage API, which
   * is the only call that removes the actual bytes — a SQL delete of
   * `storage.objects` removes the pointer, not the file. If the row delete then
   * fails we report failure and keep the local copy, so the user retries and
   * finishes the job. Both operations are idempotent, so a retry is safe.
   *
   * The reverse order would be worse in the way that matters: the row would
   * vanish from the list while the file stayed on the server, which is exactly
   * the lie this whole path exists to avoid.
   *
   * Throws unless both halves confirm. A resolved promise here is what the UI
   * turns into the word "deleted", so it has to mean it.
   */
  async deleteRemote(ref: SupportRemoteRef): Promise<void> {
    const client = this.deps.getClient();

    const { error: objectError } = await client.storage
      .from(BUCKET)
      .remove([ref.storagePath]);
    if (objectError) {
      throw new Error(
        `Could not delete the stored file: ${objectError.message}`,
      );
    }

    const { data, error } = await client.rpc("support_delete_own_attachment", {
      p_attachment_id: ref.attachmentId,
    });
    if (error) {
      throw new Error(
        `The file was removed but its record could not be: ${error.message}`,
      );
    }
    const result = data as { deleted?: boolean } | null;
    if (!result?.deleted) {
      throw new Error(
        "Keepr support did not confirm the deletion; the report may still be stored",
      );
    }
  }
}
