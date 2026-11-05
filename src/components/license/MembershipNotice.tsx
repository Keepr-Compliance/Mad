/**
 * BACKLOG-3951 PR-B2 — dismissible notice for a member removed from a brokerage.
 *
 * Shown only when the membership standing (PR-B1, via LicenseContext) is
 * "left_brokerage" for the current user and the brokerage name is known, and
 * this user has not dismissed it for that brokerage. Loading, read failed,
 * unassigned, solo or licensed: nothing.
 *
 * Copy is the founder's text verbatim (two sentences): the first is the
 * banner title, the second its description.
 */
import React from "react";
import { AlertBanner, AlertIcons } from "../common/AlertBanner";
import { useLicense } from "../../contexts/LicenseContext";
import { useMembershipNoticeDismissal } from "../../hooks/useMembershipNoticeDismissal";

export const MEMBERSHIP_NOTICE_BODY =
  "You can keep using Keepr on your own and unlock transactions with a monthly subscription or credits.";

export function membershipNoticeTitle(brokerageName: string): string {
  return `You're no longer part of ${brokerageName}.`;
}

interface MembershipNoticeProps {
  userId?: string;
}

export function MembershipNotice({ userId }: MembershipNoticeProps): React.ReactElement | null {
  const { membershipStanding, membershipOrgName } = useLicense();
  const removed = membershipStanding === "left_brokerage" && !!membershipOrgName;
  const { dismissed, dismiss } = useMembershipNoticeDismissal(
    removed ? userId : undefined,
    removed ? membershipOrgName : undefined,
  );

  if (!removed || !membershipOrgName || dismissed !== false) return null;

  return (
    <AlertBanner
      icon={AlertIcons.warning}
      title={membershipNoticeTitle(membershipOrgName)}
      description={MEMBERSHIP_NOTICE_BODY}
      dismissible
      onDismiss={dismiss}
      testId="membership-notice"
    />
  );
}

export default MembershipNotice;
