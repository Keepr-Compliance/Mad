/**
 * useAuditAddressForm Hook
 * Manages address form state, Google Places autocomplete, and geocoding.
 * Extracted from useAuditTransaction.ts (TASK-2261)
 */
import { useState, useEffect, useCallback, useRef } from "react";
import type { Transaction } from "../../../electron/types/models";
import type { AddressData, AddressSuggestion, AddressDetails, AddressDetailsResult, Coordinates } from "./types";
import logger from "../../utils/logger";

/**
 * Get default start date (3 months ago from today)
 * Typical recent transaction timeframe for real estate audits
 */
function getDefaultStartDate(): string {
  const date = new Date();
  date.setMonth(date.getMonth() - 3);
  return date.toISOString().split("T")[0]; // YYYY-MM-DD format
}

function getTodayDate(): string {
  return new Date().toISOString().split("T")[0];
}

export const initialAddressData: AddressData = {
  property_address: "",
  property_street: "",
  property_city: "",
  property_state: "",
  property_zip: "",
  property_coordinates: null,
  transaction_type: "purchase",
  started_at: getDefaultStartDate(),
  closing_deadline: undefined,
  closed_at: getTodayDate(),
};

interface UseAuditAddressFormProps {
  editTransaction?: Transaction;
  userId: string;
  isEditing: boolean;
}

export interface UseAuditAddressFormReturn {
  addressData: AddressData;
  setAddressData: React.Dispatch<React.SetStateAction<AddressData>>;
  showAddressAutocomplete: boolean;
  addressSuggestions: AddressSuggestion[];
  handleAddressChange: (value: string) => Promise<void>;
  selectAddress: (suggestion: AddressSuggestion) => Promise<void>;
  originalAddressData: AddressData | null;
  // Start date auto-detect state (TASK-1974)
  startDateMode: "auto" | "manual" | undefined;
  autoDetectedDate: string | null | undefined;
  isAutoDetecting: boolean;
  setStartDateMode: (mode: "auto" | "manual") => void;
  // Detect start date from earliest contact communications (TASK-1974)
  detectStartDate: (contactIds: string[]) => Promise<void>;
}

