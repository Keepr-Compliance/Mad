// ============================================
// CONTACT IPC HANDLERS
// This file contains contact handlers to be registered in main.js
// ============================================

import { ipcMain, BrowserWindow } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { randomUUID } from "crypto";
import databaseService, { TransactionWithRoles as DbTransactionWithRoles } from "../services/databaseService";
import failureLogService from "../services/failureLogService";
import {
  getContactEmailEntries,
  getContactPhoneEntries,
  syncContactEmails,
  setContactPrimaryEmail,
  syncContactPhones,
  setContactPrimaryPhone,
} from "../services/db/contactDbService";
import { getContactNames } from "../services/contactsService";
import { resolveHandles } from "../services/contactResolutionService";
import auditService from "../services/auditService";
import logService from "../services/logService";
import * as externalContactDb from "../services/db/externalContactDbService";
import { queryContacts, isPoolReady } from "../workers/contactWorkerPool";
import { dbAll, dbGet, dbRun } from "../services/db/core/dbConnection";
import type { Contact, Transaction, ContactSource } from "../types/models";

// Import validation utilities
import {
  ValidationError,
  validateContactId,
  validateContactData,
  validateString,
  sanitizeObject,
} from "../utils/validation";
import { normalizePhoneNumber } from "../utils/phoneNormalization";
import { getValidUserId } from "../utils/userIdHelper";
import { isContactSourceEnabled } from "../utils/preferenceHelper";
import contactSyncService from "../services/contactSyncService";
import { OutlookContactProvider } from "../services/providers/outlookContactProvider";
import { GoogleContactProvider } from "../services/providers/googleContactProvider";

// Import handler types
import type {
  AvailableContact,
  ImportableContact,
  ExistingDbContactRecord,
  NewContactData,
} from "../types/handlerTypes";

// Type definitions
interface ContactResponse {
  success: boolean;
  error?: string;
  contact?: Contact;
  contacts?: Contact[] | AvailableContact[];
  contactsStatus?: unknown;
  canDelete?: boolean;
  transactions?: Transaction[] | DbTransactionWithRoles[];
  count?: number;
  transactionCount?: number;
}

/** Reference to mainWindow for emitting progress events */
let _mainWindow: BrowserWindow | null = null;

/**
 * Backfill emails/phones for all imported contacts from external_contacts.
 * Called after external contacts sync to ensure imported contacts have
 * all emails/phones from macOS Contacts.
 */
// Track which users have already been backfilled this session
const backfilledUsers = new Set<string>();

async function backfillImportedContactsFromExternal(userId: string): Promise<{ updated: number }> {
  // Only run once per user per session — this is a maintenance task, not needed on every load
  if (backfilledUsers.has(userId)) {
    return { updated: 0 };
  }
  backfilledUsers.add(userId);

  try {
    // TASK-1956: Use worker pool to run backfill off main thread when available
    if (isPoolReady()) {
      const result = await queryContacts('backfill', userId) as Array<{ updated: number }>;
      const updated = result[0]?.updated ?? 0;
      if (updated > 0) {
        logService.info(`Backfilled ${updated} imported contacts from external_contacts (worker)`, "Contacts", { userId });
      }
      return { updated };
    }

    // Fallback: run on main thread if pool not ready
    let updated = 0;

    const importedSql = `SELECT id, display_name FROM contacts WHERE user_id = ? AND is_imported = 1`;
    const importedContacts = dbAll<{ id: string; display_name: string }>(importedSql, [userId]);

    for (const contact of importedContacts) {
      const externalSql = `SELECT emails_json, phones_json FROM external_contacts WHERE user_id = ? AND name = ?`;
      const external = dbGet<{ emails_json: string; phones_json: string }>(externalSql, [userId, contact.display_name]);

      if (external) {
        const emails: string[] = external.emails_json ? JSON.parse(external.emails_json) : [];
        const phones: string[] = external.phones_json ? JSON.parse(external.phones_json) : [];

        const emailsAdded = await databaseService.backfillContactEmails(contact.id, emails);
        const phonesAdded = await databaseService.backfillContactPhones(contact.id, phones);

        if (emailsAdded > 0 || phonesAdded > 0) {
          updated++;
          logService.debug(`Backfilled contact ${contact.display_name}: +${emailsAdded} emails, +${phonesAdded} phones`, "Contacts");
        }
      }
    }

    if (updated > 0) {
      logService.info(`Backfilled ${updated} imported contacts from external_contacts`, "Contacts", { userId });
    }

    return { updated };
  } catch (error) {
    logService.warn(`Failed to backfill imported contacts: ${error}`, "Contacts");
    return { updated: 0 };
  }
}

/**
 * Register all contact-related IPC handlers
 * @param mainWindow - The main browser window for emitting progress events
 */
