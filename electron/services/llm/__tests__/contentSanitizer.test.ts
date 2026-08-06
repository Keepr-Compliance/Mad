/**
 * @jest-environment node
 */

import { ContentSanitizer, contentSanitizer } from '../contentSanitizer';

describe('ContentSanitizer', () => {
  let sanitizer: ContentSanitizer;

  beforeEach(() => {
    sanitizer = new ContentSanitizer();
  });

  describe('email masking', () => {
    it('should mask email addresses', () => {
      const result = sanitizer.sanitize('Contact john.doe@example.com for details');
      expect(result.sanitizedContent).toContain('[EMAIL:j***@e***.com]');
      expect(result.maskedItems).toHaveLength(1);
      expect(result.maskedItems[0].type).toBe('email');
    });

    it('should mask multiple email addresses', () => {
      const result = sanitizer.sanitize('From: a@b.com, To: c@d.org');
      expect(result.maskedItems.filter((i) => i.type === 'email')).toHaveLength(2);
    });

    it('should handle complex email addresses', () => {
      const result = sanitizer.sanitize('Email: user.name+tag@subdomain.example.co.uk');
      expect(result.maskedItems[0].type).toBe('email');
      expect(result.sanitizedContent).toContain('[EMAIL:');
    });
  });

  describe('phone masking', () => {
    it('should mask phone numbers', () => {
      const result = sanitizer.sanitize('Call me at (555) 555-0112');
      expect(result.sanitizedContent).toContain('[PHONE:***-***-0112]');
    });

    it('should handle various phone formats', () => {
      const formats = [
        '555-555-0112',
        '(555) 555-0112',
        '+1 555 555 0112',
        '555.555.0112',
        '5555550112',
      ];

      for (const phone of formats) {
        const result = sanitizer.sanitize(`Number: ${phone}`);
        expect(result.maskedItems.length).toBeGreaterThanOrEqual(1);
        // At least one should be phone
        const hasPhone = result.maskedItems.some((i) => i.type === 'phone');
        expect(hasPhone).toBe(true);
      }
    });

    it('should preserve last 4 digits', () => {
      const result = sanitizer.sanitize('Call 555-123-9999');
      expect(result.sanitizedContent).toContain('9999');
    });
  });

  describe('SSN masking', () => {
    it('should mask SSN', () => {
      const result = sanitizer.sanitize('SSN: 123-45-6789');
      expect(result.sanitizedContent).toContain('[SSN:***-**-****]');
      expect(result.maskedItems[0].type).toBe('ssn');
    });

    it('should mask SSN without dashes', () => {
      const result = sanitizer.sanitize('SSN: 123 45 6789');
      expect(result.sanitizedContent).toContain('[SSN:***-**-****]');
    });
  });

  describe('credit card masking', () => {
    it('should mask credit card numbers', () => {
      const result = sanitizer.sanitize('Card: 4111-1111-1111-1234');
      expect(result.sanitizedContent).toContain('[CARD:****-****-****-1234]');
      expect(result.maskedItems[0].type).toBe('credit_card');
    });

    it('should mask credit card with spaces', () => {
      const result = sanitizer.sanitize('Card: 4111 1111 1111 5678');
      expect(result.sanitizedContent).toContain('5678');
    });
  });

  describe('IP address masking', () => {
    it('should mask IP addresses', () => {
      const result = sanitizer.sanitize('Server IP: 192.168.1.100');
      expect(result.sanitizedContent).toContain('[IP:***.***.***.***]');
      expect(result.maskedItems[0].type).toBe('ip_address');
    });
  });

  describe('bank account masking (TASK-1075)', () => {
    it('should mask bank account numbers with context keyword "account"', () => {
      // Use a 12-digit account number that won't conflict with phone pattern
      const result = sanitizer.sanitize('Please wire to account 123456789012');
      expect(result.sanitizedContent).toContain('[ACCOUNT:****9012]');
      expect(result.maskedItems.some((i) => i.type === 'bank_account')).toBe(true);
    });

    it('should mask bank account with various keyword formats', () => {
      // Use realistic formats that match the pattern
      const formats = [
        'Account: 12345678', // 8 digits
        'acct #12345678901', // 11 digits
        'Account Number: 12345678901234', // 14 digits
        'account no 1234567890123', // 13 digits
        'routing: 123456789', // 9 digits (standard routing number)
        'ABA: 123456789', // 9 digits (ABA routing number)
      ];

      for (const format of formats) {
        const result = sanitizer.sanitize(format);
        expect(result.maskedItems.some((i) => i.type === 'bank_account')).toBe(true);
      }
    });

    it('should NOT mask standalone numbers that could be IDs', () => {
      // Without context keywords, should not mask
      const result = sanitizer.sanitize('Transaction ID: 123456789012');
      expect(result.maskedItems.some((i) => i.type === 'bank_account')).toBe(false);
    });

    it('should NOT mask timestamps', () => {
      const result = sanitizer.sanitize('Created at: 1704067200000');
      expect(result.maskedItems.some((i) => i.type === 'bank_account')).toBe(false);
    });

    it('should preserve last 4 digits of bank account', () => {
      // Use a 14-digit account number
      const result = sanitizer.sanitize('Account: 12345678901234');
      expect(result.sanitizedContent).toContain('[ACCOUNT:****1234]');
    });
  });

  describe('combined PII scenarios (TASK-1075)', () => {
    it('should mask email in signature block', () => {
      const content = `
        Best regards,
        John Smith
        john.smith@company.com
        555-555-0112
      `;
      const result = sanitizer.sanitize(content);
      expect(result.sanitizedContent).toContain('[EMAIL:');
      expect(result.sanitizedContent).toContain('[PHONE:');
      expect(result.maskedItems.filter((i) => i.type === 'email')).toHaveLength(1);
      expect(result.maskedItems.filter((i) => i.type === 'phone')).toHaveLength(1);
    });

    it('should mask phone in address context', () => {
      const content = 'Property at 123 Main Street. Contact owner at 555-555-0121.';
      const result = sanitizer.sanitize(content);
      // Preserve property address
      expect(result.sanitizedContent).toContain('123 Main Street');
      // Mask phone
      expect(result.sanitizedContent).toContain('[PHONE:');
    });

    it('should mask multiple PII types in single email body', () => {
      const content = `
        Dear Client,

        Please wire the closing funds to account 123456789012345.
        Our routing number is routing: 123456789.

        Contact: John Doe
        Email: john@escrow.com
        Phone: (555) 555-0104

        SSN for tax purposes: 123-45-6789

        Property: 456 Oak Avenue - $500,000 listing
      `;
      const result = sanitizer.sanitize(content);

      // Should mask bank accounts (with context) - account (15 digits) and routing (9 digits)
      expect(result.maskedItems.filter((i) => i.type === 'bank_account').length).toBeGreaterThanOrEqual(2);
      // Should mask email
      expect(result.maskedItems.filter((i) => i.type === 'email')).toHaveLength(1);
      // Should mask phone
      expect(result.maskedItems.filter((i) => i.type === 'phone')).toHaveLength(1);
      // Should mask SSN
      expect(result.maskedItems.filter((i) => i.type === 'ssn')).toHaveLength(1);
      // Should preserve property address and price
      expect(result.sanitizedContent).toContain('456 Oak Avenue');
      expect(result.sanitizedContent).toContain('$500,000');
    });

    it('should handle real estate email with all PII types', () => {
      const content = `
        RE: 789 Sunset Drive - Closing Documents

        Please find attached the closing documents for your review.

        Wire Instructions:
        Bank: First National
        Account: 98765432101234
        Routing: 123456789

        Buyer: Jane Buyer (jane.buyer@email.com)
        SSN: 987-65-4321
        Phone: 555-444-3333

        Closing Amount: $750,000
        MLS #24681357
      `;
      const result = sanitizer.sanitize(content);

      // Verify PII is masked
      expect(result.sanitizedContent).toContain('[EMAIL:');
      expect(result.sanitizedContent).toContain('[PHONE:');
      expect(result.sanitizedContent).toContain('[SSN:');
      expect(result.sanitizedContent).toContain('[ACCOUNT:');

      // Verify real estate data is preserved
      expect(result.sanitizedContent).toContain('789 Sunset Drive');
      expect(result.sanitizedContent).toContain('$750,000');
      expect(result.sanitizedContent).toContain('MLS #24681357');
    });
  });

  describe('preservation', () => {
    it('should preserve property addresses', () => {
      const content = 'Property at 123 Main Street is listed at $450,000';
      const result = sanitizer.sanitize(content);
      expect(result.sanitizedContent).toContain('123 Main Street');
      expect(result.sanitizedContent).toContain('$450,000');
    });

    it('should preserve various street types', () => {
      const addresses = [
        '456 Oak Avenue',
        '789 Park Road',
        '101 Sunset Drive',
        '202 Maple Lane',
        '303 Cedar Court',
        '404 Pine Boulevard',
      ];

      for (const addr of addresses) {
        const result = sanitizer.sanitize(`Located at ${addr}`);
        expect(result.sanitizedContent).toContain(addr);
      }
    });

    it('should preserve MLS numbers', () => {
      const result = sanitizer.sanitize('MLS #12345678');
      expect(result.sanitizedContent).toContain('MLS #12345678');
    });

    it('should preserve transaction amounts', () => {
      const result = sanitizer.sanitize('Sale price: $1,250,000.00');
      expect(result.sanitizedContent).toContain('$1,250,000.00');
    });
  });

  describe('sanitizeEmail', () => {
    it('should sanitize all email parts', () => {
      const result = sanitizer.sanitizeEmail({
        subject: 'Call 555-555-0112',
        body: 'Email me at john@example.com',
        from: 'sender@email.com',
        to: ['recipient@email.com'],
      });

      expect(result.subject).toContain('[PHONE:');
      expect(result.body).toContain('[EMAIL:');
      expect(result.from).toContain('[EMAIL:');
      expect(result.to[0]).toContain('[EMAIL:');
    });

    it('should handle cc field', () => {
      const result = sanitizer.sanitizeEmail({
        subject: 'Test',
        body: 'Body',
        from: 'a@b.com',
        to: ['c@d.com'],
        cc: ['e@f.com', 'g@h.com'],
      });

      expect(result.cc).toHaveLength(2);
      expect(result.cc[0]).toContain('[EMAIL:');
      expect(result.cc[1]).toContain('[EMAIL:');
    });

    it('should collect all masked items', () => {
      const result = sanitizer.sanitizeEmail({
        subject: 'Contact john@test.com',
        body: 'Call 555-555-0112 or email jane@test.com',
        from: 'sender@test.com',
        to: ['recipient@test.com'],
      });

      expect(result.maskedItems.length).toBeGreaterThan(3);
    });
  });

  describe('containsPII', () => {
    it('should detect PII without modifying', () => {
      const content = 'SSN: 123-45-6789, Email: test@example.com';
      const result = sanitizer.containsPII(content);

      expect(result.hasPII).toBe(true);
      expect(result.types).toContain('ssn');
      expect(result.types).toContain('email');
    });

    it('should return false for clean content', () => {
      const result = sanitizer.containsPII('Property at 123 Main Street for $500,000');
      expect(result.hasPII).toBe(false);
    });

    it('should detect multiple PII types', () => {
      const content = 'Email: a@b.com, Phone: 555-555-0112, Card: 4111-1111-1111-1111';
      const result = sanitizer.containsPII(content);

      expect(result.hasPII).toBe(true);
      expect(result.types).toContain('email');
      expect(result.types).toContain('phone');
      expect(result.types).toContain('credit_card');
    });
  });

  describe('getStats', () => {
    it('should return correct statistics', () => {
      const result = sanitizer.sanitize(
        'Email: a@b.com, Phone: 555-555-0112, SSN: 123-45-6789'
      );
      const stats = sanitizer.getStats(result);

      expect(stats.itemsMasked).toBe(3);
      expect(stats.byType.email).toBe(1);
      expect(stats.byType.phone).toBe(1);
      expect(stats.byType.ssn).toBe(1);
    });

    it('should calculate reduction percent', () => {
      const result = sanitizer.sanitize('Email: verylongemail@verylongdomain.com');
      const stats = sanitizer.getStats(result);

      // Masked version should be different length
      expect(typeof stats.reductionPercent).toBe('number');
    });
  });

  describe('edge cases', () => {
    it('should handle empty content', () => {
      const result = sanitizer.sanitize('');
      expect(result.sanitizedContent).toBe('');
      expect(result.maskedItems).toHaveLength(0);
      expect(result.originalLength).toBe(0);
    });

    it('should handle content with no PII', () => {
      const content = 'This is a regular message with no sensitive data.';
      const result = sanitizer.sanitize(content);
      expect(result.sanitizedContent).toBe(content);
      expect(result.maskedItems).toHaveLength(0);
    });

    it('should handle very long content', () => {
      const content = 'Email: test@test.com '.repeat(1000);
      const result = sanitizer.sanitize(content);
      expect(result.maskedItems.length).toBe(1000);
    });

    it('should handle mixed PII and preserved content', () => {
      const content =
        'Property at 123 Main Street ($500,000) - Contact agent@realty.com or call 555-555-0112';
      const result = sanitizer.sanitize(content);

      // Should preserve address and price
      expect(result.sanitizedContent).toContain('123 Main Street');
      expect(result.sanitizedContent).toContain('$500,000');

      // Should mask email and phone
      expect(result.sanitizedContent).toContain('[EMAIL:');
      expect(result.sanitizedContent).toContain('[PHONE:');
    });
  });

  describe('singleton export', () => {
    it('should export a working singleton', () => {
      const result = contentSanitizer.sanitize('Test email: test@example.com');
      expect(result.maskedItems).toHaveLength(1);
    });
  });
});
