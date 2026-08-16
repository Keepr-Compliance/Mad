/**
 * Input Validation Utilities for IPC Handlers
 * Provides comprehensive validation for all IPC handler inputs
 * Prevents injection attacks, type errors, and invalid data processing
 */

/**
 * Validation error class
 */
export class ValidationError extends Error {
  field?: string;

  constructor(message: string, field?: string) {
    super(message);
    this.name = "ValidationError";
    this.field = field;
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

/**
 * Validate user ID
 * @param userId - User ID to validate (UUID string)
 * @param required - Whether the field is required
 * @returns Validated user ID
 * @throws ValidationError if validation fails
 */
export function validateUserId(
  userId: unknown,
  required: boolean = true,
): string | null {
  if (userId === null || userId === undefined || userId === "") {
    if (required) {
      throw new ValidationError("User ID is required", "userId");
    }
    return null;
  }

  if (typeof userId !== "string") {
    throw new ValidationError("User ID must be a string", "userId");
  }

  // Validate UUID format (standard UUID v4 format)
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(userId.trim())) {
    throw new ValidationError("User ID must be a valid UUID", "userId");
  }

  return userId.trim();
}

/**
 * Validate contact ID
 * @param contactId - Contact ID to validate (UUID string)
 * @param required - Whether the field is required
 * @returns Validated contact ID
 * @throws ValidationError if validation fails
 */
export function validateContactId(
  contactId: unknown,
  required: boolean = true,
): string | null {
  if (contactId === null || contactId === undefined || contactId === "") {
    if (required) {
      throw new ValidationError("Contact ID is required", "contactId");
    }
    return null;
  }

  if (typeof contactId !== "string") {
    throw new ValidationError("Contact ID must be a string", "contactId");
  }

  // Validate UUID format (standard UUID v4 format)
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(contactId.trim())) {
    throw new ValidationError("Contact ID must be a valid UUID", "contactId");
  }

  return contactId.trim();
}

/**
 * Validate transaction ID
 * @param transactionId - Transaction ID to validate (UUID string)
 * @param required - Whether the field is required
 * @returns Validated transaction ID
 * @throws ValidationError if validation fails
 */
export function validateTransactionId(
  transactionId: unknown,
  required: boolean = true,
): string | null {
  if (
    transactionId === null ||
    transactionId === undefined ||
    transactionId === ""
  ) {
    if (required) {
      throw new ValidationError("Transaction ID is required", "transactionId");
    }
    return null;
  }

  if (typeof transactionId !== "string") {
    throw new ValidationError(
      "Transaction ID must be a string",
      "transactionId",
    );
  }

  // Validate UUID format (standard UUID v4 format)
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(transactionId.trim())) {
    throw new ValidationError(
      "Transaction ID must be a valid UUID",
      "transactionId",
    );
  }

  return transactionId.trim();
}

/**
 * Validate email address
 * @param email - Email to validate
 * @param required - Whether the field is required
 * @returns Validated email
 * @throws ValidationError if validation fails
 */
export function validateEmail(
  email: unknown,
  required: boolean = true,
): string | null {
  if (!email) {
    if (required) {
      throw new ValidationError("Email is required", "email");
    }
    return null;
  }

  if (typeof email !== "string") {
    throw new ValidationError("Email must be a string", "email");
  }

  // Basic email validation regex
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    throw new ValidationError("Invalid email format", "email");
  }

  // Prevent extremely long emails (potential DoS)
  if (email.length > 254) {
    throw new ValidationError("Email is too long", "email");
  }

  return email.toLowerCase().trim();
}

/**
 * Validation options for string validation
 */
export interface StringValidationOptions {
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp | null;
}

/**
 * Validate string input
 * @param value - Value to validate
 * @param fieldName - Field name for error messages
 * @param options - Validation options
 * @returns Validated string
 * @throws ValidationError if validation fails
 */
