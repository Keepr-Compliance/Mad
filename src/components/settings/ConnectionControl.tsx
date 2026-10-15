import React from "react";
import { ConnectionMenu, type ConnectionMenuItem } from "./ConnectionMenu";

/**
 * BACKLOG-3156 stage G — THE ONE SOURCE-ROW CONNECTION CONTROL.
 *
 * Email sources (Gmail, Outlook) and the Android: Google Messages row in the
 * Messages Sources card show the same control: a green dot + "Connected" and a
 * kebab menu while connected, a blue button while not. It was markup inside
 * EmailSettings' ProviderConnectionControl; it lives here so the Messages row
 * reuses it instead of copying it. ProviderConnectionControl is now an adapter
 * over this component (it keeps its own yellow Reconnect branch).
 */
export interface ConnectionControlProps {
  state: "checking" | "connected" | "disconnected";
  /** Prefix for every testid: `${testIdBase}-dot`, `-status`, `-connect`, `-checking`, and the menu's. */
  testIdBase: string;
  /** Text of the blue button while disconnected (e.g. "Connect Gmail", "Link"). */
  connectLabel: string;
  onConnect: () => void;
  connectDisabled?: boolean;
  connectTitle?: string;
  /** Text shown while checking. */
  checkingContent?: React.ReactNode;
  /** Word beside the green dot (default "Connected"). */
  connectedLabel?: string;
  /** Accessible name of the kebab trigger. */
  menuAriaLabel: string;
  menuItems: ConnectionMenuItem[];
}

export function ConnectionControl({
  state,
  testIdBase,
  connectLabel,
  onConnect,
  connectDisabled,
  connectTitle,
  checkingContent = "Checking...",
  connectedLabel = "Connected",
  menuAriaLabel,
  menuItems,
}: ConnectionControlProps): React.ReactElement {
  if (state === "checking") {
    return (
      <div className="text-xs text-gray-500" data-testid={`${testIdBase}-checking`}>
        {checkingContent}
      </div>
    );
  }

  if (state === "connected") {
    return (
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-2">
          <div
            data-testid={`${testIdBase}-dot`}
            className="w-2 h-2 bg-green-500 rounded-full"
          ></div>
          <span
            data-testid={`${testIdBase}-status`}
            className="text-xs text-green-600 font-medium"
          >
            {connectedLabel}
          </span>
        </div>
        <ConnectionMenu
          testId={testIdBase}
          triggerAriaLabel={menuAriaLabel}
          items={menuItems}
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onConnect}
      disabled={connectDisabled}
      title={connectTitle}
      data-testid={`${testIdBase}-connect`}
      className="px-3 py-2 bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium rounded transition-all disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {connectLabel}
    </button>
  );
}
