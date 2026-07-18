/**
 * Transaction Database Service
 * Handles all transaction-related database operations
 */

import crypto from "crypto";
import type {
  Transaction,
  NewTransaction,
  TransactionFilters,
  TransactionWithContacts,
  TransactionStatus,
} from "../../types";
import { DatabaseError } from "../../types";
import { dbGet, dbAll, dbRun } from "./core/dbConnection";
import logService from "../logService";
import { getTransactionContactsWithRoles } from "./transactionContactDbService";
import { validateFields } from "../../utils/sqlFieldWhitelist";
import {
  isTransactionFrozen,
  frozenFieldsInUpdate,
  TransactionFrozenError,
} from "../transactionFreezePolicy";

/**
 * BACKLOG-2013: sentinel key callers may set on the `updates` object to bypass
 * the export-freeze guard for a single write (admin unfreeze + the export
 * handler stamping first_exported_at itself). It is stripped before SQL
 * construction and is NEVER a real column. Using a well-known key (rather than
 * a Symbol) keeps it serialisable across the IPC boundary if ever needed.
 */
export const UNFREEZE_OVERRIDE_KEY = "__unfreezeOverride";

/**
 * Valid transaction status values.
 * These are the only values allowed in the database.
 */
export const VALID_TRANSACTION_STATUSES: readonly TransactionStatus[] = [
  "pending",
  "active",
  "closed",
  "rejected",
] as const;

/**
 * Validate and return a transaction status value.
 *
 * @param status - The status value to validate (can be null/undefined for default)
 * @returns A valid TransactionStatus value
 * @throws DatabaseError if the status is invalid (not null/undefined and not a valid value)
 *
 * @example
 * validateTransactionStatus('active') // returns 'active'
 * validateTransactionStatus('pending') // returns 'pending'
 * validateTransactionStatus(undefined) // returns 'active' (default)
 * validateTransactionStatus('invalid') // throws DatabaseError
 */
export function validateTransactionStatus(
  status: unknown
): TransactionStatus {
  // Handle null/undefined - default to 'active'
  if (status === null || status === undefined || status === "") {
    return "active";
  }

  // Validate the status is one of the allowed values
  if (
    typeof status === "string" &&
    VALID_TRANSACTION_STATUSES.includes(status as TransactionStatus)
  ) {
    return status as TransactionStatus;
  }

  // Reject invalid values with a clear error message
  throw new DatabaseError(
    `Invalid transaction status: "${status}". Valid values are: ${VALID_TRANSACTION_STATUSES.join(", ")}`
  );
}

/**
 * Create a new transaction
 */