export function validateString(
  value: unknown,
  fieldName: string,
  options: StringValidationOptions = {},
): string | null {
  const {
    required = false,
    minLength = 0,
    maxLength = Infinity,
    pattern = null,
  } = options;

  if (!value) {
    if (required) {
      throw new ValidationError(`${fieldName} is required`, fieldName);
    }
    return null;
  }

  if (typeof value !== "string") {
    throw new ValidationError(`${fieldName} must be a string`, fieldName);
  }

  const trimmed = value.trim();

  if (trimmed.length < minLength) {
    throw new ValidationError(
      `${fieldName} must be at least ${minLength} characters`,
      fieldName,
    );
  }

  if (trimmed.length > maxLength) {
    throw new ValidationError(
      `${fieldName} must be at most ${maxLength} characters`,
      fieldName,
    );
  }

  if (pattern && !pattern.test(trimmed)) {
    throw new ValidationError(`${fieldName} has invalid format`, fieldName);
  }

  return trimmed;
}

/**
 * Validate OAuth authorization code
 * @param authCode - Authorization code to validate
 * @returns Validated auth code
 * @throws ValidationError if validation fails
 */
export function validateAuthCode(authCode: unknown): string {
  if (!authCode || typeof authCode !== "string") {
    throw new ValidationError(
      "Authorization code is required and must be a string",
      "authCode",
    );
  }

  const trimmed = authCode.trim();

  if (trimmed.length < 10) {
    throw new ValidationError("Authorization code is too short", "authCode");
  }

  if (trimmed.length > 1000) {
    throw new ValidationError("Authorization code is too long", "authCode");
  }

  // Auth codes should be alphanumeric with some special chars
  if (!/^[\w\-._~]+$/.test(trimmed)) {
    throw new ValidationError(
      "Authorization code contains invalid characters",
      "authCode",
    );
  }

  return trimmed;
}

/** Minimum expected session token length */
export const SESSION_TOKEN_MIN_LENGTH = 20;

/** Maximum expected session token length */
export const SESSION_TOKEN_MAX_LENGTH = 200;

/**
 * Validate session token
 * @param sessionToken - Session token to validate
 * @returns Validated session token
 * @throws ValidationError if validation fails
 */
export function validateSessionToken(sessionToken: unknown): string {
  if (!sessionToken || typeof sessionToken !== "string") {
    throw new ValidationError(
      "Session token is required and must be a string",
      "sessionToken",
    );
  }

  const trimmed = sessionToken.trim();

  // Session tokens should be UUIDs or similar format
  if (trimmed.length < SESSION_TOKEN_MIN_LENGTH || trimmed.length > SESSION_TOKEN_MAX_LENGTH) {
    throw new ValidationError(
      "Session token has invalid length",
      "sessionToken",
    );
  }

  return trimmed;
}

/**
 * Check if an error is a session token corruption error (invalid length).
 * Used to trigger recovery logic instead of showing an error to the user.
 *
 * @param error - The caught error to check
 * @returns true if this is a session token length corruption error
 */
export function isSessionTokenCorruptionError(error: unknown): boolean {
  return (
    error instanceof ValidationError &&
    error.message.includes("invalid length") &&
    error.field === "sessionToken"
  );
}

/**
 * Validate OAuth provider
 * @param provider - Provider to validate
 * @returns Validated and normalized provider ("google" or "microsoft")
 * @throws ValidationError if validation fails
 *
 * Note: "azure" is normalized to "microsoft" because Azure AD
 * uses the Microsoft Graph API for connection checks.
 */
export function validateProvider(provider: unknown): string {
  if (!provider || typeof provider !== "string") {
    throw new ValidationError(
      "Provider is required and must be a string",
      "provider",
    );
  }

  const lowercase = provider.toLowerCase();

  // Azure AD uses Microsoft Graph API, normalize to "microsoft"
  const normalized = lowercase === "azure" ? "microsoft" : lowercase;

  const validProviders = ["google", "microsoft"];
  if (!validProviders.includes(normalized)) {
    throw new ValidationError(
      `Provider must be one of: ${validProviders.join(", ")}`,
      "provider",
    );
  }

  return normalized;
}

/**
 * Validated contact data interface
 */
export interface ValidatedContactData {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  title?: string | null;
}

/**
 * Raw contact data interface
 */
export interface RawContactData {
  name?: unknown;
  email?: unknown;
  phone?: unknown;
  company?: unknown;
  title?: unknown;
}

/**
 * Validate contact data for creation/update
 * @param contactData - Contact data to validate
 * @param isUpdate - Whether this is an update operation
 * @returns Validated contact data
 * @throws ValidationError if validation fails
 */
