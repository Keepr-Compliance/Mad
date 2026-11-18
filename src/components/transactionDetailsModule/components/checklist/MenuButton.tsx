/**
 * One entry of a checklist row's ⋯ menu — BACKLOG-3966 U1 (moved out of MyItemsSection.tsx by BACKLOG-4263 PR-6 so
 * the template rows' Keepr Cloud menu uses the same button).
 */
import React from "react";

export function MenuButton({
  children,
  onClick,
  disabled,
  danger,
  testId,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  testId: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-1.5 text-left text-sm hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed ${
        danger ? "text-red-600" : "text-gray-700"
      }`}
      data-testid={testId}
    >
      {children}
    </button>
  );
}
