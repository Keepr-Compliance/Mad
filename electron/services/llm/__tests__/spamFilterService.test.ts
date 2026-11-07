import {
  isGmailSpam,
  isOutlookJunk,
  isOutlookNonFocused,
} from '../spamFilterService';

describe('spamFilterService', () => {
  describe('isGmailSpam', () => {
    it('should detect SPAM label', () => {
      const result = isGmailSpam(['INBOX', 'SPAM']);
      expect(result.isSpam).toBe(true);
      expect(result.reason).toContain('SPAM');
    });

    it('should detect TRASH label', () => {
      const result = isGmailSpam(['TRASH']);
      expect(result.isSpam).toBe(true);
      expect(result.reason).toContain('TRASH');
    });

    it('should pass normal emails', () => {
      const result = isGmailSpam(['INBOX', 'IMPORTANT']);
      expect(result.isSpam).toBe(false);
    });

    it('should handle empty labels', () => {
      const result = isGmailSpam([]);
      expect(result.isSpam).toBe(false);
    });

    it('should return labels in result', () => {
      const labels = ['INBOX', 'CATEGORY_PRIMARY'];
      const result = isGmailSpam(labels);
      expect(result.labels).toEqual(labels);
    });
  });

  // TASK-502: Outlook Junk Detection
  describe('isOutlookJunk', () => {
    it('should detect junk folder', () => {
      const result = isOutlookJunk({ parentFolderName: 'Junk Email' });
      expect(result.isSpam).toBe(true);
      expect(result.reason).toContain('Junk Email');
    });

    it('should detect deleted items folder', () => {
      const result = isOutlookJunk({ parentFolderName: 'Deleted Items' });
      expect(result.isSpam).toBe(true);
      expect(result.reason).toContain('Deleted Items');
    });

    it('should detect junkemail folder (lowercase)', () => {
      const result = isOutlookJunk({ parentFolderName: 'junkemail' });
      expect(result.isSpam).toBe(true);
    });

    it('should pass inbox emails', () => {
      const result = isOutlookJunk({ parentFolderName: 'Inbox' });
      expect(result.isSpam).toBe(false);
    });

    it('should pass sent items', () => {
      const result = isOutlookJunk({ parentFolderName: 'Sent Items' });
      expect(result.isSpam).toBe(false);
    });

    it('should pass when no folder name provided', () => {
      const result = isOutlookJunk({});
      expect(result.isSpam).toBe(false);
    });

    it('should NOT filter based on inferenceClassification by default', () => {
      // inferenceClassification is too aggressive - use isOutlookNonFocused for opt-in
      const result = isOutlookJunk({ inferenceClassification: 'other' });
      expect(result.isSpam).toBe(false);
    });
  });

  describe('isOutlookNonFocused', () => {
    it('should detect inferenceClassification: other when opted-in', () => {
      const result = isOutlookNonFocused({ inferenceClassification: 'other' });
      expect(result.isSpam).toBe(true);
      expect(result.reason).toContain('other');
    });

    it('should pass focused emails', () => {
      const result = isOutlookNonFocused({ inferenceClassification: 'focused' });
      expect(result.isSpam).toBe(false);
    });

    it('should pass when no classification provided', () => {
      const result = isOutlookNonFocused({});
      expect(result.isSpam).toBe(false);
    });
  });
});
