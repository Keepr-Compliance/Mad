/**
 * Google Messages for Web cache Sync: atomic, limit-aware import — BACKLOG-3658.
 *
 * A cache job no longer writes chats as they arrive. It STAGES them:
 *
 *   /chat        → rcs_cache_staging_chats + rcs_cache_staging_messages
 *                  (the message JSON carries its reactions)
 *   /attachment  → the bytes as a file under <userData>/rcs-cache-staging/<job>/
 *                  + an rcs_cache_staging_images row (parent must be staged)
 *
 * Only when the job FINISHES does {@link RcsCacheStaging.commit} run:
 *
 *   1. read every staged message's (chat, msg-id, sent_at) — no bodies;
 *   2. {@link selectForCommit}: newest first; drop what is older than the
 *      user's months setting (the floor); keep the newest N per the max
 *      messages setting — messages inside a deal's audit period never count
 *      against N and are always kept (the import plan's Cap' rule);
 *   3. move the kept images' files into message-attachments (content-addressed,
 *      as today) — before the database transaction, since that one is sync;
 *   4. ONE database transaction: every chat through the same writer as before
 *      (key, rows, content guard, participants, reactions, legacy removals),
 *      then the kept images' attachment rows. A throw rolls all of it back and
 *      the files placed in step 3 are deleted again;
 *   5. the job's staging rows and folder are deleted, whatever happened.
 *
 * Reactions and images follow their parent message: a dropped message drops
 * its reactions (same JSON) and its images (filtered by parent).
 *
 * Cancel / error / user switch / quit → {@link RcsCacheStaging.discard}: rows
 * and files gone, nothing was ever written to messages. A job that ended is
 * remembered, so a late /chat or /attachment of it stages nothing.
 *
 * Dependencies are injected so jest runs this against the real SQL with a
 * temp folder.
 */

import * as crypto from "crypto";
import * as path from "path";

import type { RcsChatPeople, RcsImportResult, RcsIncomingChat, RcsIncomingMessage } from "./rcsImportStore";
import { RCS_MAX_IMAGE_BYTES, rcsImageExt, type RcsImageResult, type RcsIncomingImage } from "./rcsImportMedia";

/** Staged image bytes per job. Over it, an image is refused as too large (counted, never silent). */
export const RCS_CACHE_STAGING_MAX_BYTES = 2 * 1024 * 1024 * 1024;

export interface StagedMessageKey {
  chatHash: string;
  msgId: string;
  sentAt: string;
}

export interface StagedChatRow {
  chatHash: string;
  userId: string;
  conversationId: string;
  title: string;
  peopleJson: string;
}

export interface StagedImageRow {
  chatHash: string;
  msgId: string;
  idx: number;
  mimeType: string;
  byteSize: number;
  sha256: string;
  tempPath: string;
}

export interface RcsStagingDbOps {
  /** Run `fn` in one database transaction; a throw rolls everything back. */
  inTransaction<T>(fn: () => T): T;
  putChat(jobId: string, row: StagedChatRow): void;
  putMessage(jobId: string, chatHash: string, msgId: string, sentAt: string, seq: number, json: string): void;
  hasMessage(jobId: string, chatHash: string, msgId: string): boolean;
  putImage(jobId: string, row: StagedImageRow): void;
  stagedImageBytes(jobId: string): number;
  messageKeys(jobId: string): StagedMessageKey[];
  chats(jobId: string): StagedChatRow[];
  chatMessages(jobId: string, chatHash: string): Array<{ msgId: string; messageJson: string }>;
  images(jobId: string): StagedImageRow[];
  deleteJob(jobId: string): void;
  deleteAll(): void;
  /** Every job id with staging rows or journaled files. */
  jobIds(): string[];
  /** SR S2: a file the commit is about to move into message-attachments. */
  journalPlaced(jobId: string, filePath: string): void;
  /** SR S2: the job's journal is done with (after the commit, or a failure). */
  journalClear(jobId: string): void;
  journalRows(): Array<{ jobId: string; path: string }>;
  journalDelete(filePath: string): void;
  /** Does any attachments row (any user, any source) still point to this file? */
  fileStillReferenced(filePath: string): boolean;
}

export interface RcsStagingFs {
  /** `<userData>/rcs-cache-staging`. */
  stagingRoot: string;
  /** `<userData>/message-attachments`. */
  attachmentsDir: string;
  mkdir(dir: string): Promise<void>;
  writeFile(filePath: string, data: Buffer): Promise<void>;
  exists(filePath: string): Promise<boolean>;
  /** Move a staged file into place (same volume: a rename). */
  move(from: string, to: string): Promise<void>;
  /** Never throws. */
  unlink(filePath: string): Promise<void>;
  /** Recursive; never throws. */
  removeDir(dir: string): Promise<void>;
  /** Entry names in a folder; [] when it does not exist. */
  listDir(dir: string): Promise<string[]>;
}

