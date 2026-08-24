/**
 * Contact Role Extractor Tool
 * TASK-316: Identifies contact roles from communication context
 *
 * Pure-function AI tool that extracts buyer, seller, agent, escrow,
 * inspector, and other real estate transaction participants with
 * confidence scores and evidence.
 */

import { BaseLLMService } from '../baseLLMService';
import { LLMConfig, LLMMessage } from '../types';
import {
  ContactRoleExtraction,
  ExtractContactRolesInput,
  ToolResult,
  ContactRole,
  ContactRoleAssignment,
} from './types';
import { ContentSanitizer } from '../contentSanitizer';
import { contactRolesPrompt } from '../prompts';

/**
 * Retired agent values the model may still produce (BACKLOG-2859). Folded to
 * `agent` rather than rejected — see the fold at the parse site below.
 */
const LEGACY_AGENT_ROLES: string[] = ['buyer_agent', 'seller_agent', 'listing_agent'];

const VALID_ROLES: ContactRole[] = [
  'buyer',
  'seller',
  // BACKLOG-2859: one agent role, no side. See ContactRole in ./types.
  'agent',
  'escrow',
  'title',
  'lender',
  'inspector',
  'appraiser',
  'attorney',
  'other',
];

export class ExtractContactRolesTool {
  private llmService: BaseLLMService;
  private sanitizer: ContentSanitizer;

  constructor(llmService: BaseLLMService) {
    this.llmService = llmService;
    this.sanitizer = new ContentSanitizer();
  }

  /**
   * Extract contact roles from communication history.
   */
  async extract(
    input: ExtractContactRolesInput,
    config: LLMConfig
  ): Promise<ToolResult<ContactRoleExtraction>> {
    const startTime = Date.now();

    try {
      // Handle empty communications
      if (!input.communications || input.communications.length === 0) {
        return {
          success: true,
          data: { assignments: [] },
          latencyMs: Date.now() - startTime,
        };
      }

      // Sanitize all communication content
      const sanitizedComms = input.communications.map((comm) => ({
        ...comm,
        body: this.sanitizer.sanitize(comm.body).sanitizedContent,
        subject: this.sanitizer.sanitize(comm.subject).sanitizedContent,
      }));

      const messages = this.buildPrompt({
        ...input,
        communications: sanitizedComms,
      });

      const response = await this.llmService.completeWithRetry(messages, {
        ...config,
        maxTokens: 2000, // May need more for multiple contacts
      });

      const extraction = this.parseResponse(response.content);

      return {
        success: true,
        data: extraction,
        tokensUsed: response.tokensUsed,
        latencyMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latencyMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Build the LLM prompt for contact role extraction.
   * Uses external prompt template from prompts/contactRoles.ts
   */
  private buildPrompt(input: ExtractContactRolesInput): LLMMessage[] {
    return [
      { role: 'system', content: contactRolesPrompt.buildSystemPrompt() },
      { role: 'user', content: contactRolesPrompt.buildUserPrompt(input) },
    ];
  }

  /**
   * Parse and validate the LLM response.
   */
  private parseResponse(content: string): ContactRoleExtraction {
    // Extract JSON from response
    let jsonStr = content;
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }

    // Try to find JSON object if no code block
    if (!jsonMatch) {
      const objectMatch = content.match(/\{[\s\S]*\}/);
      if (objectMatch) {
        jsonStr = objectMatch[0];
      }
    }

    const parsed = JSON.parse(jsonStr);

    // Validate and normalize assignments
    const assignments: ContactRoleAssignment[] = (parsed.assignments || [])
      .map((a: Record<string, unknown>): ContactRoleAssignment | null => {
        if (!a || typeof a !== 'object') return null;

        const name = String(a.name || '');
        if (!name) return null;

        // Validate role.
        //
        // BACKLOG-2859: legacy side-specific agent values are FOLDED, not
        // rejected. The model still emits `buyer_agent` / `seller_agent` — the
        // vocabulary is decades old in its training data, and a cached or
        // in-flight prompt can carry the old wording regardless of what the
        // prompt file now says. Without this fold they fail the validity check
        // and land on `other`, which is strictly worse than the pre-collapse
        // behaviour: the extractor would stop identifying agents at all, and
        // "other" is unrecoverable — nothing downstream can tell it apart from a
        // genuinely unclassifiable party.
        const rawRole = String(a.role || '').toLowerCase();
        const foldedRole = LEGACY_AGENT_ROLES.includes(rawRole) ? 'agent' : rawRole;
        const role = VALID_ROLES.includes(foldedRole as ContactRole)
          ? (foldedRole as ContactRole)
          : 'other';

        // Ensure confidence is valid
        let confidence = parseFloat(String(a.confidence));
        if (isNaN(confidence) || confidence < 0) confidence = 0;
        if (confidence > 1) confidence = 1;

        return {
          name,
          email: a.email ? String(a.email) : undefined,
          phone: a.phone ? String(a.phone) : undefined,
          role,
          confidence,
          evidence: Array.isArray(a.evidence)
            ? a.evidence.map(String).filter((e: string) => e.length > 0)
            : [],
        };
      })
      .filter((a: ContactRoleAssignment | null): a is ContactRoleAssignment => a !== null);

    // Validate transaction context
    const transactionContext: ContactRoleExtraction['transactionContext'] = {};

    if (parsed.transactionContext?.propertyAddress) {
      transactionContext.propertyAddress = String(parsed.transactionContext.propertyAddress);
    }

    if (parsed.transactionContext?.transactionType) {
      const type = parsed.transactionContext.transactionType;
      if (type === 'purchase' || type === 'sale' || type === 'lease') {
        transactionContext.transactionType = type;
      }
    }

    return {
      assignments,
      transactionContext:
        Object.keys(transactionContext).length > 0 ? transactionContext : undefined,
    };
  }
}