export function useAuditAddressForm({
  editTransaction,
  userId,
  isEditing,
}: UseAuditAddressFormProps): UseAuditAddressFormReturn {
  const [addressData, setAddressData] = useState<AddressData>(initialAddressData);
  const [originalAddressData, setOriginalAddressData] = useState<AddressData | null>(null);
  const [showAddressAutocomplete, setShowAddressAutocomplete] = useState<boolean>(false);
  const [addressSuggestions, setAddressSuggestions] = useState<AddressSuggestion[]>([]);
  const [sessionToken] = useState<string>(() => `session_${Date.now()}_${Math.random()}`);

  // Auto-detect start date state (TASK-1974, TASK-1980: default to "manual")
  const [startDateModeState, setStartDateModeState] = useState<"auto" | "manual" | null>(null);
  const [autoDetectedDate, setAutoDetectedDate] = useState<string | null | undefined>(undefined);
  const [isAutoDetecting, setIsAutoDetecting] = useState(false);

  // Track if component is mounted to prevent state updates after unmount
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // TASK-1980: Read user preference for start date default mode on mount
  useEffect(() => {
    if (isEditing) {
      setStartDateModeState("manual");
      return;
    }
    if (!userId) return;
    const loadStartDatePreference = async () => {
      try {
        const result = await window.api.preferences.get(userId) as {
          success: boolean;
          preferences?: {
            audit?: { startDateDefault?: "auto" | "manual" };
          };
        };
        if (result.success && result.preferences?.audit?.startDateDefault) {
          const preferred = result.preferences.audit.startDateDefault;
          if (preferred === "auto" || preferred === "manual") {
            setStartDateModeState(preferred);
            return;
          }
        }
        setStartDateModeState("manual");
      } catch {
        setStartDateModeState("manual");
      }
    };
    loadStartDatePreference();
  }, [isEditing, userId]);

  /**
   * Handle start date mode change (TASK-1974)
   */
  const setStartDateMode = useCallback((mode: "auto" | "manual") => {
    setStartDateModeState(mode);
    if (mode === "auto" && autoDetectedDate) {
      setAddressData(prev => ({ ...prev, started_at: autoDetectedDate }));
    }
  }, [autoDetectedDate]);

  /**
   * Auto-detect the earliest communication date for selected contacts (TASK-1974)
   * Called externally by the composition hook when selectedContactIds change.
   */
  const detectStartDate = useCallback(async (contactIds: string[]) => {
    if (contactIds.length === 0 || !userId) return;
    if (!isMountedRef.current) return;

    setIsAutoDetecting(true);
    try {
      const transactions = window.api.transactions as typeof window.api.transactions & {
        getEarliestCommunicationDate: (
          contactIds: string[],
          userId: string,
        ) => Promise<{ success: boolean; date?: string | null; error?: string }>;
      };
      const result = await transactions.getEarliestCommunicationDate(
        contactIds,
        userId,
      );

      if (!isMountedRef.current) return;

      if (result.success && result.date) {
        const dateStr = result.date.split("T")[0];
        setAutoDetectedDate(dateStr);
        setStartDateModeState(currentMode => {
          if (currentMode === "auto") {
            setAddressData(prev => ({ ...prev, started_at: dateStr }));
          }
          return currentMode;
        });
      } else {
        setAutoDetectedDate(null);
      }
    } catch {
      if (!isMountedRef.current) return;
      setAutoDetectedDate(null);
    } finally {
      if (isMountedRef.current) {
        setIsAutoDetecting(false);
      }
    }
  }, [userId]);

  /**
   * Initialize Google Places API (if available)
   */
  useEffect(() => {
    const initializeAPI = async (): Promise<void> => {
      if (window.api?.address?.initialize) {
        try {
          await window.api.address.initialize("");
        } catch (initError: unknown) {
          logger.warn(
            "[AuditTransaction] Address verification not available:",
            initError,
          );
        }
      }
    };
    initializeAPI();
  }, []);

  /**
   * Pre-fill form when editing an existing transaction
   */
  useEffect(() => {
    if (!editTransaction) return;

    const populateFormData = (txn: Transaction) => {
      let coordinates: Coordinates | null = null;
      if (txn.property_coordinates) {
        try {
          coordinates = JSON.parse(txn.property_coordinates);
        } catch {
          // Invalid JSON, leave as null
        }
      }

      const prefillData: AddressData = {
        property_address: txn.property_address || "",
        property_street: txn.property_street || "",
        property_city: txn.property_city || "",
        property_state: txn.property_state || "",
        property_zip: txn.property_zip || "",
        property_coordinates: coordinates,
        transaction_type: txn.transaction_type || "purchase",
        started_at: txn.started_at
          ? txn.started_at.split("T")[0]
          : getDefaultStartDate(),
        closing_deadline: txn.closing_deadline
          ? txn.closing_deadline.split("T")[0]
          : undefined,
        closed_at: txn.closed_at
          ? txn.closed_at.split("T")[0]
          : undefined,
      };

      setAddressData(prefillData);
      setOriginalAddressData(prefillData);
    };

    populateFormData(editTransaction);
  }, [editTransaction]);

  /**
   * Handle address input change with autocomplete
   */
  const handleAddressChange = useCallback(async (value: string): Promise<void> => {
    setAddressData(prev => ({ ...prev, property_address: value }));

    if (value.length > 3 && window.api?.address?.getSuggestions) {
      try {
        const result = await window.api.address.getSuggestions(value, sessionToken);
        if (result.success && result.suggestions && result.suggestions.length > 0) {
          setAddressSuggestions(result.suggestions);
          setShowAddressAutocomplete(true);
        } else {
          setAddressSuggestions([]);
          setShowAddressAutocomplete(false);
        }
      } catch (fetchError: unknown) {
        logger.error("[AuditTransaction] Failed to fetch address suggestions:", fetchError);
        setShowAddressAutocomplete(false);
        setAddressSuggestions([]); // BACKLOG-1824: clear stale suggestions on API error
      }
    } else {
      setShowAddressAutocomplete(false);
      setAddressSuggestions([]);
    }
  }, [sessionToken]);

  /**
   * Select address from autocomplete
   */
  const selectAddress = useCallback(async (suggestion: AddressSuggestion): Promise<void> => {
    if (!window.api?.address?.getDetails) {
      setAddressData(prev => ({
        ...prev,
        property_address: suggestion.formatted_address || suggestion.description || "",
      }));
      setShowAddressAutocomplete(false);
      return;
    }

    try {
      const placeId = suggestion.place_id || suggestion.placeId || "";
      const result: AddressDetailsResult = await window.api.address.getDetails(placeId);
      if (result.success) {
        const addr: AddressDetails = result.address || {};
        setAddressData(prev => ({
          ...prev,
          property_address:
            addr.formatted_address ||
            result.formatted_address ||
            suggestion.formatted_address ||
            suggestion.description ||
            "",
          property_street: addr.street || result.street || "",
          property_city: addr.city || result.city || "",
          property_state:
            addr.state_short ||
            addr.state ||
            result.state_short ||
            result.state ||
            "",
          property_zip: addr.zip || result.zip || "",
          property_coordinates: addr.coordinates || result.coordinates || null,
        }));
      } else {
        setAddressData(prev => ({
          ...prev,
          property_address: suggestion.formatted_address || suggestion.description || "",
        }));
      }
    } catch (detailsError: unknown) {
      logger.error("[AuditTransaction] Failed to get address details:", detailsError);
      setAddressData(prev => ({
        ...prev,
        property_address: suggestion.formatted_address || suggestion.description || "",
      }));
    }
    setShowAddressAutocomplete(false);
  }, []);

  return {
    addressData,
    setAddressData,
    showAddressAutocomplete,
    addressSuggestions,
    handleAddressChange,
    selectAddress,
    originalAddressData,
    startDateMode: startDateModeState ?? undefined,
    autoDetectedDate,
    isAutoDetecting,
    setStartDateMode,
    detectStartDate,
  };
}