/** The writers the commit reuses — the cache job's existing write path. */
export interface RcsCommitWriter {
  /** Store one chat for the user: synchronous (it runs inside the transaction). */
  storeChat(chat: RcsIncomingChat, userId: string, people: RcsChatPeople): RcsImportResult;
  /** external_id -> id for this user (read once, after every chat is stored). */
  getMessageIdMap(userId: string): Map<string, string>;
  /** `${message_id}:${filename}` of every attachment (read once). */
  getExistingAttachmentRecords(): Set<string>;
  insertAttachment(params: {
    id: string;
    messageId: string;
    externalMessageId: string;
    filename: string;
    mimeType: string;
    fileSizeBytes: number;
    storagePath: string;
  }): void;
  markMessageHasAttachments(messageId: string): number;
  /** gmweb2:<chat hash>:<msg-id> (rcsImportStore.rcsExternalId). */
  externalId(chatHash: string, msgId: string): string;
  /** gmweb-<msgId>-<idx><ext> (rcsImportMedia.rcsImageFilename). */
  imageFilename(msgId: string, idx: number, mimeType: string): string;
}

/** What the user's settings allow, frozen when the job started (rcsCacheService.cacheWindow). */
export interface CacheLimits {
  /** Messages older than this are dropped (the months setting, widened for audit periods). */
  floorMs: number;
  /** Max messages outside protected spans; null = Unlimited. */
  cap: number | null;
  /** Deal audit periods: always kept, never counted against `cap`. */
  protectedSpans: Array<{ startMs: number; endMs: number | null }>;
}

export interface CommitSelection {
  /** `${chatHash}\u0000${msgId}` of every kept message. */
  kept: Set<string>;
  staged: number;
  droppedByDate: number;
  droppedByCap: number;
}

export interface CacheCommitResult {
  staged: number;
  kept: number;
  droppedByDate: number;
  droppedByCap: number;
  chats: number;
  stored: number;
  alreadyPresent: number;
  imagesStaged: number;
  imagesStored: number;
}

const keyOf = (chatHash: string, msgId: string): string => `${chatHash}\u0000${msgId}`;

function inSpan(ms: number, spans: CacheLimits["protectedSpans"]): boolean {
  for (const s of spans) {
    if (ms >= s.startMs && (s.endMs === null || ms <= s.endMs)) return true;
  }
  return false;
}

/**
 * Which staged messages the commit keeps: sorted newest first; older than the
 * floor (or undated) → dropped; inside a protected span → kept and not
 * counted; otherwise kept while fewer than `cap` have been kept.
 */
export function selectForCommit(keys: readonly StagedMessageKey[], limits: CacheLimits): CommitSelection {
  const dated = keys
    .map((k) => ({ k, ms: Date.parse(k.sentAt) }))
    .sort((a, b) => {
      const an = Number.isFinite(a.ms) ? a.ms : -Infinity;
      const bn = Number.isFinite(b.ms) ? b.ms : -Infinity;
      if (an !== bn) return bn - an;
      return keyOf(a.k.chatHash, a.k.msgId) < keyOf(b.k.chatHash, b.k.msgId) ? -1 : 1;
    });
  const kept = new Set<string>();
  let droppedByDate = 0;
  let droppedByCap = 0;
  let counted = 0;
  for (const { k, ms } of dated) {
    if (!Number.isFinite(ms) || ms < limits.floorMs) {
      droppedByDate += 1;
      continue;
    }
    if (inSpan(ms, limits.protectedSpans)) {
      kept.add(keyOf(k.chatHash, k.msgId));
      continue;
    }
    if (limits.cap !== null && counted >= limits.cap) {
      droppedByCap += 1;
      continue;
    }
    counted += 1;
    kept.add(keyOf(k.chatHash, k.msgId));
  }
  return { kept, staged: keys.length, droppedByDate, droppedByCap };
}

/** A staged message's reply to the page: the /chat contract, nothing stored yet. */
function stagedReply(chat: RcsIncomingChat): RcsImportResult {
  let reactions = 0;
  for (const m of chat.messages) reactions += m.reactions?.length ?? 0;
  return {
    received: chat.messages.length,
    stored: 0,
    alreadyPresent: 0,
    linked: 0,
    reactions,
    reactionsStored: 0,
    removedByUser: 0,
    sameContent: 0,
  };
}

/** Thrown when a chat or image arrives for a job that already ended. */
export class RcsStagingJobEndedError extends Error {
  constructor() {
    super("This Sync is over.");
    this.name = "RcsStagingJobEndedError";
  }
}

