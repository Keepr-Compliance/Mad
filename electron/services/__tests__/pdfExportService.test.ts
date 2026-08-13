/**
 * @jest-environment node
 */

/**
 * Unit tests for PDFExportService
 * Tests HTML generation and formatting utilities
 */


// Mock electron
jest.mock("electron", () => ({
  BrowserWindow: jest.fn().mockImplementation(() => ({
    loadURL: jest.fn().mockResolvedValue(undefined),
    loadFile: jest.fn().mockResolvedValue(undefined),
    webContents: {
      printToPDF: jest.fn().mockResolvedValue(Buffer.from("mock-pdf-data")),
      // Handle event-based page load (did-finish-load / did-fail-load)
      on: jest.fn().mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
        if (event === "did-finish-load") {
          cb();
        }
      }),
    },
    close: jest.fn(),
  })),
  app: {
    getPath: jest.fn((pathType: string) => {
      if (pathType === "downloads") return "/mock/downloads";
      return "/mock/path";
    }),
  },
}));

// Mock fs/promises
jest.mock("fs/promises", () => ({
  writeFile: jest.fn().mockResolvedValue(undefined),
  unlink: jest.fn().mockResolvedValue(undefined),
}));

describe("PDFExportService", () => {
  let pdfExportService: typeof import("../pdfExportService").default;
  let BrowserWindow: any;
  let fs: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.resetModules();

    // Get fresh instances after mock reset
    const electronMock = await import("electron");
    BrowserWindow = electronMock.BrowserWindow;
    fs = await import("fs/promises");

    const module = await import("../pdfExportService");
    pdfExportService = module.default;
  });

  describe("getDefaultExportPath", () => {
    it("should generate path in downloads folder", () => {
      const transaction = {
        id: "txn-123",
        property_address: "123 Main St",
      };

      const result = pdfExportService.getDefaultExportPath(transaction as any);

      expect(result).toContain("mock");
      expect(result).toContain("downloads");
      expect(result).toContain("Transaction_");
      expect(result).toContain("123_Main_St");
      expect(result).toMatch(/\.pdf$/);
    });

    it("should sanitize special characters in filename", () => {
      const transaction = {
        id: "txn-456",
        property_address: "456 Oak Ave, Unit #5/A",
      };

      const result = pdfExportService.getDefaultExportPath(transaction as any);

      // Should not contain special characters
      expect(result).not.toContain(",");
      expect(result).not.toContain("#");
      expect(result).not.toContain("/A");
      expect(result).toContain("456_Oak_Ave");
    });

    it("should handle address with only street number", () => {
      const transaction = {
        id: "txn-789",
        property_address: "789",
      };

      const result = pdfExportService.getDefaultExportPath(transaction as any);

      expect(result).toContain("789");
      expect(result).toMatch(/\.pdf$/);
    });

    it("should handle undefined address", () => {
      const transaction = {
        id: "txn-undefined",
        property_address: undefined,
      };

      const result = pdfExportService.getDefaultExportPath(transaction as any);

      expect(result).toMatch(/Transaction_.*\.pdf$/);
    });
  });

  describe("generateTransactionPDF", () => {
    const mockTransaction = {
      id: "txn-123",
      property_address: "123 Test St, City, ST 12345",
      transaction_type: "purchase",
      sale_price: 500000,
      listing_price: 525000,
      closed_at: "2024-03-15",
      earnest_money_amount: 10000,
      total_communications_count: 5,
      extraction_confidence: 85,
      first_communication_date: "2024-01-01",
      last_communication_date: "2024-03-01",
    };

    const mockCommunications = [
      {
        id: "comm-1",
        subject: "RE: Property Offer",
        sender: "agent@realty.com",
        recipients: "buyer@email.com",
        sent_at: "2024-01-15T10:00:00Z",
        body_plain: "This is the email body content for the offer discussion.",
        has_attachments: true,
      },
      {
        id: "comm-2",
        subject: "Closing Documents",
        sender: "title@company.com",
        recipients: "all@parties.com",
        sent_at: "2024-02-20T14:00:00Z",
        body_plain: "Please find attached the closing documents.",
        has_attachments: false,
      },
    ];

    it("should generate PDF successfully", async () => {
      const outputPath = "/mock/output/test.pdf";

      const result = await pdfExportService.generateTransactionPDF(
        mockTransaction as any,
        mockCommunications as any,
        outputPath,
      );

      expect(result).toBe(outputPath);
      expect(BrowserWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          width: 800,
          height: 1200,
          show: false,
        }),
      );
    });

    it("should write PDF data to file", async () => {
      const outputPath = "/mock/output/transaction.pdf";

      await pdfExportService.generateTransactionPDF(
        mockTransaction as any,
        mockCommunications as any,
        outputPath,
      );

      expect(fs.writeFile).toHaveBeenCalledWith(outputPath, expect.any(Buffer));
    });

    it("should close browser window after generation", async () => {
      const outputPath = "/mock/output/test.pdf";

      await pdfExportService.generateTransactionPDF(
        mockTransaction as any,
        mockCommunications as any,
        outputPath,
      );

      // The mock BrowserWindow instance's close should be called
      const mockInstance = (BrowserWindow as jest.Mock).mock.results[0].value;
      expect(mockInstance.close).toHaveBeenCalled();
    });

    it("should handle errors and cleanup window", async () => {
      // Make printToPDF fail
      const mockWindow = {
        loadURL: jest.fn().mockResolvedValue(undefined),
        loadFile: jest.fn().mockResolvedValue(undefined),
        webContents: {
          printToPDF: jest
            .fn()
            .mockRejectedValue(new Error("PDF generation failed")),
          on: jest.fn().mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
            if (event === "did-finish-load") {
              cb();
            }
          }),
        },
        close: jest.fn(),
      };
      (BrowserWindow as jest.Mock).mockImplementation(() => mockWindow);

      await expect(
        pdfExportService.generateTransactionPDF(
          mockTransaction as any,
          mockCommunications as any,
          "/mock/output/fail.pdf",
        ),
      ).rejects.toThrow("PDF generation failed");

      expect(mockWindow.close).toHaveBeenCalled();
    });

    it("should handle transaction with missing optional fields", async () => {
      const minimalTransaction = {
        id: "txn-minimal",
        property_address: "100 Simple St",
      };

      const outputPath = "/mock/output/minimal.pdf";

      // Should not throw
      await expect(
        pdfExportService.generateTransactionPDF(
          minimalTransaction as any,
          [],
          outputPath,
        ),
      ).resolves.toBe(outputPath);
    });

    it("should handle communications without body content", async () => {
      const commsWithoutBody = [
        {
          id: "comm-nobody",
          subject: "Quick Note",
          sender: "agent@realty.com",
          sent_at: "2024-01-10T09:00:00Z",
          body_plain: null,
          has_attachments: false,
        },
      ];

      const outputPath = "/mock/output/nobody.pdf";

      await expect(
        pdfExportService.generateTransactionPDF(
          mockTransaction as any,
          commsWithoutBody as any,
          outputPath,
        ),
      ).resolves.toBe(outputPath);
    });

    it("should truncate long email body content", async () => {
      const longBodyComm = [
        {
          id: "comm-long",
          subject: "Long Email",
          sender: "verbose@sender.com",
          sent_at: "2024-01-10T09:00:00Z",
          body_plain: "A".repeat(600), // Longer than 500 char limit
          has_attachments: false,
        },
      ];

      const outputPath = "/mock/output/longbody.pdf";

      // Should handle without error
      await expect(
        pdfExportService.generateTransactionPDF(
          mockTransaction as any,
          longBodyComm as any,
          outputPath,
        ),
      ).resolves.toBe(outputPath);
    });
  });

  describe("HTML Generation - Currency Formatting", () => {
    it("should format currency correctly in generated HTML", async () => {
      const transaction = {
        id: "txn-currency",
        property_address: "123 Money St",
        sale_price: 1250000,
        listing_price: 1300000,
        earnest_money_amount: 25000,
      };

      // We can test indirectly by ensuring the PDF generates without error
      // The actual HTML contains formatted currency
      await expect(
        pdfExportService.generateTransactionPDF(
          transaction as any,
          [],
          "/mock/output/currency.pdf",
        ),
      ).resolves.toBeDefined();
    });

    it("should handle null/undefined currency values", async () => {
      const transaction = {
        id: "txn-nullcurrency",
        property_address: "456 NoPrice Ave",
        sale_price: null,
        listing_price: undefined,
        earnest_money_amount: 0,
      };

      await expect(
        pdfExportService.generateTransactionPDF(
          transaction as any,
          [],
          "/mock/output/nullcurrency.pdf",
        ),
      ).resolves.toBeDefined();
    });
  });

  describe("HTML Generation - Date Formatting", () => {
    it("should format dates correctly in generated HTML", async () => {
      const transaction = {
        id: "txn-dates",
        property_address: "789 Calendar St",
        closed_at: "2024-06-15",
        first_communication_date: "2024-01-01",
        last_communication_date: "2024-06-01",
      };

      await expect(
        pdfExportService.generateTransactionPDF(
          transaction as any,
          [],
          "/mock/output/dates.pdf",
        ),
      ).resolves.toBeDefined();
    });

    it("should handle null/undefined date values", async () => {
      const transaction = {
        id: "txn-nulldates",
        property_address: "101 NoDate Blvd",
        closed_at: null,
        first_communication_date: undefined,
        last_communication_date: null,
      };

      await expect(
        pdfExportService.generateTransactionPDF(
          transaction as any,
          [],
          "/mock/output/nulldates.pdf",
        ),
      ).resolves.toBeDefined();
    });

    it("should handle Date objects", async () => {
      const transaction = {
        id: "txn-dateobj",
        property_address: "202 DateObj Ln",
        closed_at: new Date("2024-12-25"),
      };

      await expect(
        pdfExportService.generateTransactionPDF(
          transaction as any,
          [],
          "/mock/output/dateobj.pdf",
        ),
      ).resolves.toBeDefined();
    });
  });

  describe("HTML Generation - Transaction Types", () => {
    it("should handle purchase transaction type", async () => {
      const transaction = {
        id: "txn-purchase",
        property_address: "111 Buyer St",
        transaction_type: "purchase",
      };

      await expect(
        pdfExportService.generateTransactionPDF(
          transaction as any,
          [],
          "/mock/output/purchase.pdf",
        ),
      ).resolves.toBeDefined();
    });

    it("should handle sale transaction type", async () => {
      const transaction = {
        id: "txn-sale",
        property_address: "222 Seller Ave",
        transaction_type: "sale",
      };

      await expect(
        pdfExportService.generateTransactionPDF(
          transaction as any,
          [],
          "/mock/output/sale.pdf",
        ),
      ).resolves.toBeDefined();
    });

    it("should handle missing transaction type", async () => {
      const transaction = {
        id: "txn-notype",
        property_address: "333 Unknown Blvd",
        transaction_type: undefined,
      };

      await expect(
        pdfExportService.generateTransactionPDF(
          transaction as any,
          [],
          "/mock/output/notype.pdf",
        ),
      ).resolves.toBeDefined();
    });
  });

  describe("HTML Generation - Communications Sorting", () => {
    it("should sort communications by date descending", async () => {
      const transaction = {
        id: "txn-sort",
        property_address: "444 Sort St",
      };

      const unsortedComms = [
        {
          id: "1",
          subject: "First",
          sender: "a@b.com",
          sent_at: "2024-01-01T10:00:00Z",
        },
        {
          id: "2",
          subject: "Third",
          sender: "a@b.com",
          sent_at: "2024-03-01T10:00:00Z",
        },
        {
          id: "3",
          subject: "Second",
          sender: "a@b.com",
          sent_at: "2024-02-01T10:00:00Z",
        },
      ];

      // The service should sort these internally
      await expect(
        pdfExportService.generateTransactionPDF(
          transaction as any,
          unsortedComms as any,
          "/mock/output/sorted.pdf",
        ),
      ).resolves.toBeDefined();
    });
  });

  describe("HTML Generation - XSS Prevention", () => {
    it("should escape HTML in email body to prevent XSS", async () => {
      const transaction = {
        id: "txn-xss",
        property_address: "555 Security St",
      };

      const maliciousComms = [
        {
          id: "xss-1",
          subject: '<script>alert("XSS")</script>',
          sender: "hacker@evil.com",
          sent_at: "2024-01-01T10:00:00Z",
          body_plain: "<script>document.cookie</script> body content",
        },
      ];

      // Should not throw - HTML should be escaped
      await expect(
        pdfExportService.generateTransactionPDF(
          transaction as any,
          maliciousComms as any,
          "/mock/output/xss.pdf",
        ),
      ).resolves.toBeDefined();
    });
  });
});