export function validateContactData(
  contactData: unknown,
  isUpdate: boolean = false,
): ValidatedContactData {
  if (!contactData || typeof contactData !== "object") {
    throw new ValidationError("Contact data must be an object", "contactData");
  }

  const data = contactData as RawContactData;
  const validated: ValidatedContactData = {};

  // Name is required for creation, optional for update
  if (!isUpdate || data.name !== undefined) {
    validated.name = validateString(data.name, "name", {
      required: !isUpdate,
      minLength: 1,
      maxLength: 200,
    });
  }

  // Email is optional but must be valid if provided
  if (data.email !== undefined && data.email !== null) {
    validated.email = validateEmail(data.email, false);
  }

  // Phone is optional
  if (data.phone !== undefined && data.phone !== null) {
    validated.phone = validateString(data.phone, "phone", {
      required: false,
      maxLength: 50,
    });
  }

  // Company is optional
  if (data.company !== undefined && data.company !== null) {
    validated.company = validateString(data.company, "company", {
      required: false,
      maxLength: 200,
    });
  }

  // Title is optional
  if (data.title !== undefined && data.title !== null) {
    validated.title = validateString(data.title, "title", {
      required: false,
      maxLength: 100,
    });
  }

  return validated;
}

/**
 * Validated transaction data interface
 */
/**
 * What survives validation on the way to `updateTransaction` / the create paths.
 *
 * ===========================================================================
 * BACKLOG-2558 (SR finding F6) — THIS LIST AND THE WRITER'S USED TO DISAGREE
 * ===========================================================================
 * This validator and `transactionDbService`'s `allowedFields` array were two
 * hand-maintained lists on the SAME path, and they had drifted in both
 * directions:
 *
 *  - It validated and forwarded `detection_status`, `reviewed_at` and
 *    `rejection_reason`, which the writer then silently discarded — so Approve
 *    wrote 1 of its 3 fields and Reject hard-failed.
 *  - It forwarded `amount` and `notes`, which are columns of NO table and were
 *    read by nothing on any path.
 *  - It STRIPPED `suggested_contacts`, which the review UI genuinely sends
 *    (`useTransactionDetails.ts:283`, dismissing a suggested party) — so that
 *    payload arrived at the writer empty and threw "No valid fields to update".
 *
 * The writer no longer keeps a list: it derives its accepted set from an
 * exhaustive `Record<TransactionColumn, ColumnPolicy>` (BACKLOG-2737). This
 * interface is now the OTHER half of that contract, and every key on it below
 * `contact_assignments` is a real column the writer accepts.
 *
 * `contact_assignments` is deliberately NOT a column — it is a sibling payload
 * consumed by `createAuditedTransaction`, never by the update path.
 */
export interface ValidatedTransactionData {
  property_address?: string | null;
  property_street?: string | null;
  property_city?: string | null;
  property_state?: string | null;
  property_zip?: string | null;
  property_coordinates?: string | null;
  transaction_type?: string;
  status?: string;
  sale_price?: number;
  listing_price?: number;
  closing_date_verified?: number;
  started_at?: string;
  closed_at?: string;
  closing_deadline?: string;
  // AI detection fields
  detection_status?: string;
  /** `null` is meaningful: the column's "never reviewed" state (BACKLOG-2558). */
  reviewed_at?: string | null;
  /** `null` is meaningful: how Restore clears the reason (BACKLOG-2558). */
  rejection_reason?: string | null;
  /** `null` is meaningful: how the last suggestion is dismissed (BACKLOG-2737). */
  suggested_contacts?: string | null;
  // Contact assignments (for audited transaction creation)
  contact_assignments?: ContactAssignmentData[];
}

// Contact assignment data for transaction creation
export interface ContactAssignmentData {
  contact_id: string;
  role: string;
  role_category?: string;
  is_primary?: number;
  notes?: string | null;
}

/**
 * Raw transaction data interface
 */