export class RcsCacheStaging {
  /** Jobs that committed or were discarded: late requests stage nothing. */
  private readonly ended = new Set<string>();
  /** SR B1: jobs whose commit is running — a sweep never touches them. */
  private readonly committing = new Set<string>();

  /** True while a commit runs (Keepr treats it as busy: no new Sync, no clear). */
  get isCommitting(): boolean {
    return this.committing.size > 0;
  }

  constructor(
    private readonly db: RcsStagingDbOps,
    private readonly files: RcsStagingFs,
  ) {}

  private jobDir(jobId: string): string {
    // The job id is a Keepr UUID; anything else never becomes a path.
    const safe = /^[A-Za-z0-9-]{1,64}$/.test(jobId) ? jobId : crypto.createHash("sha256").update(jobId).digest("hex");
    return path.join(this.files.stagingRoot, safe);
  }

  isEnded(jobId: string): boolean {
    return this.ended.has(jobId);
  }

  /** Stage one chat (replaces what this job staged for the same chat/message). */
  stageChat(jobId: string, userId: string, chat: RcsIncomingChat, people: RcsChatPeople, chatHash: string): RcsImportResult {
    if (this.ended.has(jobId)) throw new RcsStagingJobEndedError();
    this.db.inTransaction(() => {
      this.db.putChat(jobId, {
        chatHash,
        userId,
        conversationId: chat.conversationId,
        title: chat.title,
        peopleJson: JSON.stringify(people),
      });
      chat.messages.forEach((m, seq) => {
        this.db.putMessage(jobId, chatHash, m.msgId, m.sentAt, seq, JSON.stringify(m));
      });
    });
    return stagedReply(chat);
  }

  /** Stage one image of a staged message: bytes to a file, a row to the table. */
  async stageImage(jobId: string, image: RcsIncomingImage, chatHash: string): Promise<RcsImageResult> {
    if (this.ended.has(jobId)) throw new RcsStagingJobEndedError();
    const mimeType = image.mimeType.toLowerCase();
    if (!mimeType.startsWith("image/")) return { stored: false, reason: "not_an_image" };
    const bytes = Buffer.from(image.base64, "base64");
    if (bytes.length === 0) return { stored: false, reason: "empty" };
    if (bytes.length > RCS_MAX_IMAGE_BYTES) return { stored: false, reason: "too_large" };
    if (!this.db.hasMessage(jobId, chatHash, image.msgId)) return { stored: false, reason: "message_not_found" };
    if (this.db.stagedImageBytes(jobId) + bytes.length > RCS_CACHE_STAGING_MAX_BYTES) {
      return { stored: false, reason: "too_large" };
    }

    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const ext = rcsImageExt(mimeType);
    // One file per image slot; the name never carries page text.
    const slot = crypto.createHash("sha256").update(`${chatHash}:${image.msgId}:${image.index}`).digest("hex");
    const dir = this.jobDir(jobId);
    const tempPath = path.join(dir, `${slot}${ext}`);
    await this.files.mkdir(dir);
    await this.files.writeFile(tempPath, bytes);
    if (this.ended.has(jobId)) {
      // The job ended while the bytes were written: nothing stays.
      await this.files.unlink(tempPath);
      throw new RcsStagingJobEndedError();
    }
    this.db.putImage(jobId, {
      chatHash,
      msgId: image.msgId,
      idx: image.index,
      mimeType,
      byteSize: bytes.length,
      sha256,
      tempPath,
    });
    return { stored: true, alreadyPresent: false, filename: `${slot}${ext}`, bytes: bytes.length };
  }

