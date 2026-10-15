/**
 * Settings → Messages → "How far back to import texts" (BACKLOG-3892 S3).
 *
 * One picker for every text source (macOS Messages, iPhone, Google Messages),
 * on Mac and Windows, mounted directly under the source selection and outside
 * the per-source panels. It replaces the pickers the macOS and Google Messages
 * panels each had. The value is `messageImport.filters.lookbackMonths`, the
 * key all three sources read (see textsLookback.tsx).
 */

import React from "react";
import { LookbackMonthsSelect } from "./LookbackMonthsSelect";
import { TEXTS_LOOKBACK_TARGET, useTextsLookback } from "./textsLookback";

export const TEXTS_LOOKBACK_HEADING = "How far back to import texts";

interface TextsLookbackSettingsProps {
  userId: string;
  /**
   * BACKLOG-3892 (founder QA 2026-10-12): render as one row of the macOS
   * panel's Import Preferences card, directly under "Maximum messages" —
   * the same row shape as that control, no card and no heading of its own.
   * Settings passes it only when that card is live (Mac, macOS Messages
   * source); every other case keeps the standalone card.
   */
  embedded?: boolean;
}

export function TextsLookbackSettings({ userId, embedded = false }: TextsLookbackSettingsProps) {
  const { months, settled, saveFailed, change } = useTextsLookback(userId);

  const select = (
    <LookbackMonthsSelect
      value={months}
      onChange={(v) => void change(v)}
      disabled={!settled}
      aria-label="Import messages from"
      data-testid="texts-lookback-select"
    />
  );
  const error = saveFailed && (
    <p className="text-xs text-red-600 mt-2" role="alert" data-testid="texts-lookback-error">
      Keepr could not save that.
    </p>
  );

  if (embedded) {
    return (
      <div id={TEXTS_LOOKBACK_TARGET} className="mt-2" data-testid="texts-lookback">
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-600">Import messages from</span>
          {select}
        </div>
        {error}
      </div>
    );
  }

  return (
    <div
      id={TEXTS_LOOKBACK_TARGET}
      className="p-4 bg-white rounded-lg border border-gray-200"
      data-testid="texts-lookback"
    >
      <p className="text-sm font-medium text-gray-900 mb-2">{TEXTS_LOOKBACK_HEADING}</p>
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-600">Import messages from</span>
        {select}
      </div>
      {error}
    </div>
  );
}