export interface RawTransactionData {
  property_address?: unknown;
  property_street?: unknown;
  property_city?: unknown;
  property_state?: unknown;
  property_zip?: unknown;
  property_coordinates?: unknown;
  transaction_type?: unknown;
  amount?: unknown;
  status?: unknown;
  notes?: unknown;
  sale_price?: unknown;
  listing_price?: unknown;
  closing_date_verified?: unknown;
  started_at?: unknown;
  closed_at?: unknown;
  closing_deadline?: unknown;
  // AI detection fields
  detection_status?: unknown;
  reviewed_at?: unknown;
  rejection_reason?: unknown;
  suggested_contacts?: unknown;
  // Contact assignments
  contact_assignments?: unknown;
}

/**
 * Validate transaction data for creation/update
 * @param transactionData - Transaction data to validate
 * @param isUpdate - Whether this is an update operation
 * @returns Validated transaction data
 * @throws ValidationError if validation fails
 */
export function validateTransactionData(
  transactionData: unknown,
  isUpdate: boolean = false,
): ValidatedTransactionData {
  if (!transactionData || typeof transactionData !== "object") {
    throw new ValidationError(
      "Transaction data must be an object",
      "transactionData",
    );
  }

  const data = transactionData as RawTransactionData;
  const validated: ValidatedTransactionData = {};

  // Property address is required for creation
  if (!isUpdate || data.property_address !== undefined) {
    validated.property_address = validateString(
      data.property_address,
      "property_address",
      {
        required: !isUpdate,
        minLength: 5,
        maxLength: 500,
      },
    );
  }

  // Property address components (optional)
  if (data.property_street !== undefined) {
    validated.property_street = validateString(
      data.property_street,
      "property_street",
      { required: false, maxLength: 200 },
    );
  }
  if (data.property_city !== undefined) {
    validated.property_city = validateString(
      data.property_city,
      "property_city",
      { required: false, maxLength: 100 },
    );
  }
  if (data.property_state !== undefined) {
    validated.property_state = validateString(
      data.property_state,
      "property_state",
      { required: false, maxLength: 100 },
    );
  }
  if (data.property_zip !== undefined) {
    validated.property_zip = validateString(
      data.property_zip,
      "property_zip",
      { required: false, maxLength: 20 },
    );
  }
  if (data.property_coordinates !== undefined) {
    // Can be a string (JSON) or null
    if (data.property_coordinates === null) {
      validated.property_coordinates = null;
    } else if (typeof data.property_coordinates === "string") {
      validated.property_coordinates = data.property_coordinates;
    }
  }

  // Transaction type
  if (data.transaction_type !== undefined) {
    const validTypes = ["purchase", "sale", "lease", "refinance", "other"];
    const type =
      typeof data.transaction_type === "string"
        ? data.transaction_type.toLowerCase()
        : "";
    if (!validTypes.includes(type)) {
      throw new ValidationError(
        `Transaction type must be one of: ${validTypes.join(", ")}`,
        "transaction_type",
      );
    }
    validated.transaction_type = type;
  }

  // Amount (if provided)
  //
  // BACKLOG-2558 F6: CHECKED BUT NOT FORWARDED. `transactions` has no `amount`
  // column — on any path — so forwarding it only handed the writer a key it had
  // to discard. The check stays: deleting it would turn today's ValidationError
  // on `amount: -5` into silence, which is the wrong direction for this epic.
  if (data.amount !== undefined && data.amount !== null) {
    const amount = Number(data.amount);
    if (isNaN(amount) || amount < 0) {
      throw new ValidationError(
        "Amount must be a non-negative number",
        "amount",
      );
    }
  }

  // Status
  if (data.status !== undefined) {
    const validStatuses = ["active", "pending", "closed", "cancelled"];
    const status =
      typeof data.status === "string" ? data.status.toLowerCase() : "";
    if (!validStatuses.includes(status)) {
      throw new ValidationError(
        `Status must be one of: ${validStatuses.join(", ")}`,
        "status",
      );
    }
    validated.status = status;
  }

  // Notes (optional)
  //
  // BACKLOG-2558 F6: CHECKED BUT NOT FORWARDED, for the same reason as `amount`
  // — `transactions` has no `notes` column. (Contact assignments carry their own
  // `notes`, on `transaction_contacts`; that is a different field and is handled
  // under `contact_assignments` below.)
  if (data.notes !== undefined && data.notes !== null) {
    validateString(data.notes, "notes", {
      required: false,
      maxLength: 10000,
    });
  }

  // Sale price (optional)
  if (data.sale_price !== undefined && data.sale_price !== null) {
    const price = Number(data.sale_price);
    if (isNaN(price) || price < 0) {
      throw new ValidationError(
        "Sale price must be a non-negative number",
        "sale_price",
      );
    }
    validated.sale_price = price;
  }

  // Listing price (optional)
  if (data.listing_price !== undefined && data.listing_price !== null) {
    const price = Number(data.listing_price);
    if (isNaN(price) || price < 0) {
      throw new ValidationError(
        "Listing price must be a non-negative number",
        "listing_price",
      );
    }
    validated.listing_price = price;
  }

  // Closing date verified flag (optional, must be 0 or 1)
  if (
    data.closing_date_verified !== undefined &&
    data.closing_date_verified !== null
  ) {
    const verified = Number(data.closing_date_verified);
    if (verified !== 0 && verified !== 1) {
      throw new ValidationError(
        "Closing date verified must be 0 or 1",
        "closing_date_verified",
      );
    }
    validated.closing_date_verified = verified;
  }

  // Started at date (optional, must be valid date string)
  if (data.started_at !== undefined && data.started_at !== null) {
    if (typeof data.started_at === "string" && data.started_at.trim()) {
      // Validate it's a valid date format (YYYY-MM-DD or ISO date string)
      const dateStr = data.started_at.trim();
      if (!/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
        throw new ValidationError(
          "Started at date must be in YYYY-MM-DD format",
          "started_at",
        );
      }
      validated.started_at = dateStr;
    }
  }

  // Closed at date (optional, must be valid date string)
  if (data.closed_at !== undefined && data.closed_at !== null) {
    if (typeof data.closed_at === "string" && data.closed_at.trim()) {
      // Validate it's a valid date format (YYYY-MM-DD or ISO date string)
      const dateStr = data.closed_at.trim();
      if (!/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
        throw new ValidationError(
          "Closed at date must be in YYYY-MM-DD format",
          "closed_at",
        );
      }
      validated.closed_at = dateStr;
    }
  }

  // Closing deadline date (optional, must be valid date string)
  if (data.closing_deadline !== undefined && data.closing_deadline !== null) {
    if (typeof data.closing_deadline === "string" && data.closing_deadline.trim()) {
      // Validate it's a valid date format (YYYY-MM-DD or ISO date string)
      const dateStr = data.closing_deadline.trim();
      if (!/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
        throw new ValidationError(
          "Closing deadline date must be in YYYY-MM-DD format",
          "closing_deadline",
        );
      }
      validated.closing_deadline = dateStr;
    }
  }

  // Detection status (for AI-detected transactions)
  if (data.detection_status !== undefined) {
    const validDetectionStatuses = ["pending", "confirmed", "rejected"];
    const detectionStatus =
      typeof data.detection_status === "string"
        ? data.detection_status.toLowerCase()
        : "";
    if (!validDetectionStatuses.includes(detectionStatus)) {
      throw new ValidationError(
        `Detection status must be one of: ${validDetectionStatuses.join(", ")}`,
        "detection_status",
      );
    }
    validated.detection_status = detectionStatus;
  }

  // ===========================================================================
  // BACKLOG-2558 — A NULL IS A VALUE HERE, NOT AN ABSENCE.
  // ===========================================================================
  // Both guards below used to read `!== undefined && !== null`, which collapses
  // "clear this column" into "say nothing about this column". For a nullable
  // column whose NULL state is meaningful those are opposite instructions, and
  // the writer never got to tell them apart because the key had already been
  // dropped here.
  //
  // `undefined` still means "not mentioned" and is still skipped. Only an
  // explicit `null` is now forwarded.

  // Reviewed at timestamp (for AI-detected transactions).
  //
  // NULL is this column's "never reviewed" state. No caller sends
  // `reviewed_at: null` today — this one was LATENT, not live — but it is the
  // identical shape to the `rejection_reason` defect below, one line away from
  // it, and an un-review or restore-to-pending path would meet the same trap.
  if (data.reviewed_at !== undefined) {
    if (data.reviewed_at === null) {
      validated.reviewed_at = null;
    } else if (typeof data.reviewed_at === "string" && data.reviewed_at.trim()) {
      validated.reviewed_at = data.reviewed_at.trim();
    }
  }

  // Rejection reason (for rejected AI-detected transactions).
  //
  // THE LIVE ONE. `restore()` (src/services/transactionService.ts:223-233)
  // sends `rejection_reason: null`, and that is the ONLY way this column is
  // ever cleared. Stripping the null here left the old reason on the row — the
  // third effect BACKLOG-2558 reports, and the one the WRITER already handles
  // correctly: `TRANSACTION_COLUMN_POLICY.rejection_reason` states the rule
  // outright ("CLEARED BY RESTORE — which is why null must land as null rather
  // than being skipped as 'no value'"). The writer honoured it; this validator
  // did not. Two hand-maintained lists on one path, drifting on a VALUE instead
  // of on a NAME — the same defect class wearing a different coat.
  if (data.rejection_reason !== undefined) {
    validated.rejection_reason =
      data.rejection_reason === null
        ? null
        : validateString(data.rejection_reason, "rejection_reason", {
            required: false,
            maxLength: 1000,
          });
  }

  // Suggested contacts (JSON array of parties a detection proposed).
  //
  // BACKLOG-2737/2558 F6: this was validated by NOTHING and forwarded by
  // nothing, while `useTransactionDetails.ts:283` sends it as the SOLE key of
  // its payload when the user dismisses a suggested party. The payload was
  // therefore emptied here and the writer threw "No valid fields to update" —
  // the same drift as the review actions, in the opposite direction.
  //
  // `null` is meaningful and must survive: it is how the last remaining
  // suggestion is cleared.
  if (data.suggested_contacts !== undefined) {
    if (data.suggested_contacts === null) {
      validated.suggested_contacts = null;
    } else if (typeof data.suggested_contacts === "string") {
      validated.suggested_contacts = data.suggested_contacts;
    } else {
      throw new ValidationError(
        "Suggested contacts must be a JSON string or null",
        "suggested_contacts",
      );
    }
  }

  // Contact assignments (for audited transaction creation)
  if (data.contact_assignments !== undefined && Array.isArray(data.contact_assignments)) {
    validated.contact_assignments = data.contact_assignments.map((assignment: unknown) => {
      if (typeof assignment !== "object" || assignment === null) {
        throw new ValidationError("Contact assignment must be an object", "contact_assignments");
      }
      const a = assignment as { contact_id?: unknown; role?: unknown; role_category?: unknown; is_primary?: unknown; notes?: unknown };
      if (!a.contact_id || typeof a.contact_id !== "string") {
        throw new ValidationError("Contact assignment must have a valid contact_id", "contact_assignments");
      }
      if (!a.role || typeof a.role !== "string") {
        throw new ValidationError("Contact assignment must have a valid role", "contact_assignments");
      }
      return {
        contact_id: a.contact_id,
        role: a.role,
        role_category: typeof a.role_category === "string" ? a.role_category : undefined,
        is_primary: typeof a.is_primary === "number" ? a.is_primary : 0,
        notes: typeof a.notes === "string" ? a.notes : null,
      };
    });
  }

  return validated;
}