export async function createTransaction(
  transactionData: NewTransaction,
): Promise<Transaction> {
  const id = crypto.randomUUID();

  const sql = `
    INSERT INTO transactions (
      id, user_id, property_address, property_street, property_city,
      property_state, property_zip, property_coordinates,
      transaction_type, status, closing_deadline, started_at, closed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  // Validate status - reject invalid values, use 'active' as default for null/undefined
  // Note: Legacy transaction_status field is no longer supported in write paths
  const validatedStatus = validateTransactionStatus(transactionData.status);

  const params = [
    id,
    transactionData.user_id,
    transactionData.property_address,
    transactionData.property_street || null,
    transactionData.property_city || null,
    transactionData.property_state || null,
    transactionData.property_zip || null,
    transactionData.property_coordinates
      ? JSON.stringify(transactionData.property_coordinates)
      : null,
    transactionData.transaction_type || null,
    validatedStatus,
    transactionData.closing_deadline || null,
    transactionData.started_at || null,
    transactionData.closed_at || null,
  ];

  dbRun(sql, params);
  const transaction = await getTransactionById(id);
  if (!transaction) {
    throw new DatabaseError("Failed to create transaction");
  }
  return transaction;
}

/**
 * Get count of pending auto-detected transactions for a user.
 * BACKLOG-1124: Uses a SQL COUNT query instead of fetching all transactions
 * and filtering client-side, avoiding large IPC serialization overhead.
 */
export function getPendingTransactionCount(userId: string): number {
  const result = dbGet<{ count: number }>(
    "SELECT COUNT(*) as count FROM transactions WHERE user_id = ? AND detection_status = 'pending'",
    [userId],
  );
  return result?.count ?? 0;
}

/**
 * Get all transactions for a user
 */
export async function getTransactions(
  filters?: TransactionFilters,
): Promise<Transaction[]> {
  // BACKLOG-390: Count emails using subquery for accurate count
  // BACKLOG-396: Use stored text_thread_count for texts (updated on link/unlink)
  // TASK-1403: Updated email_count to use email_id IS NOT NULL (new three-table architecture)
  // This ensures consistency between card view and details page
  let sql = `SELECT t.*,
             (SELECT COUNT(*) FROM communications c WHERE c.transaction_id = t.id) as total_communications_count,
             (SELECT COUNT(DISTINCT c.email_id)
              FROM communications c
              WHERE c.transaction_id = t.id
              AND c.email_id IS NOT NULL) as email_count
             FROM transactions t WHERE 1=1`;
  const params: unknown[] = [];

  if (filters?.user_id) {
    sql += " AND t.user_id = ?";
    params.push(filters.user_id);
  }

  if (filters?.transaction_type) {
    sql += " AND t.transaction_type = ?";
    params.push(filters.transaction_type);
  }

  if (filters?.status) {
    sql += " AND t.status = ?";
    params.push(filters.status);
  }

  if (filters?.export_status) {
    sql += " AND t.export_status = ?";
    params.push(filters.export_status);
  }

  if (filters?.start_date) {
    sql += " AND t.closing_deadline >= ?";
    params.push(filters.start_date);
  }

  if (filters?.end_date) {
    sql += " AND t.closing_deadline <= ?";
    params.push(filters.end_date);
  }

  if (filters?.property_address) {
    sql += " AND t.property_address LIKE ?";
    params.push(`%${filters.property_address}%`);
  }

  sql += " ORDER BY t.created_at DESC";

  return dbAll<Transaction>(sql, params);
}

/**
 * Get transaction by ID
 */
export async function getTransactionById(
  transactionId: string,
): Promise<Transaction | null> {
  // BACKLOG-446: Include email_count using same subquery as getTransactions
  // TASK-1403: Updated email_count to use email_id IS NOT NULL (new three-table architecture)
  // This ensures consistent email counts between list view and detail view
  const sql = `SELECT t.*,
               (SELECT COUNT(DISTINCT c.email_id)
                FROM communications c
                WHERE c.transaction_id = t.id
                AND c.email_id IS NOT NULL) as email_count
               FROM transactions t WHERE t.id = ?`;
  const transaction = dbGet<Transaction>(sql, [transactionId]);
  return transaction || null;
}

/**
 * Get transaction with associated contacts
 */
export async function getTransactionWithContacts(
  transactionId: string,
): Promise<TransactionWithContacts | null> {
  const transaction = await getTransactionById(transactionId);
  if (!transaction) {
    return null;
  }

  const contacts = await getTransactionContactsWithRoles(transactionId);

  const result: TransactionWithContacts = {
    ...transaction,
    all_contacts: contacts.map((tc) => ({
      id: tc.contact_id,
      user_id: transaction.user_id,
      name: tc.contact_name || "",
      email: tc.contact_email,
      phone: tc.contact_phone,
      company: tc.contact_company,
      title: tc.contact_title,
      source: "manual" as const,
      is_imported: true,
      created_at: tc.created_at,
      updated_at: tc.updated_at,
    })),
  };

  // Find specific role contacts
  const buyerAgent = contacts.find((c) => c.specific_role === "Buyer Agent");
  const sellerAgent = contacts.find((c) => c.specific_role === "Seller Agent");
  const escrowOfficer = contacts.find(
    (c) => c.specific_role === "Escrow Officer",
  );
  const inspector = contacts.find((c) => c.specific_role === "Inspector");

  if (buyerAgent) {
    result.buyer_agent = {
      id: buyerAgent.contact_id,
      user_id: transaction.user_id,
      name: buyerAgent.contact_name || "",
      email: buyerAgent.contact_email,
      phone: buyerAgent.contact_phone,
      company: buyerAgent.contact_company,
      title: buyerAgent.contact_title,
      source: "manual" as const,
      is_imported: true,
      created_at: buyerAgent.created_at,
      updated_at: buyerAgent.updated_at,
    };
  }

  if (sellerAgent) {
    result.seller_agent = {
      id: sellerAgent.contact_id,
      user_id: transaction.user_id,
      name: sellerAgent.contact_name || "",
      email: sellerAgent.contact_email,
      phone: sellerAgent.contact_phone,
      company: sellerAgent.contact_company,
      title: sellerAgent.contact_title,
      source: "manual" as const,
      is_imported: true,
      created_at: sellerAgent.created_at,
      updated_at: sellerAgent.updated_at,
    };
  }

  if (escrowOfficer) {
    result.escrow_officer = {
      id: escrowOfficer.contact_id,
      user_id: transaction.user_id,
      name: escrowOfficer.contact_name || "",
      email: escrowOfficer.contact_email,
      phone: escrowOfficer.contact_phone,
      company: escrowOfficer.contact_company,
      title: escrowOfficer.contact_title,
      source: "manual" as const,
      is_imported: true,
      created_at: escrowOfficer.created_at,
      updated_at: escrowOfficer.updated_at,
    };
  }

  if (inspector) {
    result.inspector = {
      id: inspector.contact_id,
      user_id: transaction.user_id,
      name: inspector.contact_name || "",
      email: inspector.contact_email,
      phone: inspector.contact_phone,
      company: inspector.contact_company,
      title: inspector.contact_title,
      source: "manual" as const,
      is_imported: true,
      created_at: inspector.created_at,
      updated_at: inspector.updated_at,
    };
  }

  return result;
}

/**
 * Update transaction
 */
export async function updateTransaction(
  transactionId: string,
  updates: Partial<Transaction>,
): Promise<void> {
  const allowedFields = [
    "property_address",
    "property_street",
    "property_city",
    "property_state",
    "property_zip",
    "property_coordinates",
    "transaction_type",
    "status",
    "started_at",
    "closed_at",
    "closing_deadline",
    "closing_date_verified",
    "representation_start_confidence",
    "closing_date_confidence",
    "buyer_agent_id",
    "seller_agent_id",
    "escrow_officer_id",
    "inspector_id",
    "other_contacts",
    "export_generated_at",
    "export_status",
    "export_format",
    "export_count",
    "last_exported_on",
    "last_exported_at",
    // BACKLOG-2013: freeze marker. Written by the export handler (first export)
    // and cleared by admin unfreeze — always via the override path below.
    "first_exported_at",
    "communications_scanned",
    "extraction_confidence",
    "first_communication_date",
    "last_communication_date",
    "total_communications_count",
    "mutual_acceptance_date",
    "earnest_money_amount",
    "earnest_money_delivered_date",
    "listing_price",
    "sale_price",
    "other_parties",
    "offer_count",
    "failed_offers_count",
    "key_dates",
    "message_count",
    "attachment_count",
    // B2B Submission Tracking (BACKLOG-390)
    "submission_status",
    "submission_id",
    "submitted_at",
    "last_review_notes",
    // BACKLOG-1364: Address filter toggle
    "skip_address_filter",
  ];

  // Validate status if it's being updated
  if (updates.status !== undefined) {
    validateTransactionStatus(updates.status);
  }

  // BACKLOG-2013 — EXPORT FREEZE ENFORCEMENT (db layer = the guarantee).
  //
  // Pull the override sentinel out of `updates` first so it never reaches the
  // column loop. Callers set it only on the trusted paths that legitimately
  // mutate the freeze state itself (export handler stamping first_exported_at;
  // admin unfreeze clearing it).
  const updatesRecord = updates as Record<string, unknown>;
  const hasUnfreezeOverride = updatesRecord[UNFREEZE_OVERRIDE_KEY] === true;
  if (UNFREEZE_OVERRIDE_KEY in updatesRecord) {
    delete updatesRecord[UNFREEZE_OVERRIDE_KEY];
  }

  // If the caller is touching any identity field, check the freeze marker. We
  // only pay for the extra read when an identity field is actually in play, so
  // the common case (bookkeeping updates: status, counts, export tracking) is
  // unaffected.
  const attemptedFrozen = frozenFieldsInUpdate(Object.keys(updatesRecord));
  if (attemptedFrozen.length > 0 && !hasUnfreezeOverride) {
    const current = dbGet<{ first_exported_at: string | null }>(
      "SELECT first_exported_at FROM transactions WHERE id = ?",
      [transactionId],
    );
    if (isTransactionFrozen(current ?? undefined)) {
      throw new TransactionFrozenError(
        transactionId,
        `Transaction is frozen after export — the following identity field(s) cannot be edited: ${attemptedFrozen.join(", ")}. An admin unfreeze is required to correct a genuine typo.`,
        attemptedFrozen,
      );
    }
  }

  const fields: string[] = [];
  const values: unknown[] = [];

  Object.keys(updates).forEach((key) => {
    if (allowedFields.includes(key)) {
      let value = (updates as Record<string, unknown>)[key];
      if (
        ["property_coordinates", "other_parties", "key_dates", "other_contacts"].includes(
          key,
        ) &&
        typeof value === "object"
      ) {
        value = JSON.stringify(value);
      }
      fields.push(`${key} = ?`);
      values.push(value);
    }
  });

  if (fields.length === 0) {
    throw new DatabaseError("No valid fields to update");
  }

  // Validate fields against whitelist before SQL construction
  validateFields("transactions", fields);

  values.push(transactionId);

  const sql = `UPDATE transactions SET ${fields.join(", ")} WHERE id = ?`;
  const result = dbRun(sql, values);

  logService.debug("Transaction update result", "TransactionDbService", {
    transactionId,
    fields,
    rowsChanged: result.changes,
  });

  if (result.changes === 0) {
    logService.warn("Transaction update changed 0 rows", "TransactionDbService", {
      transactionId,
      fields,
    });
  }
}

/**
 * Delete transaction
 */
export async function deleteTransaction(transactionId: string): Promise<void> {
  const sql = "DELETE FROM transactions WHERE id = ?";
  dbRun(sql, [transactionId]);
}

/**
 * Find existing transactions by property addresses for a user.
 * Used for deduplication during import to efficiently check if transactions
 * already exist before creating new ones.
 *
 * @param userId - The user ID to scope the search
 * @param propertyAddresses - Array of property addresses to look up
 * @returns Map of normalized property address to existing transaction ID
 */
export async function findExistingTransactionsByAddresses(
  userId: string,
  propertyAddresses: string[],
): Promise<Map<string, string>> {
  if (propertyAddresses.length === 0) {
    return new Map();
  }

  // Normalize addresses for comparison (lowercase, trim whitespace)
  const normalizedAddresses = propertyAddresses.map((addr) =>
    addr.toLowerCase().trim()
  );

  // Build SQL with placeholders for all addresses
  const placeholders = normalizedAddresses.map(() => "LOWER(TRIM(property_address)) = ?").join(" OR ");
  const sql = `
    SELECT id, property_address
    FROM transactions
    WHERE user_id = ? AND (${placeholders})
  `;

  const params = [userId, ...normalizedAddresses];
  const results = dbAll<{ id: string; property_address: string }>(sql, params);

  // Build map of normalized address -> transaction ID
  const addressMap = new Map<string, string>();
  for (const row of results) {
    const normalizedAddr = row.property_address.toLowerCase().trim();
    addressMap.set(normalizedAddr, row.id);
  }

  return addressMap;
}
