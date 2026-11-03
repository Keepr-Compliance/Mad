/**
 * The Dashboard's small row — BACKLOG-3965 PR-4b.
 *
 * Clients & Contacts, plus the Sync iPhone / Sync Android card when the user's
 * import source needs one. Moved out of Dashboard.tsx unchanged.
 *
 * ASSUMPTION (OPEN QUESTION 35835347, unanswered): Clients & Contacts keeps
 * today's place in this small row (option 1, BACKLOG-3614's measurement). The
 * card is its own component, `ClientsContactsCard`, so moving it to a third
 * top card (option 2) is a one-line move.
 */
import React from "react";
import { DashboardActionCard } from "./DashboardActionCard";

function TileIcon({ d }: { d: string }) {
  return (
    <svg className="w-full h-full" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={d} />
    </svg>
  );
}
const PeopleIcon = () => (
  <TileIcon d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
);
const PhoneIcon = () => (
  <TileIcon d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
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
      dataTour="contacts-card"
      dataTestId="nav-clients-contacts"
    />
  );
}

export interface DashboardSecondaryRowProps {
  onManageContacts: () => void;
  onSyncPhone?: () => void;
  onSyncAndroid?: () => void;
  disabled: boolean;
}

export function DashboardSecondaryRow({
  onManageContacts,
  onSyncPhone,
  onSyncAndroid,
  disabled,
}: DashboardSecondaryRowProps): React.ReactElement {
  return (
    <div className={`mt-4 grid gap-3 ${onSyncPhone || onSyncAndroid ? "sm:grid-cols-2" : "grid-cols-1"}`}>
      <ClientsContactsCard onClick={onManageContacts} disabled={disabled} />

      {/* Sync iPhone Card (Windows + iPhone users only) */}
      {onSyncPhone && (
        <DashboardActionCard
          variant="secondary"
          title="Sync iPhone Messages"
          description="Import texts via USB cable"
          onClick={onSyncPhone}
          disabled={disabled}
          icon={<PhoneIcon />}
          dataTour="sync-phone-card"
        />
      )}

      {/* Sync Android Card (Android companion users only) — BACKLOG-2320.
          Mirrors the iPhone sync card; opens the guided Android wizard. */}
      {onSyncAndroid && (
        <DashboardActionCard
          variant="secondary"
          title="Sync Android Messages"
          description="Copy texts from Google Messages"
          onClick={onSyncAndroid}
          disabled={disabled}
          icon={<PhoneIcon />}
          dataTestId="sync-android-card"
        />
      )}
    </div>
  );
}

export default DashboardSecondaryRow;
