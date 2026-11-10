/**
 * Sender rules — the (i) tip for each header of the rules card (BACKLOG-4186), written from the
 * agent's side: what they will or won't see in Keepr. Pure: no React.
 *
 * Each text is derived from the desktop code that reads the setting; the citations are on the
 * BACKLOG-4186 tracker row that added them.
 */

export const TIPS = {
  card:
    'These rules leave mail out of three places in Keepr (the columns below), going by the sender, mailing-list headers and Gmail tabs, never by what the mail says. A rule has an effect only where it is Live.',
  hide:
    'Mail matching these lists can be hidden. Addresses always win; the others never hide mail from deal contacts, their company domains, or Always keep senders.',
  'suppress.exactAddresses':
    'Mail from these exact addresses is hidden wherever Addresses is Live. It is hidden even when the sender is a deal contact or under Always keep.',
  'suppress.hosts':
    'Mail from these domains and their subdomains is hidden wherever Domains is Live. Mail from deal contacts, their company domains and Always keep still shows.',
  'suppress.localParts':
    'Mail is hidden wherever Sender names is Live when the part before the @ matches an entry, exactly or as a prefix, as each entry is set. Deal contacts and Always keep still show.',
  bulkHeaders:
    'Mail that carries a checked header, as newsletters and mailing lists do, counts as bulk and is hidden wherever Bulk headers is Live. Mail from the agent’s deal contacts and senders under Always keep still shows.',
  'suppress.bulkHeaders.precedenceValues':
    'Mail whose Precedence header is one of these words also counts as bulk. It is hidden only where Bulk headers is Live.',
  keep:
    'Mail from these senders is never hidden by Domains, Sender names, Bulk headers or the Gmail tabs. Only an exact address under Hide mail from, where Addresses is Live, still hides it.',
  'keep.platformHosts':
    'Mail from these deal-platform domains and their subdomains is always kept. Only an exact address under Hide mail from, where Addresses is Live, overrides this.',
  'keep.platformAddresses':
    'Mail from these exact addresses is always kept. Only an exact address under Hide mail from, where Addresses is Live, overrides this.',
  freeMailDomains:
    'Mail from a deal contact\'s domain is kept unless the domain is listed here. List public mail services so one Gmail contact does not keep all of Gmail.',
  modes:
    'Off: not checked. Measure: counted only, nothing changes for the agent. Live: the mail is left out of that place.',
  rule:
    'Each row is one of the rules above, plus the Gmail tabs, which apply to Gmail mail only. Gmail Updates can be measured but never set to Live.',
  learnQuestions:
    'Learn mode\'s questions about possible deals. Mail a Live rule hides is left out of those questions, and a deal whose every email is hidden is not asked.',
  addressPass:
    'Keepr suggests emails that name a deal\'s street address but involve no one on the deal. Mail hidden by a Live rule is not suggested; emails already on a deal stay.',
  detector:
    'The scan that finds new deals, for agents with auto-detect on. Mail hidden by a Live rule is not used to find deals.',
  thresholds:
    'Numbers for our own sender-filter checks. None of them changes what the agent sees.',
  minCensusLinkedEmails:
    'A mailbox needs at least this many deal-linked emails before the Learn mode score can call deal detection ready. Changes nothing the agent sees.',
  reportSendIntervalHours: 'Not used yet. Planned for a domain report.',
  reportMaxRows: 'Not used yet. Planned for a domain report.',
} as const;

export type TipKey = keyof typeof TIPS;
