/**
 * Contact Roles Prompt Template
 * TASK-318: Extracted from extractContactRolesTool.ts (TASK-316)
 *
 * Extracts contact roles from communication history.
 */

import { PromptTemplate, PromptMetadata, computePromptHash } from './types';
import { ExtractContactRolesInput } from '../tools/types';

/**
 * System prompt for contact role extraction.
 * Instructs the LLM to identify participant roles from emails.
 */
const SYSTEM_PROMPT = `You are a real estate transaction analyst. Analyze the provided email communications and identify the role of each participant.

IMPORTANT: Return ONLY valid JSON matching this exact schema:
{
  "assignments": [
    {
      "name": string,
      "email": string | null,
      "phone": string | null,
      "role": "buyer" | "seller" | "agent" | "escrow" | "title" | "lender" | "inspector" | "appraiser" | "attorney" | "other",
      "confidence": number (0-1),
      "evidence": [string] (direct quotes from emails supporting this role assignment)
    }
  ],
  "transactionContext": {
    "propertyAddress": string | null,
    "transactionType": "purchase" | "sale" | "lease" | null
  }
}

Role definitions:
- buyer: The person/entity purchasing the property
- seller: The person/entity selling the property
- agent: Any real estate agent representing a party to the deal. Do NOT try to
  say which side they are on — the app derives that from the transaction type
  (BACKLOG-2859). One role covers the buyer's agent and the listing agent alike.
- escrow: Escrow officer or company
- title: Title company representative
- lender: Mortgage lender or loan officer
- inspector: Home inspector
- appraiser: Property appraiser
- attorney: Real estate attorney
- other: Any other transaction participant

Provide evidence by quoting relevant text that indicates each person's role. Keep evidence quotes short and relevant.`;

/**
 * User prompt template - dynamically constructed based on input.
 * Template marker used for hash computation.
 */
const USER_PROMPT_TEMPLATE_MARKER = 'CONTACT_ROLES_USER_PROMPT';

/**
 * Contact roles prompt template.
 * Used by ExtractContactRolesTool to construct LLM messages.
 */
export const contactRolesPrompt: PromptTemplate<ExtractContactRolesInput> = {
  name: 'contact-roles',
  version: '1.0.0',
  hash: computePromptHash(SYSTEM_PROMPT, USER_PROMPT_TEMPLATE_MARKER),

  buildSystemPrompt: () => SYSTEM_PROMPT,

  buildUserPrompt: (input: ExtractContactRolesInput) => {
    let prompt = `Analyze these email communications and identify participant roles:\n\n`;

    if (input.propertyAddress) {
      prompt += `Property: ${input.propertyAddress}\n\n`;
    }

    if (input.knownContacts && input.knownContacts.length > 0) {
      prompt += `Known contacts (match if possible):\n`;
      input.knownContacts.forEach((c) => {
        prompt += `- ${c.name}${c.email ? ` (${c.email})` : ''}${c.phone ? ` ${c.phone}` : ''}\n`;
      });
      prompt += '\n';
    }

    prompt += `Communications:\n\n`;
    input.communications.forEach((comm, i) => {
      prompt += `--- Email ${i + 1} ---\n`;
      prompt += `From: ${comm.sender}\n`;
      prompt += `To: ${comm.recipients.join(', ')}\n`;
      prompt += `Date: ${comm.date}\n`;
      prompt += `Subject: ${comm.subject}\n\n`;
      prompt += `${comm.body}\n\n`;
    });

    return prompt;
  },
};

/**
 * Metadata for the contact roles prompt.
 * Used for cataloging and auditing prompt versions.
 */
export const contactRolesMetadata: PromptMetadata = {
  name: contactRolesPrompt.name,
  version: contactRolesPrompt.version,
  hash: contactRolesPrompt.hash,
  createdAt: '2024-12-18',
  description: 'Extracts contact roles from communication history',
};