/**
 * Validate file path for security
 * @param filePath - File path to validate
 * @returns Validated file path
 * @throws ValidationError if validation fails
 */
export function validateFilePath(filePath: unknown): string {
  if (!filePath || typeof filePath !== "string") {
    throw new ValidationError(
      "File path is required and must be a string",
      "filePath",
    );
  }

  const trimmed = filePath.trim();

  // Prevent path traversal attacks
  if (trimmed.includes("..") || trimmed.includes("~")) {
    throw new ValidationError(
      "File path contains invalid characters",
      "filePath",
    );
  }

  // Prevent extremely long paths (DoS)
  if (trimmed.length > 4096) {
    throw new ValidationError("File path is too long", "filePath");
  }

  return trimmed;
}

/**
 * Validate URL for security
 * @param url - URL to validate
 * @returns Validated URL
 * @throws ValidationError if validation fails
 */
export function validateUrl(url: unknown): string {
  if (!url || typeof url !== "string") {
    throw new ValidationError("URL is required and must be a string", "url");
  }

  const trimmed = url.trim();

  try {
    const urlObj = new URL(trimmed);

    // Only allow http and https protocols
    if (!["http:", "https:"].includes(urlObj.protocol)) {
      throw new ValidationError("URL must use http or https protocol", "url");
    }

    return trimmed;
  } catch {
    throw new ValidationError("Invalid URL format", "url");
  }
}