export function registerContactHandlers(mainWindow: BrowserWindow): void {
  _mainWindow = mainWindow;

  // TASK-2300: Register contact sync providers
  // TASK-2301: Both providers registered here (not at module load) to avoid side effects during import
  contactSyncService.registerProvider(new OutlookContactProvider());
  contactSyncService.registerProvider(new GoogleContactProvider());

  // Get all imported contacts for a user (local database only)
  ipcMain.handle(
    "contacts:get-all",
    async (
      event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<ContactResponse> => {
      try {
        const t0 = Date.now();

        // BACKLOG-551: Validate user ID exists in local DB
        // BACKLOG-615: Return empty array gracefully during deferred DB init (onboarding)
        const validatedUserId = await getValidUserId(userId, "Contacts");
        if (!validatedUserId) {
          logService.info("[Contacts] No local user yet, returning empty contacts (deferred DB init)", "Contacts");
          return {
            success: true,
            contacts: [],
          };
        }

        // TASK-1956: Use worker thread to avoid blocking main process during contact load
        const importedContacts =
          await databaseService.getImportedContactsByUserIdAsync(validatedUserId);

        logService.debug(
          `[PERF] contacts.getAll: ${Date.now() - t0}ms, ${importedContacts.length} contacts`,
          "Contacts",
        );

        // Backfill missing emails/phones in background (once per session, non-blocking)
        // Deferred so it doesn't block the initial contact list render
        backfillImportedContactsFromExternal(validatedUserId).then((backfillResult) => {
          if (backfillResult.updated > 0) {
            logService.info(
              `Backfilled ${backfillResult.updated} imported contacts with missing emails/phones`,
              "Contacts",
            );
          }
        }).catch((err) => {
          logService.warn(`Background backfill failed: ${err}`, "Contacts");
        });

        return {
          success: true,
          contacts: importedContacts,
        };
      } catch (error) {
        logService.error("Get contacts failed", "Contacts", {
          userId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: `Validation error: ${error.message}`,
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Get available contacts for import (from external sources + unimported DB contacts)
  // TASK-1773: Uses external_contacts shadow table for instant loading
  ipcMain.handle(
    "contacts:get-available",
    async (
      event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<ContactResponse> => {
      try {
        logService.info(
          "[Main] Getting available contacts for import (shadow table)",
          "Contacts",
          { userId },
        );

        // BACKLOG-551: Validate user ID exists in local DB
        // BACKLOG-615: Return empty array gracefully during deferred DB init (onboarding)
        const validatedUserId = await getValidUserId(userId, "Contacts");
        if (!validatedUserId) {
          logService.info("[Contacts] No local user yet, returning empty available contacts (deferred DB init)", "Contacts");
          return {
            success: true,
            contacts: [],
            contactsStatus: { loaded: true },
          };
        }

        // Get already imported contact identifiers to filter them out
        // TASK-1956: Use async worker version to avoid blocking main process
        const importedContacts =
          await databaseService.getImportedContactsByUserIdAsync(validatedUserId);
        const importedNames = new Set(
          importedContacts.map((c) => c.name?.toLowerCase()),
        );
        const importedEmails = new Set(
          importedContacts.map((c) => c.email?.toLowerCase()).filter(Boolean),
        );

        // Build a set of normalized phones from imported contacts
        const importedPhones = new Set<string>();
        for (const ic of importedContacts) {
          if (ic.phone) {
            const normalized = normalizePhoneNumber(ic.phone);
            if (normalized && normalized !== "+") {
              importedPhones.add(normalized);
            }
          }
        }

        // TASK-1950: Check contact source preferences
        const macosEnabled = await isContactSourceEnabled(validatedUserId, "direct", "macosContacts", true);
        const iphoneEnabled = await isContactSourceEnabled(validatedUserId, "direct", "iphoneContacts", true);
        const outlookEnabled = await isContactSourceEnabled(validatedUserId, "direct", "outlookContacts", true);
        const googleContactsEnabled = await isContactSourceEnabled(validatedUserId, "direct", "googleContacts", true);

        // Convert Contacts app data to contact objects
        const availableContacts: AvailableContact[] = [];

        // Deduplication sets for name, email, and phone
        const seenNames = new Set<string>();
        const seenEmails = new Set<string>();
        const seenPhones = new Set<string>();

        /**
         * Check if a contact is a duplicate based on name, email, or phone.
         * Returns true if any identifier matches an already-seen contact.
         */
        function isDuplicate(contact: {
          name?: string | null;
          display_name?: string | null;
          email?: string | null;
          emails?: string[];
          phone?: string | null;
          phones?: string[];
        }): boolean {
          // Check email duplicates
          const email = contact.email?.toLowerCase();
          if (email && seenEmails.has(email)) return true;

          // Check all emails if available
          if (contact.emails) {
            for (const e of contact.emails) {
              if (e && seenEmails.has(e.toLowerCase())) return true;
            }
          }

          // Check phone duplicates (normalized)
          const phone = contact.phone;
          if (phone) {
            const normalizedPhone = normalizePhoneNumber(phone);
            if (
              normalizedPhone &&
              normalizedPhone !== "+" &&
              seenPhones.has(normalizedPhone)
            )
              return true;
          }

          // Check all phones if available
          if (contact.phones) {
            for (const p of contact.phones) {
              if (p) {
                const normalizedPhone = normalizePhoneNumber(p);
                if (
                  normalizedPhone &&
                  normalizedPhone !== "+" &&
                  seenPhones.has(normalizedPhone)
                )
                  return true;
              }
            }
          }

          // Check name duplicates (fallback)
          const nameLower = (
            contact.name || contact.display_name
          )?.toLowerCase();
          if (nameLower && seenNames.has(nameLower)) return true;

          return false;
        }

        /**
         * Mark a contact's identifiers as seen for deduplication.
         */
        function markAsSeen(contact: {
          name?: string | null;
          display_name?: string | null;
          email?: string | null;
          emails?: string[];
          phone?: string | null;
          phones?: string[];
        }): void {
          // Add name
          const nameLower = (
            contact.name || contact.display_name
          )?.toLowerCase();
          if (nameLower) seenNames.add(nameLower);

          // Add email
          const email = contact.email?.toLowerCase();
          if (email) seenEmails.add(email);

          // Add all emails if available
          if (contact.emails) {
            for (const e of contact.emails) {
              if (e) seenEmails.add(e.toLowerCase());
            }
          }

          // Add phone (normalized)
          if (contact.phone) {
            const normalizedPhone = normalizePhoneNumber(contact.phone);
            if (normalizedPhone && normalizedPhone !== "+")
              seenPhones.add(normalizedPhone);
          }

          // Add all phones if available
          if (contact.phones) {
            for (const p of contact.phones) {
              if (p) {
                const normalizedPhone = normalizePhoneNumber(p);
                if (normalizedPhone && normalizedPhone !== "+")
                  seenPhones.add(normalizedPhone);
              }
            }
          }
        }

        // STEP 1: Get unimported contacts from database (iPhone synced contacts)
        // These take precedence because they have real DB IDs
        // TASK-1950: Skip if macOS/iPhone contacts source is disabled
        const unimportedDbContacts = (macosEnabled || iphoneEnabled)
          ? await databaseService.getUnimportedContactsByUserId(validatedUserId)
          : [];

        logService.info(
          `[Main] Found ${unimportedDbContacts.length} unimported contacts from database (iPhone sync)`,
          "Contacts",
        );

        for (const dbContact of unimportedDbContacts) {
          // Skip if already imported (by name, email, or phone)
          const dbNameLower = (dbContact.name || dbContact.display_name)?.toLowerCase();
          const dbEmailLower = dbContact.email?.toLowerCase();
          if (importedNames.has(dbNameLower)) {
            continue;
          }
          if (dbEmailLower && importedEmails.has(dbEmailLower)) {
            continue;
          }
          if (dbContact.phone) {
            const normalizedPhone = normalizePhoneNumber(dbContact.phone);
            if (normalizedPhone && normalizedPhone !== "+" && importedPhones.has(normalizedPhone)) {
              continue;
            }
          }

          // Skip if this is a duplicate (by email, phone, or name)
          if (isDuplicate(dbContact)) {
            continue;
          }

          // Mark this contact's identifiers as seen
          markAsSeen(dbContact);

          // Query actual emails/phones from contact_emails/contact_phones tables
          // (BACKLOG-1270: was hardcoded as [] which dropped all email data)
          const dbEmails = getContactEmailEntries(dbContact.id).map(e => e.email);
          const dbPhones = getContactPhoneEntries(dbContact.id).map(p => p.phone);

          availableContacts.push({
            id: dbContact.id, // Use actual DB ID so we can mark as imported
            name: dbContact.name || dbContact.display_name,
            phone: dbContact.phone || null,
            email: dbContact.email || null,
            company: dbContact.company || null,
            source: dbContact.source || "contacts_app",
            isFromDatabase: true, // Flag to distinguish from macOS Contacts app
            allPhones: dbPhones,
            allEmails: dbEmails,
          });
        }

        // STEP 2: TASK-1773 - Read from external_contacts shadow table
        // TASK-1950: Only sync macOS/iPhone contacts if source is enabled
        if (macosEnabled || iphoneEnabled) {
          // Check if shadow table is populated, if not trigger background sync
          const cachedCount = externalContactDb.getCount(validatedUserId);

          if (cachedCount === 0) {
            // Shadow table is empty - need initial population
            // Do blocking sync on first load only (non-blocking after)
            logService.info(
              "[Main] External contacts shadow table empty, doing initial sync",
              "Contacts",
            );

            try {
              // Read from macOS Contacts API
              const { phoneToContactInfo } = await getContactNames();

              if (phoneToContactInfo && Object.keys(phoneToContactInfo).length > 0) {
                // Convert to MacOSContact format
                const macOSContacts: externalContactDb.MacOSContact[] = [];
                for (const [_phone, contactInfo] of Object.entries(phoneToContactInfo)) {
                  macOSContacts.push({
                    name: contactInfo.name,
                    phones: contactInfo.phones,
                    emails: contactInfo.emails,
                    company: contactInfo.company,
                    recordId: contactInfo.recordId || `auto-${randomUUID().slice(0, 8)}`,
                  });
                }

                // Full sync: upsert + delete stale + update dates
                externalContactDb.fullSync(validatedUserId, macOSContacts);

                // Backfill any missing emails/phones for already-imported contacts
                const backfillResult = await backfillImportedContactsFromExternal(validatedUserId);
                if (backfillResult.updated > 0) {
                  logService.info(
                    `[Main] Backfilled ${backfillResult.updated} imported contacts with missing emails/phones`,
                    "Contacts",
                  );
                }
              }
            } catch (syncErr) {
              logService.warn(`[Main] Initial external contacts sync failed: ${syncErr}`, "Contacts");
            }
          } else if (externalContactDb.isStale(validatedUserId, 24)) {
            // Shadow table has data but is stale - trigger background sync
            // SR Engineer requirement: Non-blocking first load
            logService.info(
              "[Main] External contacts shadow table stale, triggering background sync",
              "Contacts",
            );

            setImmediate(async () => {
              try {
                const { phoneToContactInfo } = await getContactNames();

                if (phoneToContactInfo && Object.keys(phoneToContactInfo).length > 0) {
                  const macOSContacts: externalContactDb.MacOSContact[] = [];
                  for (const [_phone, contactInfo] of Object.entries(phoneToContactInfo)) {
                    macOSContacts.push({
                      name: contactInfo.name,
                      phones: contactInfo.phones,
                      emails: contactInfo.emails,
                      company: contactInfo.company,
                      recordId: contactInfo.recordId || `auto-${randomUUID().slice(0, 8)}`,
                    });
                  }

                  externalContactDb.fullSync(validatedUserId, macOSContacts);

                  // Backfill any missing emails/phones for already-imported contacts
                  const backfillResult = await backfillImportedContactsFromExternal(validatedUserId);
                  if (backfillResult.updated > 0) {
                    logService.info(
                      `[Main] Background sync: Backfilled ${backfillResult.updated} imported contacts`,
                      "Contacts",
                    );
                  }

                  // Notify renderer that sync is complete
                  if (_mainWindow && !_mainWindow.isDestroyed()) {
                    _mainWindow.webContents.send("contacts:external-sync-complete");
                  }
                }
              } catch (err) {
                logService.warn(`[Main] Background external contacts sync failed: ${err}`, "Contacts");
              }
            });
          }
        }

        // Read from shadow table (already sorted by last_message_at DESC, NULLS LAST)
        // TASK-1956: Use async worker thread to avoid blocking main process (~3.7s freeze with 1000+ contacts)
        const externalContacts = await externalContactDb.getAllForUserAsync(validatedUserId);

        logService.info(
          `[Main] Read ${externalContacts.length} contacts from shadow table`,
          "Contacts",
        );

        // STEP 3: Add external contacts (filtering out already imported)
        // TASK-1950: Also filter by source preference
        for (const extContact of externalContacts) {
          // Skip contacts from disabled sources
          if (extContact.source === "outlook" && !outlookEnabled) {
            continue;
          }
          if (extContact.source === "google_contacts" && !googleContactsEnabled) {
            continue;
          }
          if (extContact.source === "iphone" && !iphoneEnabled && !macosEnabled) {
            continue;
          }
          if (extContact.source === "macos" && !macosEnabled) {
            continue;
          }
          if (extContact.source !== "outlook" && extContact.source !== "google_contacts" && extContact.source !== "iphone" && extContact.source !== "macos" && !macosEnabled) {
            continue;
          }

          const nameLower = extContact.name?.toLowerCase();
          const primaryEmail = extContact.emails?.[0]?.toLowerCase();

          // Skip if already imported (by name or email)
          if (
            importedNames.has(nameLower) ||
            (primaryEmail && importedEmails.has(primaryEmail))
          ) {
            continue;
          }

          // Check if already imported by phone
          if (extContact.phones && extContact.phones.length > 0) {
            let phoneAlreadyImported = false;
            for (const phone of extContact.phones) {
              const normalized = normalizePhoneNumber(phone);
              if (
                normalized &&
                normalized !== "+" &&
                importedPhones.has(normalized)
              ) {
                phoneAlreadyImported = true;
                break;
              }
            }
            if (phoneAlreadyImported) continue;
          }

          // Create dedup-check object
          const extContactForDedup = {
            name: extContact.name,
            email: extContact.emails?.[0] || null,
            emails: extContact.emails,
            phone: extContact.phones?.[0] || null,
            phones: extContact.phones,
          };

          // Skip if already added from iPhone-synced contacts
          if (isDuplicate(extContactForDedup)) {
            continue;
          }

          // Mark as seen
          markAsSeen(extContactForDedup);

          availableContacts.push({
            id: extContact.id, // Use shadow table ID
            name: extContact.name,
            phone: extContact.phones?.[0] || null,
            email: extContact.emails?.[0] || null,
            company: extContact.company || null,
            source: extContact.source === "outlook" ? "outlook"
              : extContact.source === "google_contacts" ? "google_contacts"
              : "contacts_app",
            allPhones: extContact.phones || [],
            allEmails: extContact.emails || [],
            isFromDatabase: false,
            // last_message_at is already computed in shadow table
            last_communication_at: extContact.last_message_at,
          });
        }

        // Contacts are already sorted by last_message_at from shadow table
        // Just need to ensure the combined list respects the order
        // Sort the full list: most recent first, then by name
        availableContacts.sort((a, b) => {
          const dateA = a.last_communication_at ? new Date(a.last_communication_at).getTime() : 0;
          const dateB = b.last_communication_at ? new Date(b.last_communication_at).getTime() : 0;
          if (dateA !== dateB) {
            return dateB - dateA; // Most recent first
          }
          // Secondary sort by name
          const nameA = (a.name || '').toLowerCase();
          const nameB = (b.name || '').toLowerCase();
          return nameA.localeCompare(nameB);
        });

        logService.info(
          `[Main] Found ${availableContacts.length} total available contacts for import`,
          "Contacts",
        );

        return {
          success: true,
          contacts: availableContacts,
          contactsStatus: { loaded: true }, // Shadow table always available
        };
      } catch (error) {
        logService.error("[Main] Get available contacts failed:", "Contacts", {
          error,
        });
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: `Validation error: ${error.message}`,
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Import contacts from external sources
  ipcMain.handle(
    "contacts:import",
    async (
      event: IpcMainInvokeEvent,
      userId: string,
      contactsToImport: unknown[],
    ): Promise<ContactResponse> => {
      try {
        logService.info("[Main] Importing contacts", "Contacts", {
          userId,
          count: contactsToImport.length,
        });

        // BACKLOG-551: Validate user ID exists in local DB
        const validatedUserId = await getValidUserId(userId, "Contacts");
        if (!validatedUserId) {
          return {
            success: false,
            error: "No valid user found in database",
          };
        }

        // Validate contacts array
        if (!Array.isArray(contactsToImport)) {
          throw new ValidationError(
            "Contacts to import must be an array",
            "contactsToImport",
          );
        }

        if (contactsToImport.length === 0) {
          throw new ValidationError(
            "No contacts provided for import",
            "contactsToImport",
          );
        }

        if (contactsToImport.length > 5000) {
          throw new ValidationError(
            "Cannot import more than 5000 contacts at once",
            "contactsToImport",
          );
        }

        const importedContacts: Contact[] = [];
        const total = contactsToImport.length;

        // Separate contacts into two groups
        const existingDbContacts: ExistingDbContactRecord[] = [];
        const newContactsToCreate: NewContactData[] = [];

        for (const contact of contactsToImport) {
          const sanitizedContact = sanitizeObject(contact) as ImportableContact;
          const validatedData = validateContactData(sanitizedContact, false);

          if (
            sanitizedContact.isFromDatabase &&
            sanitizedContact.id &&
            !sanitizedContact.id.startsWith("contacts-app-")
          ) {
            logService.warn(`[DIAG-1270] Import path: ${sanitizedContact.name || validatedData.name} → existingDB, allEmails=[${(sanitizedContact.allEmails || []).join(', ')}]`, 'Contacts');
            existingDbContacts.push({ id: sanitizedContact.id, contact: sanitizedContact });
          } else {
            logService.warn(`[DIAG-1270] Import path: ${sanitizedContact.name || validatedData.name} → newCreate, allEmails=[${(sanitizedContact.allEmails || []).join(', ')}]`, 'Contacts');
            newContactsToCreate.push({
              user_id: validatedUserId,
              display_name: validatedData.name || "Unknown",
              email: validatedData.email ?? undefined,
              phone: validatedData.phone ?? undefined,
              company: validatedData.company ?? undefined,
              title: validatedData.title ?? undefined,
              source: sanitizedContact.source || "contacts_app",
              is_imported: true,
              allPhones: sanitizedContact.allPhones || [],
              allEmails: sanitizedContact.allEmails || [],
            });
          }
        }

        let processed = 0;

        // Mark existing DB contacts as imported and backfill any missing emails/phones
        // Also update source to "contacts_app" when importing from macOS Contacts
        for (const { id, contact } of existingDbContacts) {
          logService.warn(`[DIAG-1270] DB contact backfill: ${contact.name}, contact.allEmails=[${(contact.allEmails || []).join(', ')}], contact.allPhones=[${(contact.allPhones || []).join(', ')}]`, 'Contacts');
          await databaseService.markContactAsImported(id, contact.source || "contacts_app");

          // Backfill emails/phones from macOS Contacts if available
          if (contact.allEmails && contact.allEmails.length > 0) {
            await databaseService.backfillContactEmails(id, contact.allEmails);
          }
          if (contact.allPhones && contact.allPhones.length > 0) {
            await databaseService.backfillContactPhones(id, contact.allPhones);
          }

          const updatedContact = await databaseService.getContactById(id);
          if (updatedContact) {
            importedContacts.push(updatedContact);
          }
          processed++;
          if (_mainWindow && !_mainWindow.isDestroyed()) {
            _mainWindow.webContents.send("contacts:import-progress", {
              current: processed,
              total,
              percent: Math.round((processed / total) * 100),
            });
          }
        }

        // Batch create new contacts (much faster with transaction)
        if (newContactsToCreate.length > 0) {
          logService.info(
            `[Main] Batch importing ${newContactsToCreate.length} new contacts...`,
            "Contacts"
          );

          const createdIds = databaseService.createContactsBatch(
            newContactsToCreate,
            (current, _batchTotal) => {
              const overallCurrent = existingDbContacts.length + current;
              if (_mainWindow && !_mainWindow.isDestroyed()) {
                _mainWindow.webContents.send("contacts:import-progress", {
                  current: overallCurrent,
                  total,
                  percent: Math.round((overallCurrent / total) * 100),
                });
              }
            }
          );

          // Fetch created contacts
          for (const id of createdIds) {
            const contact = await databaseService.getContactById(id);
            if (contact) {
              importedContacts.push(contact);
            }
          }
        }

        logService.info(
          `[Main] Successfully imported ${importedContacts.length} contacts`,
          "Contacts",
        );

        return {
          success: true,
          contacts: importedContacts,
        };
      } catch (error) {
        logService.error("[Main] Import contacts failed:", "Contacts", {
          error,
        });
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: `Validation error: ${error.message}`,
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Get contacts sorted by recent activity and address relevance
  ipcMain.handle(
    "contacts:get-sorted-by-activity",
    async (
      event: IpcMainInvokeEvent,
      userId: string,
      propertyAddress: string | null = null,
    ): Promise<ContactResponse> => {
      try {
        logService.info(
          "[Main] Getting contacts sorted by activity",
          "Contacts",
          { userId, propertyAddress },
        );

        // BACKLOG-551: Validate user ID exists in local DB
        // BACKLOG-615: Return empty array gracefully during deferred DB init (onboarding)
        const validatedUserId = await getValidUserId(userId, "Contacts");
        if (!validatedUserId) {
          logService.info("[Contacts] No local user yet, returning empty sorted contacts (deferred DB init)", "Contacts");
          return {
            success: true,
            contacts: [],
          };
        }

        // Validate propertyAddress (optional)
        const validatedAddress = propertyAddress
          ? validateString(propertyAddress, "propertyAddress", {
              required: false,
              maxLength: 500,
            })
          : undefined;

        // Get only imported contacts sorted by activity
        const importedContacts =
          await databaseService.getContactsSortedByActivity(
            validatedUserId,
            validatedAddress ?? undefined,
          );

        logService.info(
          `[Main] Returning ${importedContacts.length} imported contacts sorted by activity`,
          "Contacts",
        );

        return {
          success: true,
          contacts: importedContacts,
        };
      } catch (error) {
        logService.error("[Main] Get sorted contacts failed:", "Contacts", {
          error,
        });
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: `Validation error: ${error.message}`,
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Create new contact
  ipcMain.handle(
    "contacts:create",
    async (
      event: IpcMainInvokeEvent,
      userId: string,
      contactData: unknown,
    ): Promise<ContactResponse> => {
      try {
        // DIAG-1270: Log raw input to contacts:create
        const rawInput = contactData as Record<string, unknown>;
        logService.warn(`[DIAG-1270] contacts:create raw input: allEmails=${JSON.stringify(rawInput?.allEmails)}, allPhones=${JSON.stringify(rawInput?.allPhones)}, name=${rawInput?.name}`, "Contacts");

        // BACKLOG-551: Validate user ID exists in local DB
        const validatedUserId = await getValidUserId(userId, "Contacts");
        if (!validatedUserId) {
          return {
            success: false,
            error: "No valid user found in database",
          };
        }
        const validatedData = validateContactData(contactData, false);

        // Check for duplicate contact by name (to prevent multiple imports of the same message contact)
        if (validatedData.name) {
          const existingByName = await databaseService.findContactByName(
            validatedUserId,
            validatedData.name
          );
          if (existingByName) {
            return {
              success: true,
              contact: existingByName,
            };
          }
        }

        // Extract source from input data (falls back to "manual" if not provided)
        const validSources: ContactSource[] = ["manual", "email", "sms", "messages", "contacts_app", "inferred", "google_contacts"];
        const inputSource = (contactData as { source?: string })?.source;
        const source: ContactSource = validSources.includes(inputSource as ContactSource)
          ? (inputSource as ContactSource)
          : "manual";
        const contact = await databaseService.createContact({
          user_id: validatedUserId,
          display_name: validatedData.name || "Unknown",
          email: validatedData.email ?? undefined,
          phone: validatedData.phone ?? undefined,
          company: validatedData.company ?? undefined,
          title: validatedData.title ?? undefined,
          source,
          is_imported: true,
        });

        // BACKLOG-1270: Store ALL emails/phones (not just the primary)
        const inputAllEmails = (contactData as { allEmails?: string[] })?.allEmails || [];
        const inputAllPhones = (contactData as { allPhones?: string[] })?.allPhones || [];
        if (inputAllEmails.length > 0) {
          await databaseService.backfillContactEmails(contact.id, inputAllEmails);
          logService.info(`[Contacts] Stored ${inputAllEmails.length} emails for new contact ${contact.id}`, "Contacts");
        }
        if (inputAllPhones.length > 0) {
          await databaseService.backfillContactPhones(contact.id, inputAllPhones);
          logService.info(`[Contacts] Stored ${inputAllPhones.length} phones for new contact ${contact.id}`, "Contacts");
        }

        // Audit log contact creation
        await auditService.log({
          userId: validatedUserId,
          action: "CONTACT_CREATE",
          resourceType: "CONTACT",
          resourceId: contact.id,
          metadata: { name: contact.name },
          success: true,
        });

        logService.info("Contact created", "Contacts", {
          userId: validatedUserId,
          contactId: contact.id,
        });

        return {
          success: true,
          contact,
        };
      } catch (error) {
        logService.error("Create contact failed", "Contacts", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: `Validation error: ${error.message}`,
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Get contact edit data (emails/phones with row IDs for multi-entry editing)
  ipcMain.handle(
    "contacts:get-edit-data",
    async (
      _event: IpcMainInvokeEvent,
      contactId: string,
    ): Promise<{
      success: boolean;
      emails?: { id: string; email: string; is_primary: boolean }[];
      phones?: { id: string; phone: string; is_primary: boolean }[];
      error?: string;
    }> => {
      try {
        const validatedContactId = validateContactId(contactId);
        if (!validatedContactId) {
          throw new ValidationError("Contact ID validation failed", "contactId");
        }

        const emails = getContactEmailEntries(validatedContactId);
        const phones = getContactPhoneEntries(validatedContactId);

        return { success: true, emails, phones };
      } catch (error) {
        logService.error("Get contact edit data failed", "Contacts", {
          contactId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Update contact
  ipcMain.handle(
    "contacts:update",
    async (
      event: IpcMainInvokeEvent,
      contactId: string,
      updates: unknown,
    ): Promise<ContactResponse> => {
      try {
        // Validate inputs
        const validatedContactId = validateContactId(contactId); // Validated, will throw if invalid
        if (!validatedContactId) {
          throw new ValidationError(
            "Contact ID validation failed",
            "contactId",
          );
        }
        const validatedUpdates = validateContactData(
          sanitizeObject(updates || {}),
          true,
        );

        // Get contact before update for audit logging
        const existingContact =
          await databaseService.getContactById(validatedContactId);
        const userId = existingContact?.user_id || "unknown";

        // Convert null to undefined for TypeScript strict mode
        const updatesData = {
          ...validatedUpdates,
          name: validatedUpdates.name ?? undefined,
          email: validatedUpdates.email ?? undefined,
          phone: validatedUpdates.phone ?? undefined,
          company: validatedUpdates.company ?? undefined,
          title: validatedUpdates.title ?? undefined,
        };

        await databaseService.updateContact(validatedContactId, updatesData);

        // TASK-1995: Multi-email/phone array update support
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawUpdates = sanitizeObject(updates || {}) as any;

        if (Array.isArray(rawUpdates.emails)) {
          syncContactEmails(validatedContactId, rawUpdates.emails);
          logService.info("Contact emails synced (multi)", "Contacts", {
            contactId: validatedContactId,
            count: rawUpdates.emails.length,
          });
        } else if (validatedUpdates.email !== undefined) {
          setContactPrimaryEmail(validatedContactId, validatedUpdates.email as string);
        }

        if (Array.isArray(rawUpdates.phones)) {
          syncContactPhones(validatedContactId, rawUpdates.phones);
          logService.info("Contact phones synced (multi)", "Contacts", {
            contactId: validatedContactId,
            count: rawUpdates.phones.length,
          });
        } else if (validatedUpdates.phone !== undefined) {
          setContactPrimaryPhone(validatedContactId, validatedUpdates.phone as string);
        }

        const contact =
          await databaseService.getContactById(validatedContactId);

        // Audit log contact update
        await auditService.log({
          userId,
          action: "CONTACT_UPDATE",
          resourceType: "CONTACT",
          resourceId: validatedContactId,
          metadata: { updatedFields: Object.keys(validatedUpdates) },
          success: true,
        });

        logService.info("Contact updated", "Contacts", {
          userId,
          contactId: validatedContactId,
        });

        return {
          success: true,
          contact: contact || undefined,
        };
      } catch (error) {
        logService.error("Update contact failed", "Contacts", {
          contactId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: `Validation error: ${error.message}`,
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Check if contact can be deleted (get associated transactions)
  ipcMain.handle(
    "contacts:checkCanDelete",
    async (
      event: IpcMainInvokeEvent,
      contactId: string,
    ): Promise<ContactResponse> => {
      try {
        logService.info(
          "[Main] Checking if contact can be deleted",
          "Contacts",
          { contactId },
        );

        // Validate input
        const validatedContactId = validateContactId(contactId); // Validated, will throw if invalid
        if (!validatedContactId) {
          throw new ValidationError(
            "Contact ID validation failed",
            "contactId",
          );
        }

        const transactions =
          await databaseService.getTransactionsByContact(validatedContactId);

        return {
          success: true,
          canDelete: transactions.length === 0,
          transactions: transactions,
          count: transactions.length,
        };
      } catch (error) {
        logService.error(
          "[Main] Check can delete contact failed:",
          "Contacts",
          { contactId, error },
        );
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: `Validation error: ${error.message}`,
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Delete contact
  ipcMain.handle(
    "contacts:delete",
    async (
      event: IpcMainInvokeEvent,
      contactId: string,
    ): Promise<ContactResponse> => {
      try {
        // Validate input
        const validatedContactId = validateContactId(contactId); // Validated, will throw if invalid
        if (!validatedContactId) {
          throw new ValidationError(
            "Contact ID validation failed",
            "contactId",
          );
        }

        // Get contact before delete for audit logging
        const existingContact =
          await databaseService.getContactById(validatedContactId);
        const userId = existingContact?.user_id || "unknown";
        const contactName = existingContact?.name || "unknown";

        // Check if contact has associated transactions
        const check =
          await databaseService.getTransactionsByContact(validatedContactId);
        if (check.length > 0) {
          return {
            success: false,
            error: "Cannot delete contact with associated transactions",
            canDelete: false,
            transactions: check,
            count: check.length,
          };
        }

        await databaseService.deleteContact(validatedContactId);

        // Audit log contact deletion
        await auditService.log({
          userId,
          action: "CONTACT_DELETE",
          resourceType: "CONTACT",
          resourceId: validatedContactId,
          metadata: { name: contactName },
          success: true,
        });

        logService.info("Contact deleted", "Contacts", {
          userId,
          contactId: validatedContactId,
        });

        return {
          success: true,
        };
      } catch (error) {
        logService.error("Delete contact failed", "Contacts", {
          contactId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: `Validation error: ${error.message}`,
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Remove contact from local database (un-import)
  ipcMain.handle(
    "contacts:remove",
    async (
      event: IpcMainInvokeEvent,
      contactId: string,
    ): Promise<ContactResponse> => {
      try {
        logService.info(
          "[Main] Removing contact from local database",
          "Contacts",
          { contactId },
        );

        // Validate input
        const validatedContactId = validateContactId(contactId); // Validated, will throw if invalid
        if (!validatedContactId) {
          throw new ValidationError(
            "Contact ID validation failed",
            "contactId",
          );
        }

        // Check if contact has associated transactions
        const check =
          await databaseService.getTransactionsByContact(validatedContactId);
        if (check.length > 0) {
          return {
            success: false,
            error: "Cannot remove contact with associated transactions",
            canDelete: false,
            transactions: check,
            count: check.length,
          };
        }

        await databaseService.removeContact(validatedContactId);

        return {
          success: true,
        };
      } catch (error) {
        logService.error("[Main] Remove contact failed:", "Contacts", {
          contactId,
          error,
        });
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: `Validation error: ${error.message}`,
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Search contacts (database-level search for contact selection)
  // This fixes the LIMIT 200 issue where contacts beyond position 200 were unsearchable
  ipcMain.handle(
    "contacts:search",
    async (
      _event: IpcMainInvokeEvent,
      userId: string,
      query: string,
    ): Promise<ContactResponse> => {
      try {
        // BACKLOG-551: Validate user ID exists in local DB
        // BACKLOG-615: Return empty array gracefully during deferred DB init (onboarding)
        const validatedUserId = await getValidUserId(userId, "Contacts");
        if (!validatedUserId) {
          logService.info("[Contacts] No local user yet, returning empty search results (deferred DB init)", "Contacts");
          return {
            success: true,
            contacts: [],
          };
        }

        // For empty/short queries, return the default sorted list
        if (!query || query.length < 2) {
          logService.info(
            "[Main] Short query, returning sorted contacts",
            "Contacts",
            { userId, queryLength: query?.length || 0 },
          );
          const contacts = await databaseService.getContactsSortedByActivity(validatedUserId);
          return {
            success: true,
            contacts,
          };
        }

        // Validate and sanitize query
        const validatedQuery = validateString(query, "query", {
          required: true,
          maxLength: 200,
        });

        if (!validatedQuery) {
          throw new ValidationError("Query validation failed", "query");
        }

        logService.info(
          "[Main] Searching contacts in database",
          "Contacts",
          { userId, query: validatedQuery },
        );

        // Perform database-level search
        const contacts = databaseService.searchContactsForSelection(
          validatedUserId,
          validatedQuery,
        );

        logService.info(
          `[Main] Found ${contacts.length} contacts matching query`,
          "Contacts",
          { userId, resultCount: contacts.length },
        );

        return {
          success: true,
          contacts,
        };
      } catch (error) {
        logService.error("[Main] Search contacts failed:", "Contacts", {
          userId,
          query,
          error,
        });
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: `Validation error: ${error.message}`,
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Look up contact names by phone numbers (batch)
  ipcMain.handle(
    "contacts:get-names-by-phones",
    async (
      _event: IpcMainInvokeEvent,
      phones: string[],
    ): Promise<{ success: boolean; names: Record<string, string>; error?: string }> => {
      try {
        if (!Array.isArray(phones)) {
          return { success: false, names: {}, error: "phones must be an array" };
        }

        const namesMap = await databaseService.getContactNamesByPhones(phones);

        // Convert Map to plain object for IPC
        const names: Record<string, string> = {};
        namesMap.forEach((name, phone) => {
          names[phone] = name;
        });

        return { success: true, names };
      } catch (error) {
        logService.error("Get contact names by phones failed", "Contacts", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
        return {
          success: false,
          names: {},
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // TASK-2026: Resolve any mix of phone numbers, emails, and Apple IDs to contact names
  ipcMain.handle(
    "contacts:resolve-handles",
    async (
      _event: IpcMainInvokeEvent,
      handles: string[],
      userId?: string,
    ): Promise<{ success: boolean; names: Record<string, string>; error?: string }> => {
      try {
        if (!Array.isArray(handles)) {
          return { success: false, names: {}, error: "handles must be an array" };
        }

        // Pass userId to enable external_contacts lookup (iPhone, macOS, Outlook, Google)
        const validatedUserId = userId ? await getValidUserId(userId, "Contacts") : undefined;
        const names = await resolveHandles(handles, validatedUserId ?? undefined);
        return { success: true, names };
      } catch (error) {
        logService.error("Resolve handles failed", "Contacts", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
        return {
          success: false,
          names: {},
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // TASK-1773: Trigger manual sync of external contacts from macOS
  ipcMain.handle(
    "contacts:syncExternal",
    async (
      _event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<{
      success: boolean;
      inserted?: number;
      deleted?: number;
      total?: number;
      error?: string;
    }> => {
      try {
        logService.info("[Main] Manual external contacts sync requested", "Contacts", { userId });

        // Validate user ID
        const validatedUserId = await getValidUserId(userId, "Contacts");
        if (!validatedUserId) {
          return { success: false, error: "No valid user found in database" };
        }

        // TASK-1950: Check if macOS contacts source is enabled
        const macosEnabled = await isContactSourceEnabled(validatedUserId, "direct", "macosContacts", true);
        if (!macosEnabled) {
          logService.info("[Main] macOS contacts sync skipped (disabled in preferences)", "Contacts", { userId: validatedUserId });
          return { success: true, inserted: 0, deleted: 0, total: 0 };
        }

        // Read from macOS Contacts API
        const { phoneToContactInfo } = await getContactNames();

        if (!phoneToContactInfo || Object.keys(phoneToContactInfo).length === 0) {
          return { success: false, error: "No contacts found in macOS Contacts" };
        }

        // Convert to MacOSContact format
        const macOSContacts: externalContactDb.MacOSContact[] = [];
        for (const [_phone, contactInfo] of Object.entries(phoneToContactInfo)) {
          macOSContacts.push({
            name: contactInfo.name,
            phones: contactInfo.phones,
            emails: contactInfo.emails,
            company: contactInfo.company,
            recordId: contactInfo.recordId || `auto-${randomUUID().slice(0, 8)}`,
          });
        }

        // Full sync: upsert + delete stale + update dates
        const result = externalContactDb.fullSync(validatedUserId, macOSContacts);

        // Backfill any imported contacts with new emails/phones from external_contacts
        const backfillResult = await backfillImportedContactsFromExternal(validatedUserId);

        logService.info("[Main] External contacts manual sync complete", "Contacts", {
          inserted: result.inserted,
          deleted: result.deleted,
          total: result.total,
          backfilled: backfillResult.updated,
        });

        return {
          success: true,
          inserted: result.inserted,
          deleted: result.deleted,
          total: result.total,
        };
      } catch (error) {
        logService.error("[Main] External contacts sync failed", "Contacts", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // TASK-1773: Get external contacts sync status
  ipcMain.handle(
    "contacts:getExternalSyncStatus",
    async (
      _event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<{
      success: boolean;
      lastSyncAt?: string | null;
      isStale?: boolean;
      contactCount?: number;
      error?: string;
    }> => {
      try {
        // Validate user ID
        const validatedUserId = await getValidUserId(userId, "Contacts");
        if (!validatedUserId) {
          return { success: false, error: "No valid user found in database" };
        }

        const lastSyncAt = externalContactDb.getLastSyncTime(validatedUserId);
        const isStale = externalContactDb.isStale(validatedUserId, 24);
        const contactCount = externalContactDb.getCount(validatedUserId);

        return {
          success: true,
          lastSyncAt,
          isStale,
          contactCount,
        };
      } catch (error) {
        logService.error("[Main] Get external sync status failed", "Contacts", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // TASK-1991: Get contact source stats (per-source counts)
  ipcMain.handle(
    "contacts:getSourceStats",
    async (
      _event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<{
      success: boolean;
      stats?: Record<string, number>;
      error?: string;
    }> => {
      try {
        const validatedUserId = await getValidUserId(userId, "Contacts");
        if (!validatedUserId) {
          return { success: false, error: "No valid user found in database" };
        }

        const stats = externalContactDb.getContactSourceStats(validatedUserId);
        return { success: true, stats };
      } catch (error) {
        logService.error("[Main] Get contact source stats failed", "Contacts", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Force re-import: wipe ALL external contacts (all sources), then re-import from enabled sources
  ipcMain.handle(
    "contacts:forceReimport",
    async (
      _event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<{
      success: boolean;
      cleared: number;
      error?: string;
    }> => {
      try {
        logService.info("[Main] Force re-import requested — wiping all sources", "Contacts", { userId });

        const validatedUserId = await getValidUserId(userId, "Contacts");
        if (!validatedUserId) {
          return { success: false, cleared: 0, error: "No valid user found in database" };
        }

        // Wipe ALL external contacts regardless of which sources are enabled
        const countBefore = externalContactDb.getCount(validatedUserId);
        externalContactDb.clearAllForUser(validatedUserId);
        const totalCleared = countBefore;

        logService.info("[Main] Force re-import wipe complete", "Contacts", {
          userId: validatedUserId,
          cleared: totalCleared,
        });

        return { success: true, cleared: totalCleared };
      } catch (error) {
        logService.error("[Main] Force re-import wipe failed", "Contacts", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
        return {
          success: false,
          cleared: 0,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // TASK-1921: Sync Outlook contacts to external_contacts table
  // TASK-2300: Delegates to contactSyncService for provider-agnostic sync
  ipcMain.handle(
    "contacts:syncOutlookContacts",
    async (
      _event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<{
      success: boolean;
      count?: number;
      reconnectRequired?: boolean;
      error?: string;
    }> => {
      try {
        logService.info("[Main] Outlook contacts sync requested", "Contacts", { userId });

        // Validate user ID
        const validatedUserId = await getValidUserId(userId, "Contacts");
        if (!validatedUserId) {
          return { success: false, error: "No valid user found in database" };
        }

        // TASK-2300: Delegate to contactSyncService
        const result = await contactSyncService.syncProvider(validatedUserId, 'outlook');

        if (!result.success) {
          return {
            success: false,
            error: result.error || "Failed to sync Outlook contacts",
            reconnectRequired: result.reconnectRequired,
          };
        }

        logService.info("[Main] Outlook contacts sync complete", "Contacts", {
          userId: validatedUserId,
          count: result.count,
        });

        return {
          success: true,
          count: result.count,
        };
      } catch (error) {
        logService.error("[Main] Outlook contacts sync failed", "Contacts", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
        // TASK-2058: Log failure for offline diagnostics
        failureLogService.logFailure(
          "outlook_contacts_sync",
          error instanceof Error ? error.message : "Unknown error"
        );
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // TASK-2303: Sync Google contacts to external_contacts table
  // Mirrors syncOutlookContacts pattern, delegates to contactSyncService
  ipcMain.handle(
    "contacts:syncGoogleContacts",
    async (
      _event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<{
      success: boolean;
      count?: number;
      reconnectRequired?: boolean;
      error?: string;
    }> => {
      try {
        logService.info("[Main] Google contacts sync requested", "Contacts", { userId });

        // Validate user ID
        const validatedUserId = await getValidUserId(userId, "Contacts");
        if (!validatedUserId) {
          return { success: false, error: "No valid user found in database" };
        }

        // Delegate to contactSyncService (GoogleContactProvider registered in TASK-2301)
        const result = await contactSyncService.syncProvider(validatedUserId, 'google_contacts');

        if (!result.success) {
          return {
            success: false,
            error: result.error || "Failed to sync Google contacts",
            reconnectRequired: result.reconnectRequired,
          };
        }

        logService.info("[Main] Google contacts sync complete", "Contacts", {
          userId: validatedUserId,
          count: result.count,
        });

        return {
          success: true,
          count: result.count,
        };
      } catch (error) {
        logService.error("[Main] Google contacts sync failed", "Contacts", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
        // Log failure for offline diagnostics
        failureLogService.logFailure(
          "google_contacts_sync",
          error instanceof Error ? error.message : "Unknown error"
        );
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Update contact default_role (manual override)
  ipcMain.handle(
    "contacts:update-default-role",
    async (
      event: IpcMainInvokeEvent,
      contactId: string,
      role: string,
    ): Promise<ContactResponse> => {
      try {
        const validatedContactId = validateContactId(contactId);
        if (!validatedContactId) {
          throw new ValidationError(
            "Contact ID validation failed",
            "contactId",
          );
        }
        const validatedRole = validateString(role, "role");
        if (!validatedRole) {
          throw new ValidationError("Role validation failed", "role");
        }

        dbRun(
          `UPDATE contacts SET default_role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [validatedRole, validatedContactId]
        );

        logService.info("Contact default_role updated", "Contacts", {
          contactId: validatedContactId,
          role: validatedRole,
        });

        return { success: true };
      } catch (error) {
        logService.error("Update contact default_role failed", "Contacts", {
          contactId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: `Validation error: ${error.message}`,
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

}
