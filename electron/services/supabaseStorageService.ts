/**
 * Supabase Storage Service (BACKLOG-393)
 *
 * Handles file uploads to Supabase Storage for B2B broker portal.
 * Used when submitting transactions for broker review.
 *
 * Storage Bucket: submission-attachments
 * Path Convention: {org_id}/{submission_id}/{local_attachment_id}/{filename}
 *
 * BACKLOG-3554: the local attachment id segment makes every attachment's path
 * unique within a submission. Without it, two attachments with the same name
 * (`image001.png` from two emails) resolved to one object and the second was
 * recorded against the first one's bytes. The file name stays the LAST segment
 * because the broker portal's download names the saved file from it.
 * The live storage policies read only segments 1 (org) and 2 (submission).
 *
 * @see supabase/migrations/20260122_b2b_broker_portal.sql for bucket setup
 */

import mime from "mime-types";
import * as Sentry from "@sentry/electron/main";
import supabaseService from "./supabaseService";
import logService from "./logService";
import { readStoredAttachment } from "./atRest/attachmentReader";
// BACKLOG-3403: shared with the submission pre-flight and manifest.
import {
  MAX_ATTACHMENT_FILE_SIZE,
  buildAttachmentStoragePath,
  resolveAttachmentPath,
} from "./submissionAttachmentFiles";

export { buildAttachmentStoragePath };

// ============================================
// TYPES & INTERFACES
// ============================================

/** Upload progress for a single file */
export interface UploadProgress {
  filename: string;
  bytesUploaded: number;
  totalBytes: number;
  percentage: number;
  status: "pending" | "uploading" | "complete" | "failed";
  error?: string;
}

/** Result of uploading a single attachment */
export interface AttachmentUploadResult {
  localId: string;
  storagePath: string;
  publicUrl?: string;
  success: boolean;
  error?: string;
  mimeType?: string;
  fileSizeBytes?: number;
  /**
   * BACKLOG-3554: the storage API answered "already exists" for this path.
   * Never a success by itself — see `uploadAttachmentWithRetry`.
   */
  alreadyExists?: boolean;
  /** BACKLOG-3554: this attempt actually sent the upload request to storage. */
  uploadRequestIssued?: boolean;
}

/** BACKLOG-3403: options for {@link SupabaseStorageService.uploadAttachmentWithRetry}. */
export interface UploadRetryOptions {
  /**
   * An earlier pass of THIS submission already sent this upload (the re-run
   * after a finalize refusal). The path embeds this submission's own
   * client-minted id and the local attachment id, so an object already at it
   * can only be that earlier pass's bytes: "already exists" is then a success.
   */
  earlierAttemptMayHaveSent?: boolean;
}

// ============================================
// CONSTANTS
// ============================================

const STORAGE_BUCKET = "submission-attachments";
const MAX_FILE_SIZE = MAX_ATTACHMENT_FILE_SIZE;
const MAX_RETRIES = 3;
const RETRY_DELAY_BASE = 1000; // 1 second

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Get MIME type from filename
 */
function getMimeType(filename: string): string {
  return mime.lookup(filename) || "application/octet-stream";
}

/**
 * Storage API answer for an object that is already at the path. Supabase
 * documents it in two shapes (guides/storage/debugging/error-codes and
 * uploads/standard-uploads): body `statusCode: "409"` / "The resource already
 * exists", and HTTP 400 "Asset Already Exists". storage-js copies the body's
 * `statusCode` and message onto its `StorageApiError`.
 */
function isAlreadyExistsError(
  error: { message?: string; statusCode?: string } | null | undefined
): boolean {
  if (!error) return false;
  return error.statusCode === "409" || /already exists/i.test(error.message ?? "");
}

// ============================================
// SERVICE CLASS
// ============================================

