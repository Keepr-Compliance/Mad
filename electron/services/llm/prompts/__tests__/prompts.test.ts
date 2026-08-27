/**
 * Prompt Template Tests
 * TASK-318: Tests for prompt templates with snapshot testing
 *
 * Tests verify:
 * - System prompt stability (snapshot tests)
 * - User prompt template substitution
 * - Hash stability (same content = same hash)
 * - Version format validation
 * - Metadata correctness
 */

import {
  computePromptHash,
  messageAnalysisPrompt,
  messageAnalysisMetadata,
  contactRolesPrompt,
  contactRolesMetadata,
  transactionClusteringPrompt,
  transactionClusteringMetadata,
  ALL_PROMPTS,
} from '../index';
import { AnalyzeMessageInput, ExtractContactRolesInput, ClusterTransactionsInput, MessageAnalysis } from '../../tools/types';

// ============================================================================
// Hash Computation Tests
// ============================================================================

describe('computePromptHash', () => {
  it('should return consistent hash for same content', () => {
    const hash1 = computePromptHash('system prompt', 'user template');
    const hash2 = computePromptHash('system prompt', 'user template');
    expect(hash1).toBe(hash2);
  });

  it('should return different hash for different content', () => {
    const hash1 = computePromptHash('system prompt A', 'user template');
    const hash2 = computePromptHash('system prompt B', 'user template');
    expect(hash1).not.toBe(hash2);
  });

  it('should return 8-character hex string', () => {
    const hash = computePromptHash('test', 'content');
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('should handle empty strings', () => {
    const hash = computePromptHash('', '');
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
    expect(hash).toBe('00000000');
  });

  it('should handle unicode content', () => {
    const hash = computePromptHash('Hello', 'Real estate');
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });
});

// ============================================================================
// Message Analysis Prompt Tests
// ============================================================================

describe('messageAnalysisPrompt', () => {
  describe('metadata', () => {
    it('should have correct name', () => {
      expect(messageAnalysisPrompt.name).toBe('message-analysis');
    });

    it('should have valid semver version', () => {
      expect(messageAnalysisPrompt.version).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('should have valid hash', () => {
      expect(messageAnalysisPrompt.hash).toMatch(/^[0-9a-f]{8}$/);
    });
  });

  describe('buildSystemPrompt', () => {
    it('should return system prompt string', () => {
      const prompt = messageAnalysisPrompt.buildSystemPrompt();
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(100);
    });

    it('should include JSON schema instructions', () => {
      const prompt = messageAnalysisPrompt.buildSystemPrompt();
      expect(prompt).toContain('isRealEstateRelated');
      expect(prompt).toContain('confidence');
      expect(prompt).toContain('transactionIndicators');
      expect(prompt).toContain('extractedEntities');
    });

    it('should match snapshot', () => {
      const prompt = messageAnalysisPrompt.buildSystemPrompt();
      expect(prompt).toMatchSnapshot();
    });
  });

  describe('buildUserPrompt', () => {
    const sampleInput: AnalyzeMessageInput = {
      sender: 'john@example.com',
      recipients: ['jane@example.com', 'bob@example.com'],
      date: '2024-12-18T10:00:00Z',
      subject: 'Offer on 123 Main St',
      body: 'I am writing to submit an offer...',
    };

    it('should substitute all placeholders', () => {
      const prompt = messageAnalysisPrompt.buildUserPrompt(sampleInput);
      expect(prompt).toContain('john@example.com');
      expect(prompt).toContain('jane@example.com, bob@example.com');
      expect(prompt).toContain('2024-12-18T10:00:00Z');
      expect(prompt).toContain('Offer on 123 Main St');
      expect(prompt).toContain('I am writing to submit an offer...');
    });

    it('should not contain unsubstituted placeholders', () => {
      const prompt = messageAnalysisPrompt.buildUserPrompt(sampleInput);
      expect(prompt).not.toContain('{{');
      expect(prompt).not.toContain('}}');
    });

    it('should match snapshot with sample input', () => {
      const prompt = messageAnalysisPrompt.buildUserPrompt(sampleInput);
      expect(prompt).toMatchSnapshot();
    });
  });
});

describe('messageAnalysisMetadata', () => {
  it('should match prompt template values', () => {
    expect(messageAnalysisMetadata.name).toBe(messageAnalysisPrompt.name);
    expect(messageAnalysisMetadata.version).toBe(messageAnalysisPrompt.version);
    expect(messageAnalysisMetadata.hash).toBe(messageAnalysisPrompt.hash);
  });

  it('should have valid createdAt date', () => {
    expect(messageAnalysisMetadata.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('should have non-empty description', () => {
    expect(messageAnalysisMetadata.description.length).toBeGreaterThan(10);
  });
});

// ============================================================================
// Contact Roles Prompt Tests
// ============================================================================

describe('contactRolesPrompt', () => {
  describe('metadata', () => {
    it('should have correct name', () => {
      expect(contactRolesPrompt.name).toBe('contact-roles');
    });

    it('should have valid semver version', () => {
      expect(contactRolesPrompt.version).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('should have valid hash', () => {
      expect(contactRolesPrompt.hash).toMatch(/^[0-9a-f]{8}$/);
    });
  });

  describe('buildSystemPrompt', () => {
    it('should return system prompt string', () => {
      const prompt = contactRolesPrompt.buildSystemPrompt();
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(100);
    });

    it('should include role definitions', () => {
      const prompt = contactRolesPrompt.buildSystemPrompt();
      expect(prompt).toContain('buyer');
      expect(prompt).toContain('seller');
      // BACKLOG-2859: ONE side-neutral agent role. The prompt must NOT teach the
      // model the retired side-specific vocabulary — this enum is a write path,
      // and proposals become stored roles when a user accepts a suggestion.
      expect(prompt).toContain('agent');
      expect(prompt).not.toContain('buyer_agent');
      expect(prompt).not.toContain('seller_agent');
      expect(prompt).toContain('escrow');
    });

    it('should match snapshot', () => {
      const prompt = contactRolesPrompt.buildSystemPrompt();
      expect(prompt).toMatchSnapshot();
    });
  });

  describe('buildUserPrompt', () => {
    const sampleInput: ExtractContactRolesInput = {
      communications: [
        {
          sender: 'agent@realty.com',
          recipients: ['buyer@example.com'],
          date: '2024-12-18T10:00:00Z',
          subject: 'Your Offer Has Been Accepted',
          body: 'Great news! The seller has accepted your offer on 123 Main St.',
        },
      ],
      knownContacts: [
        { name: 'John Buyer', email: 'buyer@example.com' },
      ],
      propertyAddress: '123 Main St, Anytown, USA',
    };

    it('should include property address when provided', () => {
      const prompt = contactRolesPrompt.buildUserPrompt(sampleInput);
      expect(prompt).toContain('Property: 123 Main St, Anytown, USA');
    });

    it('should include known contacts when provided', () => {
      const prompt = contactRolesPrompt.buildUserPrompt(sampleInput);
      expect(prompt).toContain('Known contacts');
      expect(prompt).toContain('John Buyer');
      expect(prompt).toContain('buyer@example.com');
    });

    it('should format communications correctly', () => {
      const prompt = contactRolesPrompt.buildUserPrompt(sampleInput);
      expect(prompt).toContain('--- Email 1 ---');
      expect(prompt).toContain('From: agent@realty.com');
      expect(prompt).toContain('Your Offer Has Been Accepted');
    });

    it('should match snapshot with sample input', () => {
      const prompt = contactRolesPrompt.buildUserPrompt(sampleInput);
      expect(prompt).toMatchSnapshot();
    });

    it('should handle empty known contacts', () => {
      const inputNoContacts: ExtractContactRolesInput = {
        communications: sampleInput.communications,
      };
      const prompt = contactRolesPrompt.buildUserPrompt(inputNoContacts);
      expect(prompt).not.toContain('Known contacts');
    });
  });
});

describe('contactRolesMetadata', () => {
  it('should match prompt template values', () => {
    expect(contactRolesMetadata.name).toBe(contactRolesPrompt.name);
    expect(contactRolesMetadata.version).toBe(contactRolesPrompt.version);
    expect(contactRolesMetadata.hash).toBe(contactRolesPrompt.hash);
  });

  it('should have valid createdAt date', () => {
    expect(contactRolesMetadata.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('should have non-empty description', () => {
    expect(contactRolesMetadata.description.length).toBeGreaterThan(10);
  });
});

// ============================================================================
// Transaction Clustering Prompt Tests
// ============================================================================

describe('transactionClusteringPrompt', () => {
  describe('metadata', () => {
    it('should have correct name', () => {
      expect(transactionClusteringPrompt.name).toBe('transaction-clustering');
    });

    it('should have valid semver version', () => {
      expect(transactionClusteringPrompt.version).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('should have valid hash', () => {
      expect(transactionClusteringPrompt.hash).toMatch(/^[0-9a-f]{8}$/);
    });
  });

  describe('buildSystemPrompt', () => {
    it('should return system prompt string', () => {
      const prompt = transactionClusteringPrompt.buildSystemPrompt();
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(100);
    });

    it('should include clustering rules', () => {
      const prompt = transactionClusteringPrompt.buildSystemPrompt();
      expect(prompt).toContain('property address');
      expect(prompt).toContain('clusters');
      expect(prompt).toContain('unclustered');
    });

    it('should match snapshot', () => {
      const prompt = transactionClusteringPrompt.buildSystemPrompt();
      expect(prompt).toMatchSnapshot();
    });
  });

  describe('buildUserPrompt', () => {
    const sampleAnalysis: MessageAnalysis = {
      isRealEstateRelated: true,
      confidence: 0.95,
      transactionIndicators: {
        type: 'purchase',
        stage: 'pending',
      },
      extractedEntities: {
        addresses: [{ value: '123 Main St', confidence: 0.9 }],
        amounts: [],
        dates: [],
        contacts: [],
      },
      reasoning: 'Email contains property address and offer details.',
    };

    const sampleInput: ClusterTransactionsInput = {
      analyzedMessages: [
        {
          id: 'msg-001',
          subject: 'Offer on 123 Main St',
          sender: 'agent@realty.com',
          recipients: ['buyer@example.com'],
          date: '2024-12-18T10:00:00Z',
          analysis: sampleAnalysis,
        },
      ],
      existingTransactions: [
        {
          id: 'txn-001',
          propertyAddress: '456 Oak Ave',
          transactionType: 'sale',
        },
      ],
    };

    it('should include existing transactions when provided', () => {
      const prompt = transactionClusteringPrompt.buildUserPrompt(sampleInput);
      expect(prompt).toContain('Existing transactions');
      expect(prompt).toContain('456 Oak Ave');
    });

    it('should format analyzed messages correctly', () => {
      const prompt = transactionClusteringPrompt.buildUserPrompt(sampleInput);
      expect(prompt).toContain('Message 1 (ID: msg-001)');
      expect(prompt).toContain('Subject: Offer on 123 Main St');
      expect(prompt).toContain('Is RE: true');
      expect(prompt).toContain('Addresses: 123 Main St');
    });

    it('should match snapshot with sample input', () => {
      const prompt = transactionClusteringPrompt.buildUserPrompt(sampleInput);
      expect(prompt).toMatchSnapshot();
    });

    it('should handle messages without addresses', () => {
      const inputNoAddresses: ClusterTransactionsInput = {
        analyzedMessages: [
          {
            id: 'msg-002',
            subject: 'General Inquiry',
            sender: 'user@example.com',
            recipients: ['agent@realty.com'],
            date: '2024-12-18T11:00:00Z',
            analysis: {
              ...sampleAnalysis,
              extractedEntities: {
                ...sampleAnalysis.extractedEntities,
                addresses: [],
              },
            },
          },
        ],
      };
      const prompt = transactionClusteringPrompt.buildUserPrompt(inputNoAddresses);
      expect(prompt).not.toContain('Addresses:');
    });
  });
});

describe('transactionClusteringMetadata', () => {
  it('should match prompt template values', () => {
    expect(transactionClusteringMetadata.name).toBe(transactionClusteringPrompt.name);
    expect(transactionClusteringMetadata.version).toBe(transactionClusteringPrompt.version);
    expect(transactionClusteringMetadata.hash).toBe(transactionClusteringPrompt.hash);
  });

  it('should have valid createdAt date', () => {
    expect(transactionClusteringMetadata.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('should have non-empty description', () => {
    expect(transactionClusteringMetadata.description.length).toBeGreaterThan(10);
  });
});

// ============================================================================
// ALL_PROMPTS Catalog Tests
// ============================================================================

describe('ALL_PROMPTS', () => {
  it('should contain all three prompts', () => {
    expect(ALL_PROMPTS).toHaveLength(3);
  });

  it('should include message analysis prompt', () => {
    const prompt = ALL_PROMPTS.find(p => p.name === 'message-analysis');
    expect(prompt).toBeDefined();
    expect(prompt?.version).toBe('1.0.0');
  });

  it('should include contact roles prompt', () => {
    const prompt = ALL_PROMPTS.find(p => p.name === 'contact-roles');
    expect(prompt).toBeDefined();
    expect(prompt?.version).toBe('1.0.0');
  });

  it('should include transaction clustering prompt', () => {
    const prompt = ALL_PROMPTS.find(p => p.name === 'transaction-clustering');
    expect(prompt).toBeDefined();
    expect(prompt?.version).toBe('1.0.0');
  });

  it('should have unique names', () => {
    const names = ALL_PROMPTS.map(p => p.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  it('should have unique hashes', () => {
    const hashes = ALL_PROMPTS.map(p => p.hash);
    const uniqueHashes = new Set(hashes);
    expect(uniqueHashes.size).toBe(hashes.length);
  });
});

// ============================================================================
// Hash Stability Tests
// ============================================================================

describe('Hash Stability', () => {
  it('should have stable message analysis hash', () => {
    // This ensures prompts are not accidentally modified
    expect(messageAnalysisPrompt.hash).toMatchSnapshot();
  });

  it('should have stable contact roles hash', () => {
    expect(contactRolesPrompt.hash).toMatchSnapshot();
  });

  it('should have stable transaction clustering hash', () => {
    expect(transactionClusteringPrompt.hash).toMatchSnapshot();
  });
});
