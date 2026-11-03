/**
 * The Clients & Contacts tile — BACKLOG-3965 PR-4b; in the Dashboard's action
 * row next to New Transaction since BACKLOG-4115. Moved out of the deleted
 * DashboardSecondaryRow (the sync tiles became the title-bar pill).
 */
import React from "react";
import { DashboardActionCard } from "./DashboardActionCard";

const PeopleIcon = () => (
  <svg className="w-full h-full" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
    />
  </svg>
);

export function ClientsContactsCard({
  onClick,
  disabled,
  variant = "secondary",
}: {
  onClick: () => void;
  disabled: boolean;
  variant?: "primary" | "secondary";
}): React.ReactElement {
  return (
    <DashboardActionCard
      variant={variant}
      title="Clients & Contacts"
      onClick={onClick}
      disabled={disabled}
      icon={<PeopleIcon />}
      chipTone="primary"
      dataTour="contacts-card"
      dataTestId="nav-clients-contacts"
    />
  );
}

export default ClientsContactsCard;
