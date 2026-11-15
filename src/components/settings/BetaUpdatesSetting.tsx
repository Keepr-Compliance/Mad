/**
 * BACKLOG-4245: the "Get beta versions" switch (Settings > General).
 *
 * Whether it is shown, and whether betas are active, is decided in the main
 * process (`settingsService.getBetaUpdatesState`). The section renders without
 * the switch until that answers. The switch shows the user's stored setting;
 * a line under it says why betas are not active. A failed change shows a
 * message and the switch returns to what the main process reports.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { settingsService } from "../../services";
import { ToggleSwitch } from "./ToggleSwitch";
import type { BetaUpdatesState } from "../../../electron/types/ipc/window-api-services";
import {
  BETA_UPDATES_ARIA_LABEL,
  BETA_UPDATES_HELP,
  BETA_UPDATES_SAVE_FAILED,
  BETA_UPDATES_TITLE,
  betaUpdatesNoteText,
} from "./betaUpdatesCopy";

interface BetaUpdatesSettingProps {
  userId: string;
  isOnline: boolean;
}

export function BetaUpdatesSetting({ userId, isOnline }: BetaUpdatesSettingProps): React.ReactElement | null {
  const [state, setState] = useState<BetaUpdatesState | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);

  const load = useCallback(async (): Promise<void> => {
    const next = await settingsService.getBetaUpdatesState();
    if (mounted.current) setState(next);
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const handleChange = async (next: boolean): Promise<void> => {
    if (!state) return;
    setFailed(false);
    setSaving(true);
    setState({ ...state, stored: next });
    let ok = false;
    try {
      const result = await settingsService.setBetaUpdates(userId, next);
      ok = result.success === true;
    } catch {
      ok = false;
    }
    if (!mounted.current) return;
    if (!ok) setFailed(true);
    await load();
    if (mounted.current) setSaving(false);
  };

  if (!state || !state.visible) return null;
  const note = betaUpdatesNoteText(state.note);

  return (
    <div className="mt-4 pt-4 border-t border-gray-200" data-testid="settings-beta-updates">
      <div className="flex items-center justify-between">
        <div className="flex-1">
          <h4 className="text-sm font-medium text-gray-900">{BETA_UPDATES_TITLE}</h4>
          <p className="text-xs text-gray-600 mt-1">{BETA_UPDATES_HELP}</p>
        </div>
        <ToggleSwitch
          className="ml-4"
          checked={state.stored}
          onChange={(next) => void handleChange(next)}
          ariaLabel={BETA_UPDATES_ARIA_LABEL}
          disabled={saving || !isOnline}
          testId="settings-beta-updates-toggle"
        />
      </div>
      {note && (
        <p className="text-xs text-gray-700 mt-2" data-testid="settings-beta-updates-note">
          {note}
        </p>
      )}
      {failed && (
        <p className="text-xs text-red-600 mt-2" role="alert" data-testid="settings-beta-updates-error">
          {BETA_UPDATES_SAVE_FAILED}
        </p>
      )}
    </div>
  );
}
