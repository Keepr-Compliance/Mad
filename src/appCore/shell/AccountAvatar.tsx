/**
 * AccountAvatar — the user's initials (or photo) in a fixed circle
 * (BACKLOG-3964 slice 3).
 *
 * One component for the title-bar initials, the account panel header and,
 * later, the Account tab. The props are the ones a kit Avatar would take
 * (size, name, email, imageUrl), so lifting it into packages/ui is a move.
 *
 * The circle never distorts: fixed width and height, `shrink-0`, square aspect
 * ratio, and an image that covers the box. A long name next to it truncates;
 * the circle keeps its size.
 */
import React from "react";

/**
 * Two letters when the name has two words ("Ann Lee" -> "AL"), else the first
 * letter of the name, else of the email, else "?".
 */
export function getAccountInitials(user: { display_name?: string | null; email?: string | null }): string {
  const words = (user.display_name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return words[0]?.[0]?.toUpperCase() || user.email?.trim()?.[0]?.toUpperCase() || "?";
}

const SIZE_CLASS = {
  32: "h-8 w-8 text-sm",
  40: "h-10 w-10 text-base",
} as const;

export interface AccountAvatarProps {
  /** Diameter in px. */
  size?: keyof typeof SIZE_CLASS;
  name?: string | null;
  email?: string | null;
  imageUrl?: string | null;
  className?: string;
}

export function AccountAvatar({ size = 32, name, email, imageUrl, className = "" }: AccountAvatarProps) {
  return (
    <span
      data-testid="account-avatar"
      className={`inline-flex shrink-0 aspect-square items-center justify-center overflow-hidden rounded-full bg-primary-600 font-medium leading-none text-white ${SIZE_CLASS[size]} ${className}`.trim()}
    >
      {imageUrl ? (
        <img src={imageUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        getAccountInitials({ display_name: name, email })
      )}
    </span>
  );
}
