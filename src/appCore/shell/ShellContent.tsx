/**
 * ShellContent — the app's content area (BACKLOG-3964).
 *
 * The routed screen and its popups scroll in one container; the Settings page
 * is a sibling layer over it. While Settings is showing, the container is
 * `inert`, so no focus, click or screen-reader read reaches the Dashboard (or a
 * popup) underneath.
 */
import React from "react";
import type { AppStateMachine } from "../state/types";
import { SettingsLayer } from "./SettingsLayer";

// React 18 drops a boolean `inert`; the attribute must be the empty string.
const INERT = { inert: "" } as unknown as React.HTMLAttributes<HTMLDivElement>;

interface ShellContentProps {
  app: AppStateMachine;
  children: React.ReactNode;
}

export function ShellContent({ app, children }: ShellContentProps) {
  const settingsShown = app.modalState.showSettings && !!app.currentUser;
  return (
    <div className="relative flex-1 min-h-0">
      <div className="absolute inset-0 overflow-y-auto" data-testid="shell-content" {...(settingsShown ? INERT : {})}>
        {children}
      </div>
      <SettingsLayer app={app} />
    </div>
  );
}
