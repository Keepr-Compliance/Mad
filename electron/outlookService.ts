import {
  PublicClientApplication,
  InteractionRequiredAuthError,
  AccountInfo,
} from "@azure/msal-node";
import { Client } from "@microsoft/microsoft-graph-client";
import "isomorphic-fetch";
import fs from "fs";
import path from "path";
import { app, BrowserWindow, shell } from "electron";
import logService from "./services/logService";

interface MsalConfig {
  auth: {
    clientId: string;
    authority: string;
  };
  cache: {
    cachePlugin: {
      beforeCacheAccess: (cacheContext: any) => Promise<void>;
      afterCacheAccess: (cacheContext: any) => Promise<void>;
    };
  };
  system: {
    loggerOptions: {
      loggerCallback: (loglevel: number, message: string) => void;
      piiLoggingEnabled: boolean;
      logLevel: number;
    };
  };
}

interface AuthenticateResult {
  success: boolean;
  account?: AccountInfo;
  userInfo?: {
    username: string;
    name: string | undefined;
  };
  error?: string;
}

interface EmailMessage {
  id: string;
  subject?: string;
  from?: {
    emailAddress?: {
      name?: string;
      address?: string;
    };
  };
  toRecipients?: Array<{
    emailAddress?: {
      name?: string;
      address?: string;
    };
  }>;
  ccRecipients?: Array<{
    emailAddress?: {
      name?: string;
      address?: string;
    };
  }>;
  receivedDateTime: string;
  body?: {
    content: string;
    contentType: string;
  };
  bodyPreview?: string;
  hasAttachments?: boolean;
  importance?: string;
}

class OutlookService {
  private msalInstance: PublicClientApplication | null;
  private graphClient: Client | null;
  private authWindow: BrowserWindow | null;
  private accessToken: string | null;
  private cacheLocation: string | null;

  constructor() {
    this.msalInstance = null;
    this.graphClient = null;
    this.authWindow = null;
    this.accessToken = null;
    this.cacheLocation = null;
  }

  /**
   * Initialize MSAL with configuration from environment variables
   * Includes persistent token caching so users don't have to re-authenticate every time
   */
  async initialize(
    clientId: string,
    tenantId: string = "common",
  ): Promise<void> {
    // Set up cache location in app's user data directory
    const userDataPath = app.getPath("userData");
    this.cacheLocation = path.join(userDataPath, "msal-cache.json");

    const msalConfig: MsalConfig = {
      auth: {
        clientId: clientId,
        authority: `https://login.microsoftonline.com/${tenantId}`,
      },
      cache: {
        cachePlugin: {
          beforeCacheAccess: async (cacheContext) => {
            // Read cache from disk
            if (fs.existsSync(this.cacheLocation!)) {
              const cacheData = fs.readFileSync(this.cacheLocation!, "utf8");
              cacheContext.tokenCache.deserialize(cacheData);
            }
          },
          afterCacheAccess: async (cacheContext) => {
            // Write cache to disk if it changed
            if (cacheContext.cacheHasChanged) {
              fs.writeFileSync(
                this.cacheLocation!,
                cacheContext.tokenCache.serialize(),
              );
            }
          },
        },
      },
      system: {
        loggerOptions: {
          loggerCallback(_loglevel: number, _message: string) {
            // Logging disabled for production
          },
          piiLoggingEnabled: false,
          logLevel: 3,
        },
      },
    };

    this.msalInstance = new PublicClientApplication(msalConfig);
  }