/**
 * Sanitize object to prevent prototype pollution
 * @param obj - Object to sanitize
 * @returns Sanitized object
 */
export function sanitizeObject(
  obj: unknown,
): Record<string, unknown> | unknown {
  if (!obj || typeof obj !== "object") {
    return obj;
  }

  // Prevent prototype pollution
  const dangerous = ["__proto__", "constructor", "prototype"];
  const cleaned: Record<string, unknown> = {};

  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      if (!dangerous.includes(key)) {
        cleaned[key] = (obj as Record<string, unknown>)[key];
      }
    }
  }

  return cleaned;
}

// =============================================================================
// SECURITY: Device and Spawn Input Validation
// =============================================================================
// These validators are CRITICAL for preventing command injection attacks.
// All spawn/exec calls that take external input MUST validate that input first.
//
// SECURITY AUDIT (TASK-601):
// - appleDriverService.ts: PowerShell spawn uses internal paths only (safe)
// - backupService.ts: UDID from IPC - MUST validate before spawn
// - deviceDetectionService.ts: UDID from IPC - MUST validate before spawn
// =============================================================================

/**
 * iOS Device UDID format patterns.
 *
 * SECURITY: UDIDs are used as command-line arguments to ideviceinfo, idevicebackup2, etc.
 * If not validated, a malicious UDID could inject shell commands.
 *
 * Valid UDID formats:
 * - iOS devices (pre-iPhone X): 40 hexadecimal characters
 *   Example: "a1b2c3d4e5f6789012345678901234567890abcd"
 *
 * - iOS devices (iPhone X+): 8-4-16 format with hyphens (25 chars total)
 *   Example: "00000000-0000000000000000"
 *
 * - Simulator UDIDs: Standard UUID format (36 chars with hyphens)
 *   Example: "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
 */