  /**
   * The finished job → messages, in ONE transaction, within the limits. The
   * staging is gone afterwards whatever happens; a throw leaves messages as
   * they were.
   */
  async commit(jobId: string, userId: string, limits: CacheLimits, writer: RcsCommitWriter): Promise<CacheCommitResult> {
    this.ended.add(jobId);
    this.committing.add(jobId);
    const placed: string[] = [];
    try {
      const selection = selectForCommit(this.db.messageKeys(jobId), limits);
      const images = this.db.images(jobId).filter((img) => selection.kept.has(keyOf(img.chatHash, img.msgId)));

      // Kept images into message-attachments (content-addressed, as storeImage).
      const finalPath = new Map<StagedImageRow, string>();
      if (images.length > 0) await this.files.mkdir(this.files.attachmentsDir);
      for (const img of images) {
        const ext = rcsImageExt(img.mimeType);
        const target = path.join(this.files.attachmentsDir, `${img.sha256}${ext}`);
        if (!(await this.files.exists(target))) {
          // SR S2: journaled BEFORE the move. A crash before the journal is
          // cleared leaves the row; the next sweep deletes the file only if no
          // attachments row references it (a committed one is kept).
          this.db.journalPlaced(jobId, target);
          await this.files.move(img.tempPath, target);
          placed.push(target);
        }
        finalPath.set(img, target);
      }

      const result = this.db.inTransaction((): CacheCommitResult => {
        let chats = 0;
        let stored = 0;
        let alreadyPresent = 0;
        for (const row of this.db.chats(jobId)) {
          if (row.userId !== userId) continue; // never another user's staging
          const messages: RcsIncomingMessage[] = [];
          for (const m of this.db.chatMessages(jobId, row.chatHash)) {
            if (selection.kept.has(keyOf(row.chatHash, m.msgId))) messages.push(JSON.parse(m.messageJson) as RcsIncomingMessage);
          }
          if (messages.length === 0) continue;
          const people = JSON.parse(row.peopleJson) as RcsChatPeople;
          const r = writer.storeChat({ conversationId: row.conversationId, title: row.title, messages }, userId, people);
          chats += 1;
          stored += r.stored;
          alreadyPresent += r.alreadyPresent;
        }

        let imagesStored = 0;
        if (images.length > 0) {
          const ids = writer.getMessageIdMap(userId);
          const existing = writer.getExistingAttachmentRecords();
          for (const img of images) {
            const externalId = writer.externalId(img.chatHash, img.msgId);
            const messageId = ids.get(externalId);
            if (!messageId) continue;
            const filename = writer.imageFilename(img.msgId, img.idx, img.mimeType);
            if (!existing.has(`${messageId}:${filename}`)) {
              writer.insertAttachment({
                id: crypto.randomUUID(),
                messageId,
                externalMessageId: externalId,
                filename,
                mimeType: img.mimeType,
                fileSizeBytes: img.byteSize,
                storagePath: finalPath.get(img) as string,
              });
              existing.add(`${messageId}:${filename}`);
              imagesStored += 1;
            }
            // A row stored earlier without its image must now show it.
            writer.markMessageHasAttachments(messageId);
          }
        }

        return {
          staged: selection.staged,
          kept: selection.kept.size,
          droppedByDate: selection.droppedByDate,
          droppedByCap: selection.droppedByCap,
          chats,
          stored,
          alreadyPresent,
          imagesStaged: images.length,
          imagesStored,
        };
      });
      placed.length = 0; // committed: the files are referenced now
      return result;
    } finally {
      // A failed commit placed files no row of it points to: delete them
      // again — unless another row (iPhone sync, a transaction Sync) now
      // uses the same content-addressed file.
      for (const p of placed) {
        if (!this.db.fileStillReferenced(p)) await this.files.unlink(p);
      }
      try {
        this.db.journalClear(jobId);
      } finally {
        this.committing.delete(jobId);
        await this.dropStaging(jobId);
      }
    }
  }

  /** Cancel / error / user switch: the job's rows and files go; nothing was written. */
  async discard(jobId: string): Promise<void> {
    this.ended.add(jobId);
    await this.dropStaging(jobId);
  }

  /**
   * Every job's staging (stale rows when a new job starts; app quit) — but
   * never a job whose commit is running (SR B1). Also finishes the journal of
   * a commit that crashed (SR S2): a journaled file no attachments row uses
   * is deleted.
   */
  async discardAll(): Promise<void> {
    await this.recoverPlacedFiles();
    if (this.committing.size === 0) {
      this.db.deleteAll();
      await this.files.removeDir(this.files.stagingRoot);
      return;
    }
    for (const id of this.db.jobIds()) {
      if (!this.committing.has(id)) this.db.deleteJob(id);
    }
    const keep = new Set(Array.from(this.committing, (id) => path.basename(this.jobDir(id))));
    for (const name of await this.files.listDir(this.files.stagingRoot)) {
      if (!keep.has(name)) await this.files.removeDir(path.join(this.files.stagingRoot, name));
    }
  }

  /** SR S2: files a crashed commit moved into place but never recorded. */
  async recoverPlacedFiles(): Promise<number> {
    let removed = 0;
    for (const row of this.db.journalRows()) {
      if (this.committing.has(row.jobId)) continue;
      if (!this.db.fileStillReferenced(row.path)) {
        await this.files.unlink(row.path);
        removed += 1;
      }
      this.db.journalDelete(row.path);
    }
    return removed;
  }

  private async dropStaging(jobId: string): Promise<void> {
    try {
      this.db.deleteJob(jobId);
    } finally {
      await this.files.removeDir(this.jobDir(jobId));
    }
  }
}