class SupabaseStorageService {
  /**
   * Upload a single attachment to Supabase Storage
   *
   * @param orgId - Organization ID for path organization
   * @param submissionId - Submission ID for path organization
   * @param attachmentId - Local attachment id (unique within the submission)
   * @param localPath - Local filesystem path to the file
   * @param filename - Original filename
   * @param onProgress - Optional progress callback
   * @returns Upload result with storage path
   */
  async uploadAttachment(
    orgId: string,
    submissionId: string,
    attachmentId: string,
    localPath: string,
    filename: string,
    onProgress?: (progress: UploadProgress) => void
  ): Promise<AttachmentUploadResult> {
    const storagePath = buildAttachmentStoragePath(
      orgId,
      submissionId,
      attachmentId,
      filename
    );

    let uploadRequestIssued = false;
    try {
      // Resolve and check local file
      const absolutePath = resolveAttachmentPath(localPath);

      // Read file into buffer first, then validate size — avoids TOCTOU race
      // between a separate stat() and readFile()
      let fileBuffer: Buffer;
      try {
        // BACKLOG-3816 S2: the broker receives the PLAINTEXT, decrypted on read.
        fileBuffer = await readStoredAttachment(absolutePath);
      } catch (err: unknown) {
        if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT") {
          const error = `File not found: ${absolutePath}`;
          logService.warn(
            `[Storage] ${error}`,
            "SupabaseStorageService"
          );
          onProgress?.({
            filename,
            bytesUploaded: 0,
            totalBytes: 0,
            percentage: 0,
            status: "failed",
            error,
          });
          return {
            localId: localPath,
            storagePath: "",
            success: false,
            error,
          };
        }
        throw err;
      }

      const fileSizeBytes = fileBuffer.length;

      // Check file size
      if (fileSizeBytes > MAX_FILE_SIZE) {
        const error = `File too large: ${(fileSizeBytes / 1024 / 1024).toFixed(2)}MB (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`;
        logService.warn(`[Storage] ${error}`, "SupabaseStorageService");
        onProgress?.({
          filename,
          bytesUploaded: 0,
          totalBytes: fileSizeBytes,
          percentage: 0,
          status: "failed",
          error,
        });
        return {
          localId: localPath,
          storagePath: "",
          success: false,
          error,
          fileSizeBytes,
        };
      }

      // Report uploading status
      onProgress?.({
        filename,
        bytesUploaded: 0,
        totalBytes: fileSizeBytes,
        percentage: 0,
        status: "uploading",
      });
      const mimeType = getMimeType(filename);

      logService.debug(
        `[Storage] Uploading ${filename} (${(fileSizeBytes / 1024).toFixed(1)}KB) to ${storagePath}`,
        "SupabaseStorageService"
      );

      // Get Supabase client
      const client = supabaseService.getClient();

      // Upload to Supabase Storage. From here on the request may have reached
      // storage even if we never see its answer (BACKLOG-3554).
      uploadRequestIssued = true;
      const { data, error } = await client.storage
        .from(STORAGE_BUCKET)
        .upload(storagePath, fileBuffer, {
          contentType: mimeType,
          upsert: false, // Don't overwrite existing
        });

      if (error) {
        // BACKLOG-3554: "already exists" is NOT a success. It used to be, and
        // with a name-only path that recorded a different file's bytes against
        // this row. Whether it is this attachment's own earlier attempt is
        // decided by `uploadAttachmentWithRetry`, which knows the history.
        if (isAlreadyExistsError(error)) {
          const message = `Storage already holds an object at ${storagePath}`;
          logService.warn(`[Storage] ${message}`, "SupabaseStorageService");
          onProgress?.({
            filename,
            bytesUploaded: 0,
            totalBytes: fileSizeBytes,
            percentage: 0,
            status: "failed",
            error: message,
          });
          return {
            localId: localPath,
            storagePath: "",
            success: false,
            error: message,
            mimeType,
            fileSizeBytes,
            alreadyExists: true,
            uploadRequestIssued: true,
          };
        }
        throw error;
      }

      // Report complete
      onProgress?.({
        filename,
        bytesUploaded: fileSizeBytes,
        totalBytes: fileSizeBytes,
        percentage: 100,
        status: "complete",
      });

      logService.info(
        `[Storage] Uploaded ${filename} successfully`,
        "SupabaseStorageService"
      );

      return {
        localId: localPath,
        storagePath: data.path,
        success: true,
        mimeType,
        fileSizeBytes,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      logService.error(
        `[Storage] Upload failed for ${filename}: ${errorMessage}`,
        "SupabaseStorageService"
      );
      Sentry.captureException(error, {
        tags: { service: "supabase-storage", operation: "uploadAttachment" },
      });

      onProgress?.({
        filename,
        bytesUploaded: 0,
        totalBytes: 0,
        percentage: 0,
        status: "failed",
        error: errorMessage,
      });

      return {
        localId: localPath,
        storagePath: "",
        success: false,
        error: errorMessage,
        // BACKLOG-3554: only an UNCLEAR outcome may have stored the bytes. A
        // definitive HTTP answer below 500 (403 policy, 413 too large) means
        // nothing was written, so a later "already exists" is not ours.
        // StorageUnknownError (transport) carries no numeric status.
        uploadRequestIssued:
          uploadRequestIssued &&
          !(
            typeof (error as { status?: unknown })?.status === "number" &&
            (error as { status: number }).status < 500
          ),
      };
    }
  }

