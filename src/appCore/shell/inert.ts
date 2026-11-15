/**
 * The `inert` attribute as a props spread (BACKLOG-3964, BACKLOG-4174).
 *
 * React 18 drops a boolean `inert`; the attribute must be the empty string.
 * Its own module so ShellContent and SettingsLayer can both use it without
 * importing each other.
 */
import type React from "react";

export const INERT = { inert: "" } as unknown as React.HTMLAttributes<HTMLDivElement>;