const UDID_PATTERNS = {
  /** 40 hex chars - traditional iOS UDID format */
  TRADITIONAL: /^[0-9a-fA-F]{40}$/,
  /** 8-4-16 format - newer iOS devices (iPhone X+) */
  MODERN: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{16}$/,
  /** UUID format - iOS Simulator */
  SIMULATOR: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
};

/**
 * Validate iOS device UDID for use in spawn/exec commands.
 *
 * SECURITY: This is a CRITICAL security function. UDIDs are passed as arguments
 * to libimobiledevice CLI tools (ideviceinfo, idevicebackup2, etc.). Without
 * validation, a malicious UDID could contain shell metacharacters that enable
 * command injection.
 *
 * @param udid - Device UDID to validate
 * @param required - Whether the field is required (default: true)
 * @returns Validated UDID string
 * @throws ValidationError if validation fails
 *
 * @example
 * // Valid UDIDs
 * validateDeviceUdid("00000000-0000000000000000"); // Modern format
 * validateDeviceUdid("a1b2c3d4e5f6789012345678901234567890abcd"); // Traditional
 *
 * // Invalid - would throw ValidationError
 * validateDeviceUdid("$(rm -rf /)"); // Command injection attempt
 * validateDeviceUdid("udid; cat /etc/passwd"); // Shell metacharacters
 */
export function validateDeviceUdid(
  udid: unknown,
  required: boolean = true,
): string {
  // Check for null/undefined/empty
  if (udid === null || udid === undefined || udid === "") {
    if (required) {
      throw new ValidationError("Device UDID is required", "udid");
    }
    return "";
  }

  // Must be a string
  if (typeof udid !== "string") {
    throw new ValidationError("Device UDID must be a string", "udid");
  }

  const trimmed = udid.trim();

  // Check length bounds (shortest is 25 for modern format, longest is 40 for traditional)
  if (trimmed.length < 25 || trimmed.length > 40) {
    throw new ValidationError(
      "Device UDID has invalid length (expected 25-40 characters)",
      "udid",
    );
  }

  // Validate against known UDID patterns
  const isValidFormat =
    UDID_PATTERNS.TRADITIONAL.test(trimmed) ||
    UDID_PATTERNS.MODERN.test(trimmed) ||
    UDID_PATTERNS.SIMULATOR.test(trimmed);

  if (!isValidFormat) {
    throw new ValidationError(
      "Device UDID has invalid format (must be hexadecimal with optional hyphens)",
      "udid",
    );
  }

  return trimmed;
}

