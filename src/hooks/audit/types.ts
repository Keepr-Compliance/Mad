/**
 * Shared type definitions for audit transaction hooks.
 * Extracted from useAuditTransaction.ts (TASK-2261)
 */

export interface AddressData {
  property_address: string;
  property_street: string;
  property_city: string;
  property_state: string;
  property_zip: string;
  property_coordinates: Coordinates | null;
  transaction_type: string;
  started_at: string;  // ISO8601 date string - when representation began
  closing_deadline?: string;  // ISO8601 date string - scheduled closing date
  closed_at?: string;  // ISO8601 date string - when transaction ended (optional, null = ongoing)
  /**
   * BACKLOG-3614: the optional Listing Price field exactly as typed ("$525,000").
   * Never sent as-is: the submission parses it with `parseMoney` into
   * `listing_price`. Blank means not entered.
   */
  listing_price_text?: string;
}

export interface Coordinates {
  lat: number;
  lng: number;
}

export interface AddressSuggestion {
  placeId?: string;
  place_id?: string;
  description?: string;
  formatted_address?: string;
  main_text?: string;
  secondary_text?: string;
}

export interface ContactAssignment {
  contactId: string;
  contactName?: string;  // TASK-1030: Added for edit mode pre-population
  contactEmail?: string;
  contactPhone?: string;
  contactCompany?: string;
  isPrimary: boolean;
  notes: string;
}

export interface ContactAssignments {
  [role: string]: ContactAssignment[];
}

export interface AddressDetails {
  formatted_address?: string;
  street?: string;
  city?: string;
  state_short?: string;
  state?: string;
  zip?: string;
  coordinates?: Coordinates | null;
}

export interface AddressDetailsResult {
  success: boolean;
  formatted_address?: string;
  address?: AddressDetails;
  street?: string;
  city?: string;
  state_short?: string;
  state?: string;
  zip?: string;
  coordinates?: Coordinates | null;
}