  /**
   * Upload a single attachment with retry logic
   *
   * BACKLOG-3554 — "already exists" on this attachment's own path:
   * - after an earlier attempt IN THIS LOOP sent the upload and lost the
   *   answer, the object is that attempt's bytes (same attachment, same file,
   *   a path holding a per-call random submission id) → success, same path;
   * - otherwise (first attempt, or only pre-upload failures before it) the
   *   object is not ours → failure, no further retries.
   * BACKLOG-3403: the submission row now exists before the upload, but the
   * bytes are still not compared — the path holds this submission's own
   * client-minted id, which is what makes the object ours.
   */
  async uploadAttachmentWithRetry(
    orgId: string,
    submissionId: string,
    attachmentId: string,
    localPath: string,
    filename: string,
    onProgress?: (progress: UploadProgress) => void,
    maxRetries: number = MAX_RETRIES,
    options?: UploadRetryOptions
  ): Promise<AttachmentUploadResult> {
    let lastError: Error | null = null;
    // BACKLOG-3403: a submission that re-runs its uploads after a finalize
    // refusal has already sent this exact path once, so its object is ours.
    let earlierAttemptSentUpload = options?.earlierAttemptMayHaveSent === true;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.uploadAttachment(
          orgId,
          submissionId,
          attachmentId,
          localPath,
          filename,
          onProgress
        );

        if (result.alreadyExists) {
          if (earlierAttemptSentUpload) {
            const storagePath = buildAttachmentStoragePath(
              orgId,
              submissionId,
              attachmentId,
              filename
            );
            logService.info(
              `[Storage] ${filename} was stored by an earlier attempt: ${storagePath}`,
              "SupabaseStorageService"
            );
            onProgress?.({
              filename,
              bytesUploaded: result.fileSizeBytes ?? 0,
              totalBytes: result.fileSizeBytes ?? 0,
              percentage: 100,
              status: "complete",
            });
            return {
              localId: localPath,
              storagePath,
              success: true,
              mimeType: result.mimeType,
              fileSizeBytes: result.fileSizeBytes,
            };
          }
          Sentry.captureMessage("submission attachment path already occupied", {
            level: "warning",
            tags: { service: "supabase-storage", operation: "uploadAttachment" },
          });
          return result;
        }

        if (result.uploadRequestIssued) {
          earlierAttemptSentUpload = true;
        }

        // If successful or non-retryable error (like file not found), return
        if (result.success || result.error?.includes("File not found")) {
          return result;
        }

        // Retry on failure
        lastError = new Error(result.error || "Upload failed");

        if (attempt < maxRetries) {
          const delay = RETRY_DELAY_BASE * Math.pow(2, attempt - 1);
          logService.info(
            `[Storage] Retrying ${filename} in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`,
            "SupabaseStorageService"
          );
          await sleep(delay);
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error("Unknown error");
        if (attempt < maxRetries) {
          const delay = RETRY_DELAY_BASE * Math.pow(2, attempt - 1);
          await sleep(delay);
        }
      }
    }

    return {
      localId: localPath,
      storagePath: "",
      success: false,
      error: lastError?.message || "Upload failed after retries",
    };
  }

  /**
   * Get a signed URL for viewing a file (for broker portal)
   *
   * @param storagePath - Path in Supabase Storage
   * @param expiresIn - URL expiration in seconds (default: 1 hour)
   * @returns Signed URL
   */
  async getSignedUrl(
    storagePath: string,
    expiresIn: number = 3600
  ): Promise<string> {
    try {
      const client = supabaseService.getClient();
      const { data, error } = await client.storage
        .from(STORAGE_BUCKET)
        .createSignedUrl(storagePath, expiresIn);

      if (error) {
        throw error;
      }

      return data.signedUrl;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logService.error(
        `[Storage] Failed to create signed URL for ${storagePath}: ${errorMessage}`,
        "SupabaseStorageService"
      );
      Sentry.captureException(error, {
        tags: { service: "supabase-storage", operation: "getSignedUrl" },
      });
      throw error;
    }
  }

  /**
   * Delete an attachment from storage (cleanup on failure)
   *
   * @param storagePath - Path in Supabase Storage
   */
  async deleteAttachment(storagePath: string): Promise<void> {
    try {
      const client = supabaseService.getClient();
      const { error } = await client.storage
        .from(STORAGE_BUCKET)
        .remove([storagePath]);

      if (error) {
        throw error;
      }

      logService.info(
        `[Storage] Deleted ${storagePath}`,
        "SupabaseStorageService"
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logService.error(
        `[Storage] Failed to delete ${storagePath}: ${errorMessage}`,
        "SupabaseStorageService"
      );
      Sentry.captureException(error, {
        tags: { service: "supabase-storage", operation: "deleteAttachment" },
      });
      throw error;
    }
  }

  /**
   * Check if file exists in storage
   *
   * @param storagePath - Path in Supabase Storage
   * @returns true if file exists
   */
  async fileExists(storagePath: string): Promise<boolean> {
    try {
      const client = supabaseService.getClient();

      // Parse the path to get folder and filename
      const parts = storagePath.split("/");
      const filename = parts.pop()!;
      const folder = parts.join("/");

      const { data, error } = await client.storage
        .from(STORAGE_BUCKET)
        .list(folder, {
          search: filename,
        });

      if (error) {
        return false;
      }

      return data.some((f) => f.name === filename);
    } catch {
      return false;
    }
  }
}

// Export singleton
export const supabaseStorageService = new SupabaseStorageService();
export default supabaseStorageService;
