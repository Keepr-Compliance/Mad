/**
 * Sender rules — the (i) tip for each header of the rules card (BACKLOG-4186), written from the
 * agent's side: what they will or won't see in Keepr. Pure: no React.
 *
 * Each text is derived from the desktop code that reads the setting; the citations are on the
 * BACKLOG-4186 tracker row that added them.
 */

export const TIPS = {
  card:
    'These rules decide which mail Keepr hides from an agent, going by the sender, mailing-list headers and Gmail tabs, never by what the mail says. A rule changes what the agent sees only where it is set to Live below.',
  hide:
    'Mail from senders on these lists can be hidden from the agent. Addresses always win; the other lists never hide mail from the agent’s deal contacts, their company domains, or senders under Always keep.',
  'suppress.exactAddresses':
    'Mail from these exact addresses is hidden wherever Addresses is Live. It is hidden even when the sender is a deal contact or under Always keep.',
  'suppress.hosts':
    'Mail from these domains and their subdomains is hidden wherever Domains is Live. Mail from the agent’s deal contacts and senders under Always keep still shows.',
  'suppress.localParts':
    'Mail is hidden wherever Sender names is Live when the part of the address before the @ matches a name here, exactly or by how it starts. Mail from the agent’s deal contacts and senders under Always keep still shows.',
  bulkHeaders:
    'Mail that carries a checked header, as newsletters and mailing lists do, counts as bulk and is hidden wherever Bulk headers is Live. Mail from the agent’s deal contacts and senders under Always keep still shows.',
  'suppress.bulkHeaders.precedenceValues':
    'Mail whose Precedence header is one of these words also counts as bulk. It is hidden only where Bulk headers is Live.',
  keep:
    'Mail from these senders is never hidden by Domains, Sender names, Bulk headers or the Gmail tabs. An exact address under Hide mail from still hides it.',
  'keep.platformHosts':
    'Mail from these deal-platform domains and their subdomains is always kept. Only an exact address under Hide mail from overrides this.',
  'keep.platformAddresses':
    'Mail from these exact addresses is always kept. Only an exact address under Hide mail from overrides this.',
  freeMailDomains:
    'Keepr keeps all mail from the domain a deal contact writes from, unless that domain is listed here. List public mail services here so one contact on a free-mail domain does not keep every sender on it.',
  modes:
    'Off means not checked; Measure means counted for us, with nothing changing for the agent; Live means the mail is hidden from that place. Each column is a place in Keepr.',
  rule:
    'Each row is one of the rules above, plus the Gmail tabs, which apply to Gmail mail only. Gmail Updates can be measured but never set to Live.',
  learnQuestions:
    'The questions Learn mode asks about possible deals. Mail hidden by a Live rule is left out of what Learn mode shows, and a possible deal whose every email is hidden is not asked about.',
  addressPass:
    'Keepr suggests emails that mention a deal’s address but come from no one on the deal. Mail hidden by a Live rule is not suggested; emails already on a deal are not removed.',
  detector:
    'The scan that finds new deals in the agent’s mail. Mail hidden by a Live rule is not used to find deals.',
  thresholds:
    'Numbers for our own sender-filter checks. None of them changes what the agent sees.',
  minCensusLinkedEmails:
    'How many deal-linked emails a mailbox needs before the Learn mode score copied for us calls deal detection ready. Nothing the agent sees changes.',
  reportSendIntervalHours: 'Not used yet. It is for a planned domain report and changes nothing today.',
  reportMaxRows: 'Not used yet. It is for a planned domain report and changes nothing today.',
} as const;

export type TipKey = keyof typeof TIPS;