/**
 * Check if a UDID is valid without throwing.
 *
 * SECURITY: Use this for quick validation checks before spawning processes.
 *
 * @param udid - Device UDID to check
 * @returns true if valid, false otherwise
 *
 * @example
 * if (!isValidDeviceUdid(options.udid)) {
 *   return { success: false, error: "Invalid device UDID" };
 * }
 */
export function isValidDeviceUdid(udid: unknown): boolean {
  try {
    validateDeviceUdid(udid);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate an executable path for spawn/exec operations.
 *
 * SECURITY: Executable paths used with spawn() must be validated to prevent:
 * - Path traversal attacks (../)
 * - Execution of arbitrary binaries
 * - Shell injection via path manipulation
 *
 * @param execPath - Path to the executable
 * @param allowedBasePaths - Array of allowed base paths the executable must be under
 * @returns Validated path string
 * @throws ValidationError if path is invalid or not under allowed paths
 *
 * @example
 * // Validate that an executable is in the expected location
 * const validPath = validateExecutablePath(
 *   "/app/resources/win/libimobiledevice/ideviceinfo.exe",
 *   ["/app/resources/win/libimobiledevice", "C:\\Program Files\\7-Zip"]
 * );
 */
export function validateExecutablePath(
  execPath: unknown,
  allowedBasePaths: string[],
): string {
  if (!execPath || typeof execPath !== "string") {
    throw new ValidationError(
      "Executable path is required and must be a string",
      "execPath",
    );
  }

  const trimmed = execPath.trim();

  // Check for empty path
  if (trimmed.length === 0) {
    throw new ValidationError("Executable path cannot be empty", "execPath");
  }

  // Prevent path traversal attacks
  if (trimmed.includes("..")) {
    throw new ValidationError(
      "Executable path contains path traversal sequences",
      "execPath",
    );
  }

  // Check for shell metacharacters that could enable injection
  // These characters have special meaning in shell contexts
  const dangerousChars = /[;&|`$(){}[\]<>!#*?~\n\r]/;
  if (dangerousChars.test(trimmed)) {
    throw new ValidationError(
      "Executable path contains dangerous characters",
      "execPath",
    );
  }

  // Normalize path separators for cross-platform comparison
  const normalizedPath = trimmed.replace(/\\/g, "/").toLowerCase();

  // Verify path is under one of the allowed base paths
  const isUnderAllowedPath = allowedBasePaths.some((basePath) => {
    const normalizedBase = basePath.replace(/\\/g, "/").toLowerCase();
    return normalizedPath.startsWith(normalizedBase);
  });

  if (!isUnderAllowedPath) {
    throw new ValidationError(
      "Executable path is not in an allowed location",
      "execPath",
    );
  }

  return trimmed;
}

/**
 * Validate an MSI installer path for Windows driver installation.
 *
 * SECURITY: MSI paths are embedded in PowerShell commands. Invalid paths
 * could enable command injection. This function ensures:
 * - Path is within expected directories (app resources or userData)
 * - No path traversal sequences
 * - File has .msi extension
 *
 * @param msiPath - Path to the MSI file
 * @param allowedBasePaths - Array of allowed base paths
 * @returns Validated path string
 * @throws ValidationError if validation fails
 *
 * @example
 * validateMsiPath(
 *   "C:\\Users\\App\\resources\\win\\AppleMobileDeviceSupport64.msi",
 *   [app.getPath("userData"), process.resourcesPath]
 * );
 */
export function validateMsiPath(
  msiPath: unknown,
  allowedBasePaths: string[],
): string {
  if (!msiPath || typeof msiPath !== "string") {
    throw new ValidationError(
      "MSI path is required and must be a string",
      "msiPath",
    );
  }

  const trimmed = msiPath.trim();

  // Must end with .msi extension
  if (!trimmed.toLowerCase().endsWith(".msi")) {
    throw new ValidationError("Path must be an MSI file", "msiPath");
  }

  // Validate as executable path (reuse common checks)
  return validateExecutablePath(trimmed, allowedBasePaths);
}
