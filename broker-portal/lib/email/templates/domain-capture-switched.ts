/**
 * Sent when a domain capture moved the person into the brokerage (BACKLOG-3962 PR3a). People with
 * a personal plan get the BACKLOG-3850 "plan ended" email instead, never this one.
 *
 * Draft copy, for founder review on the preview.
 */

import { buildSimpleNotice } from './simple-notice';
import type { DomainCaptureSwitchedParams, EmailContent } from '../types';

export function buildDomainCaptureSwitchedEmail(params: DomainCaptureSwitchedParams): EmailContent {
  const { recipientEmail, brokerageName, licensed, joinedEarly } = params;
  const subject = `Your Keepr account is now part of ${brokerageName}`;
  return buildSimpleNotice(subject, [
    joinedEarly === true
      ? `Your Keepr account (${recipientEmail}) moved into ${brokerageName} today, as you asked.`
      : `Your Keepr account (${recipientEmail}) moved into ${brokerageName} today, as our earlier notice said.`,
    licensed
      ? `${brokerageName} gave you a Keepr license, so you can keep working as before.`
      : `${brokerageName} has no free license yet. An admin there can assign you one on the Users page.`,
    `${brokerageName} now manages this account and can end your access to it.`,
  ]);
}