  /**
   * Authenticate user using device code flow (best for desktop apps)
   * Returns user account info on success
   */
  async authenticate(
    parentWindow: BrowserWindow | null,
  ): Promise<AuthenticateResult> {
    if (!this.msalInstance) {
      throw new Error(
        "OutlookService not initialized. Call initialize() first.",
      );
    }

    const scopes = ["User.Read", "Mail.Read"];

    try {
      // Try to get token silently from cache first
      const accounts = await this.msalInstance.getTokenCache().getAllAccounts();

      if (accounts.length > 0) {
        const silentRequest = {
          account: accounts[0],
          scopes: scopes,
        };

        try {
          const response =
            await this.msalInstance.acquireTokenSilent(silentRequest);
          this.accessToken = response.accessToken;
          this.initializeGraphClient();
          return { success: true, account: response.account ?? undefined };
        } catch (error) {
          if (error instanceof InteractionRequiredAuthError) {
            // Need interactive auth
          } else {
            throw error;
          }
        }
      }

      // Interactive authentication using device code flow
      const deviceCodeRequest = {
        scopes: scopes,
        deviceCodeCallback: (response: any) => {
          // Automatically open the browser for the user

          // Open browser automatically
          shell.openExternal(response.verificationUri).catch((err) => {
            logService.error("Failed to open browser:", "OutlookService", { error: err });
          });

          // Send to renderer if parentWindow is available
          if (parentWindow && !parentWindow.isDestroyed()) {
            parentWindow.webContents.send("device-code-received", {
              verificationUri: response.verificationUri,
              userCode: response.userCode,
              message: response.message,
            });
          }

          return response;
        },
      };

      const response =
        await this.msalInstance.acquireTokenByDeviceCode(deviceCodeRequest);
      this.accessToken = response?.accessToken ?? null;
      this.initializeGraphClient();

      return {
        success: true,
        account: response?.account ?? undefined,
        userInfo: {
          username: response?.account?.username ?? "",
          name: response?.account?.name ?? undefined,
        },
      };
    } catch (error) {
      logService.error("Authentication error:", "OutlookService", { error });
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Initialize Microsoft Graph client with access token
   */
  private initializeGraphClient(): void {
    this.graphClient = Client.init({
      authProvider: (done) => {
        done(null, this.accessToken);
      },
    });
  }

  /**
   * Get user's email address
   */
  async getUserEmail(): Promise<string> {
    if (!this.graphClient) {
      throw new Error("Not authenticated. Call authenticate() first.");
    }

    try {
      const user = await this.graphClient.api("/me").get();
      return user.mail || user.userPrincipalName;
    } catch (error) {
      logService.error("Error getting user email:", "OutlookService", { error });
      throw error;
    }
  }

  /**
   * Search for emails with a specific contact
   * @param {string} contactEmail - Email address to search for
   * @param {number} maxResults - Maximum number of emails to retrieve (default: 100)
   */
  async getEmailsWithContact(
    contactEmail: string,
    maxResults: number = 100,
  ): Promise<EmailMessage[]> {
    if (!this.graphClient) {
      throw new Error("Not authenticated. Call authenticate() first.");
    }

    const graphClient = this.graphClient; // Capture client for use in this method

    try {
      // Use Microsoft Graph API $search to filter on server-side
      // $search uses KQL (Keyword Query Language) and searches across from/to/cc/bcc
      const emailLower = contactEmail.toLowerCase();
      const matchingEmails: EmailMessage[] = [];

      // Helper function to add timeout to promises
      const withTimeout = <T>(
        promise: Promise<T>,
        timeoutMs: number = 60000,
      ): Promise<T> => {
        return Promise.race([
          promise,
          new Promise<T>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Request timeout after ${timeoutMs}ms`)),
              timeoutMs,
            ),
          ),
        ]);
      };

      // Try $search first (server-side filtering)
      // $search requires the query to be quoted and uses KQL syntax

      let emailsToFetch: EmailMessage[] = [];
      try {
        const response = await withTimeout(
          this.graphClient
            .api("/me/messages")
            .search(`"participants:${emailLower}"`)
            .select(
              "id,subject,from,toRecipients,ccRecipients,receivedDateTime,hasAttachments,importance",
            )
            // Note: Cannot use .orderby() with $search - results are relevance-ranked
            .top(maxResults)
            .get(),
          60000, // 60 second timeout
        );

        emailsToFetch = response.value || [];
      } catch {
        // Fallback: Fetch and filter in memory with early stopping
        let nextLink: string | null = null;
        let pageCount = 0;
        const maxPages = 20;

        let response = await withTimeout(
          this.graphClient
            .api("/me/messages")
            .select(
              "id,subject,from,toRecipients,ccRecipients,receivedDateTime,hasAttachments,importance",
            )
            .orderby("receivedDateTime DESC")
            .top(50)
            .get(),
          60000,
        );

        const matchingEmailIds: EmailMessage[] = [];
        let consecutivePagesWithNoMatches = 0;
        const maxConsecutivePagesWithNoMatches = 5;

        do {
          const emails: EmailMessage[] = response.value || [];

          const matching = emails.filter((email) => {
            const fromEmail = email.from?.emailAddress?.address?.toLowerCase();
            const toEmails = (email.toRecipients || []).map((r) =>
              r.emailAddress?.address?.toLowerCase(),
            );
            const ccEmails = (email.ccRecipients || []).map((r) =>
              r.emailAddress?.address?.toLowerCase(),
            );

            return (
              fromEmail === emailLower ||
              toEmails.includes(emailLower) ||
              ccEmails.includes(emailLower)
            );
          });

          matchingEmailIds.push(...matching);

          if (matching.length === 0) {
            consecutivePagesWithNoMatches++;
            if (
              consecutivePagesWithNoMatches >= maxConsecutivePagesWithNoMatches
            ) {
              break;
            }
          } else {
            consecutivePagesWithNoMatches = 0;
          }

          if (matchingEmailIds.length >= maxResults) {
            break;
          }

          nextLink = response["@odata.nextLink"];
          pageCount++;

          if (nextLink && pageCount < maxPages) {
            response = await withTimeout(
              graphClient.api(nextLink).get(),
              60000,
            );
          } else {
            break;
          }
        } while (true);

        emailsToFetch = matchingEmailIds.slice(0, maxResults);
      }

      // PHASE 2: Fetch full body content for matching emails only
      for (let i = 0; i < emailsToFetch.length; i++) {
        const email = emailsToFetch[i];
        try {
          // Fetch full email details including body
          const fullEmail = await withTimeout(
            graphClient
              .api(`/me/messages/${email.id}`)
              .select(
                "id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,bodyPreview,hasAttachments,importance",
              )
              .get(),
            30000, // 30 second timeout per email
          );

          // Merge the body into the email object
          matchingEmails.push(fullEmail);
        } catch (error) {
          logService.error(
            `[Email Fetch] Error fetching body for email ${email.id}:`,
            "OutlookService",
            { error: (error as Error).message },
          );
          // Still include the email but without body
          matchingEmails.push(email);
        }
      }

      return matchingEmails;
    } catch (error) {
      logService.error("[Email Fetch] Error fetching emails:", "OutlookService", { error });
      logService.error("[Email Fetch] Error details:", "OutlookService", {
        message: (error as Error).message,
        code: (error as any).code,
        statusCode: (error as any).statusCode,
        stack: (error as Error).stack,
      });
      throw error;
    }
  }

  /**
   * Check if user is authenticated
   */
  isAuthenticated(): boolean {
    return this.accessToken !== null && this.graphClient !== null;
  }

  /**
   * Sign out and clear cached tokens
   */
  async signOut(): Promise<void> {
    if (this.msalInstance) {
      const accounts = await this.msalInstance.getTokenCache().getAllAccounts();
      for (const account of accounts) {
        await this.msalInstance.getTokenCache().removeAccount(account);
      }
    }

    // Delete cache file from disk
    if (this.cacheLocation && fs.existsSync(this.cacheLocation)) {
      fs.unlinkSync(this.cacheLocation);
    }

    this.accessToken = null;
    this.graphClient = null;
  }
}

export default OutlookService;
